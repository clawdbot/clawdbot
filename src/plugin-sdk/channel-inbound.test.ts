/**
 * Tests channel inbound context and dispatch helper behavior.
 */
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  configureChannelAdmissionEvidenceCollection,
  readChannelContextAdmissionEvidence,
} from "../channels/message-access/admission-evidence.js";
import { recordInboundSession } from "../channels/session.js";
import { loadSessionEntry, replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  buildChannelInboundEventContext,
  buildChannelTurnContext,
  type BuildChannelInboundEventContextParams,
  type PluginHookChannelSenderContext,
} from "./channel-inbound.js";
import * as channelIngressRuntime from "./channel-ingress-runtime.js";

declare module "./channel-inbound.js" {
  interface PluginHookChannelSenderContext {
    testUnionId?: string;
  }
}

function createInboundParams(
  overrides: Partial<BuildChannelInboundEventContextParams> = {},
): BuildChannelInboundEventContextParams {
  return {
    channel: "test",
    messageId: "msg-1",
    from: "test:user:u1",
    sender: { id: "u1" },
    conversation: {
      kind: "group",
      id: "room-1",
    },
    route: {
      agentId: "main",
      routeSessionKey: "agent:main:test:group:room-1",
    },
    reply: {
      to: "test:room:room-1",
    },
    message: {
      rawBody: "side chatter",
      inboundEventKind: "room_event",
    },
    ...overrides,
  };
}

describe("channel-inbound public helpers", () => {
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(() => {
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      cleanup();
    }),
  );

  it("runs a lifecycle-less prepared turn through the published entry point", async () => {
    const events: string[] = [];
    const { runChannelInboundEvent } = await import("openclaw/plugin-sdk/channel-inbound");
    const result = await runChannelInboundEvent({
      channel: "test",
      raw: { id: "msg-1", text: "hello" },
      adapter: {
        ingest: () => ({ id: "msg-1", rawText: "hello" }),
        resolveTurn: () => {
          const turn = {
            channel: "test",
            routeSessionKey: "agent:main:test:peer",
            storePath: "unused",
            ctxPayload: {
              Body: "hello",
              CommandAuthorized: false,
              SessionKey: "agent:main:test:peer",
            },
            recordInboundSession: async () => {
              events.push("record");
            },
            runDispatch: async () => {
              events.push("dispatch");
              return {
                queuedFinal: true,
                counts: { tool: 0, block: 0, final: 1 },
              };
            },
            runDispatchLifecycle: {
              turnAdoptionLifecycle: undefined,
              onDispatchSkipped: vi.fn(),
            },
          };
          // Model a plugin compiled before the required inbound lifecycle field existed.
          Object.defineProperty(turn, "runDispatchLifecycle", { value: undefined });
          return turn;
        },
      },
    });

    expect(events).toEqual(["record", "dispatch"]);
    expect(result.dispatched).toBe(true);
  });

  it("dispatches a published inbound event before automatic session maintenance", async () => {
    const storePath = `${tempDirs.make("openclaw-channel-inbound-maintenance-")}/sessions.json`;
    const staleSessionKey = "agent:main:published-inbound-stale";
    const activeSessionKey = "agent:main:test:peer";
    replaceSessionEntrySync(
      { storePath, sessionKey: staleSessionKey },
      { sessionId: "published-inbound-stale", updatedAt: 1 },
    );
    let staleEntryPresentAtDispatch = false;
    const { runChannelInboundEvent } = await import("openclaw/plugin-sdk/channel-inbound");

    const result = await runChannelInboundEvent({
      channel: "test",
      raw: { id: "msg-1", text: "hello" },
      adapter: {
        ingest: () => ({ id: "msg-1", rawText: "hello" }),
        resolveTurn: () => ({
          channel: "test",
          routeSessionKey: activeSessionKey,
          storePath,
          ctxPayload: {
            Body: "hello",
            CommandAuthorized: false,
            RawBody: "hello",
            CommandBody: "hello",
            From: "test:user:peer",
            To: "test:bot",
            SessionKey: activeSessionKey,
            Provider: "test",
            Surface: "test",
          },
          recordInboundSession,
          record: {
            updateLastRoute: {
              accountId: "default",
              channel: "test",
              sessionKey: activeSessionKey,
              to: "user:peer",
            },
            onRecordError: (error: unknown) => {
              throw error;
            },
          },
          runDispatch: async () => {
            staleEntryPresentAtDispatch = Boolean(
              loadSessionEntry({ storePath, sessionKey: staleSessionKey }),
            );
            return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
          },
          runDispatchLifecycle: {
            turnAdoptionLifecycle: undefined,
            onDispatchSkipped: vi.fn(),
          },
        }),
      },
    });

    expect(result.dispatched).toBe(true);
    expect(staleEntryPresentAtDispatch).toBe(true);
    await vi.waitFor(() => {
      expect(loadSessionEntry({ storePath, sessionKey: staleSessionKey })).toBeUndefined();
    });
  });

  it("builds inbound event kind into message context", async () => {
    const ctx = buildChannelInboundEventContext(createInboundParams());

    expect(ctx.InboundEventKind).toBe("room_event");
  });

  it("accepts plugin-augmented hook channel sender fields", () => {
    expectTypeOf<PluginHookChannelSenderContext["testUnionId"]>().toEqualTypeOf<
      string | undefined
    >();
    const sender = {
      id: "u1",
      testUnionId: "union-1",
    } satisfies PluginHookChannelSenderContext;
    expect(sender.testUnionId).toBe("union-1");
    const channelContext = {
      sender: {
        id: "u1",
        testUnionId: "union-1",
      },
    } satisfies NonNullable<BuildChannelInboundEventContextParams["channelContext"]>;
    const ctx = buildChannelInboundEventContext(
      createInboundParams({
        channelContext,
      }),
    );

    expect(ctx.ChannelContext?.sender?.testUnionId).toBe("union-1");
  });

  it("does not expose public participant evidence authority", () => {
    expect(channelIngressRuntime).not.toHaveProperty("createChannelParticipantAdmissionEvidence");
    expect(channelIngressRuntime).not.toHaveProperty("copyChannelParticipantAdmissionEvidence");
  });

  it("keeps public resolver and builder paths non-authoritative", async () => {
    const cleanup = configureChannelAdmissionEvidenceCollection(true);
    try {
      const channelIngress = await channelIngressRuntime.resolveStableChannelMessageIngress({
        channelId: "test",
        accountId: "default",
        subject: { stableId: "u1" },
        conversation: { kind: "group", id: "room-1" },
        dmPolicy: "open",
        groupPolicy: "open",
      });
      const ctx = buildChannelTurnContext({
        ...createInboundParams({ channelIngress }),
        message: {
          rawBody: "hello",
          inboundTurnKind: "user_request",
        },
      });

      expect(ctx.InboundTurnKind).toBe("user_request");
      expect(readChannelContextAdmissionEvidence(ctx)).toBeUndefined();
    } finally {
      cleanup();
    }
  });
});
