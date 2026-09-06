import path from "node:path";
import { buildAgentSessionKey } from "openclaw/plugin-sdk/routing";
import { afterEach, describe, expect, it } from "vitest";
import { startQaBusServer } from "./bus-server.js";
import { createQaBusState } from "./bus-state.js";
import { createQaGatewayChild } from "./gateway-child.js";
import { QA_REPEATED_REQUEST_QUEUED_REPLY_MARKER } from "./providers/mock-openai/mock-openai-contracts.js";
import { startQaMockOpenAiServer } from "./providers/mock-openai/server.js";
import { createQaChannelTransport } from "./qa-channel-transport.js";
import { readRawQaSessionStore } from "./suite-runtime-agent-session.js";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const FIRST_REPLY_MARKER = "QA-QUEUED-FOLLOWUP-FIRST-OK";
const TOOL_AUTHORITY_SNAPSHOT_ERROR = "Reply operation has no active tool authority snapshot";

describe.skipIf(process.platform === "win32")("queued follow-up after an active reply run", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    const errors: unknown[] = [];
    for (const cleanup of cleanups.splice(0).toReversed()) {
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) {
      throw new AggregateError(errors, "queued follow-up test cleanup failed");
    }
  });

  it("runs a message sent mid-turn as its own turn and delivers its reply", async () => {
    const state = createQaBusState();
    const transport = createQaChannelTransport(state);
    const bus = await startQaBusServer({ state });
    cleanups.push(() => bus.stop());
    const mock = await startQaMockOpenAiServer();
    cleanups.push(() => mock.stop());
    const owner = createQaGatewayChild();
    cleanups.push(async () => {
      expect((await owner.stop()).errors).toEqual([]);
    });
    const gateway = await owner.start({
      repoRoot,
      providerBaseUrl: `${mock.baseUrl}/v1`,
      providerMode: "mock-openai",
      forcedRuntime: "openclaw",
      transport,
      transportBaseUrl: bus.baseUrl,
      controlUiEnabled: false,
      // Debug logging makes the queued-admission overlap ("sessionState=processing")
      // observable in the child gateway log for this regression.
      runtimeEnvPatch: { OPENCLAW_LOG_LEVEL: "debug" },
      mutateConfig: (cfg) => ({
        ...cfg,
        plugins: {
          ...cfg.plugins,
          slots: { ...cfg.plugins?.slots, memory: "none" },
          entries: {
            ...cfg.plugins?.entries,
            acpx: { enabled: false },
            "memory-core": { enabled: false },
          },
        },
        // The reported loss is on the queued-followup path, so do not steer.
        messages: { ...cfg.messages, queue: { ...cfg.messages?.queue, mode: "followup" } },
      }),
    });
    const conversation = { id: "queued-followup-send", kind: "direct" as const };
    const sessionKey = buildAgentSessionKey({
      agentId: "qa",
      channel: "qa-channel",
      accountId: transport.accountId,
      peer: { kind: "direct", id: `dm:${conversation.id}` },
      dmScope: gateway.cfg.session?.dmScope,
      identityLinks: gateway.cfg.session?.identityLinks,
    });
    try {
      await transport.waitReady({ gateway });
      const sinceIndex = state.getSnapshot().messages.length;
      const first = await transport.sendInbound({
        accountId: transport.accountId,
        conversation,
        senderId: conversation.id,
        // The mock holds this turn's response so the second message is admitted
        // as a queued follow-up while this reply run is still active.
        text: `queued followup stall gateway qa check. Reply exactly: ${FIRST_REPLY_MARKER}`,
      });
      // Wait until the first turn's reply run has actually started (INFO log),
      // not merely enqueued, so the second message is a genuine mid-run arrival.
      await transport.waitForCondition(
        () => (gateway.logs().includes("embedded run start: runId=") ? true : undefined),
        60_000,
        25,
      );
      // The first turn's response is held by the mock, so its reply is not
      // delivered yet when the second message arrives. (The inbound message
      // text itself carries the marker, so scan outbound messages only.)
      expect(
        state
          .getSnapshot()
          .messages.some(
            (message) =>
              message.direction === "outbound" && message.text.includes(FIRST_REPLY_MARKER),
          ),
      ).toBe(false);
      const second = await transport.sendInbound({
        accountId: transport.accountId,
        conversation,
        senderId: conversation.id,
        text: "repeated request queued reply gateway qa check",
      });

      const firstReply = await transport.waitForOutbound({
        conversation,
        sinceIndex,
        textIncludes: FIRST_REPLY_MARKER,
        timeoutMs: 120_000,
      });
      expect(firstReply.replyToId).toBe(first.id);
      const queuedReply = await transport.waitForOutbound({
        conversation,
        sinceIndex,
        textIncludes: QA_REPEATED_REQUEST_QUEUED_REPLY_MARKER,
        timeoutMs: 120_000,
      });
      // The queued message runs as its own turn after the first finishes and its
      // reply is delivered. (On CLI backends the pre-fix queued run threw at route
      // binding and dropped the message; that boundary is covered RED/GREEN by
      // followup-turn-admission.queued-handoff.test.ts.)
      expect(queuedReply.replyToId).toBe(second.id);
      expect(queuedReply.accountId).toBe(transport.accountId);

      const snapshot = state.getSnapshot().messages;
      const findTimestamp = (id: string) =>
        snapshot.find((message) => message.id === id)?.timestamp ?? Number.NaN;
      // Overlap: the second message was received before the first turn's reply
      // was delivered, i.e. while the first run was still active.
      expect(findTimestamp(second.id)).toBeLessThan(findTimestamp(firstReply.id));
      // Ordering: the queued turn ran and replied after the first turn finished.
      const outbound = snapshot
        .slice(sinceIndex)
        .filter((message) => message.direction === "outbound");
      expect(outbound.findIndex((message) => message.id === firstReply.id)).toBeLessThan(
        outbound.findIndex((message) => message.id === queuedReply.id),
      );
      expect(gateway.logs()).not.toContain(TOOL_AUTHORITY_SNAPSHOT_ERROR);
      await transport.waitForCondition(
        async () =>
          (await readRawQaSessionStore({ gateway }))[sessionKey]?.status === "done"
            ? true
            : undefined,
        30_000,
        25,
      );
    } catch (error) {
      const sessions = await Promise.allSettled([readRawQaSessionStore({ gateway })]);
      throw new Error(
        `${String(error)}\nsessions=${JSON.stringify(sessions)}\nbus=${JSON.stringify(state.getSnapshot())}\ngateway=${gateway.logs()}`,
        { cause: error },
      );
    }
  }, 600_000);
});
