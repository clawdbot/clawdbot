import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { drainFormattedSystemEvents } from "../auto-reply/reply/session-system-events.js";
import { getReplySystemEventContext } from "../auto-reply/reply/system-event-session-key.js";
import { resolveSessionStorePathCore } from "../config/sessions.js";
import {
  listSessionEntriesReadOnly,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import { installHeartbeatRunnerTestRuntime } from "./heartbeat-runner.test-harness.js";
import {
  seedMainSessionStore,
  seedSessionStore,
  readSessionStoreForTest,
  withTempHeartbeatSandbox,
  type HeartbeatReplySpy,
} from "./heartbeat-runner.test-utils.js";
import { withSystemEventOwner } from "./system-event-ownership.js";
import {
  enqueueSystemEvent,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "./system-events.js";

installHeartbeatRunnerTestRuntime({ includeSlack: true });

function mockReplyWithSystemEvents(replySpy: HeartbeatReplySpy, cfg: OpenClawConfig) {
  const blocks: Array<string | undefined> = [];
  replySpy.mockImplementation(async (ctx, opts) => {
    const eventContext = getReplySystemEventContext(opts);
    const sessionKey = eventContext?.sessionKey ?? ctx.SessionKey;
    if (!ctx.AgentId || !sessionKey) {
      throw new Error("Expected heartbeat agent and session context");
    }
    blocks.push(
      await drainFormattedSystemEvents({
        cfg,
        agentId: ctx.AgentId,
        sessionKey,
        isMainSession: false,
        isNewSession: false,
        events: eventContext?.events ?? [],
      }),
    );
    return { text: "HEARTBEAT_OK" };
  });
  return blocks;
}

describe("runHeartbeatOnce identity", () => {
  afterEach(() => resetSystemEventsForTest());

  it.each([
    { isolatedSession: false, expectedSessionKey: "global" },
    { isolatedSession: true, expectedSessionKey: "agent:historian2:global:heartbeat" },
  ])(
    "keeps a secondary global heartbeat in its agent store (isolated=$isolatedSession)",
    async ({ isolatedSession, expectedSessionKey }) => {
      await withTempHeartbeatSandbox(async ({ tmpDir, replySpy }) => {
        const storeTemplate = path.join(tmpDir, "agents", "{agentId}", "sessions.json");
        const cfg: OpenClawConfig = {
          agents: {
            defaults: {
              workspace: tmpDir,
              heartbeat: { every: "5m", target: "last", isolatedSession },
            },
            entries: { main: { default: true }, historian2: {} },
          },
          session: { scope: "global", dmScope: "per-channel-peer", store: storeTemplate },
        };
        const mainStorePath = resolveSessionStorePathCore(storeTemplate, { agentId: "main" });
        const historianStorePath = resolveSessionStorePathCore(storeTemplate, {
          agentId: "historian2",
        });
        await seedSessionStore(mainStorePath, "global", {
          lastChannel: "slack",
          lastProvider: "slack",
          lastTo: "channel:MAIN",
        });
        const historianScope = { agentId: "historian2", storePath: historianStorePath };
        // Custom locators and the global key do not imply a database owner.
        await replaceSessionEntry(
          { ...historianScope, sessionKey: "global" },
          {
            sessionId: "historian-session",
            updatedAt: Date.now(),
            delivery: normalizeSessionDeliveryState({
              context: { channel: "slack", to: "channel:HISTORIAN" },
            }),
          },
        );
        const mainStoreBefore = readSessionStoreForTest(mainStorePath);
        replySpy.mockResolvedValue({ text: "needs attention" });
        const sendSlack = vi.fn().mockResolvedValue({ messageId: "m1", channelId: "HISTORIAN" });

        const result = await runHeartbeatOnce({
          cfg,
          agentId: "historian2",
          deps: {
            getReplyFromConfig: replySpy,
            slack: sendSlack,
            getQueueSize: () => 0,
          },
        });

        expect(result.status).toBe("ran");
        expect(replySpy).toHaveBeenCalledTimes(1);
        expect(replySpy.mock.calls[0]?.[0]).toMatchObject({
          AgentId: "historian2",
          SessionKey: expectedSessionKey,
        });
        expect(sendSlack).toHaveBeenCalledWith(
          "channel:HISTORIAN",
          "needs attention",
          expect.any(Object),
        );
        expect(readSessionStoreForTest(mainStorePath)).toEqual(mainStoreBefore);
        const historianStore = Object.fromEntries(
          listSessionEntriesReadOnly(historianScope).map(({ sessionKey, entry }) => [
            sessionKey,
            entry,
          ]),
        );
        expect(historianStore.global).toBeDefined();
        expect(historianStore["agent:historian2:global:heartbeat"] !== undefined).toBe(
          isolatedSession,
        );
      });
    },
  );

  it("runs a global hook wake for an agent without a heartbeat schedule", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, replySpy }) => {
      const storeTemplate = path.join(tmpDir, "agents", "{agentId}", "sessions.json");
      const cfg: OpenClawConfig = {
        agents: {
          defaults: { workspace: tmpDir },
          entries: { main: { default: true }, hooks: {} },
        },
        session: { scope: "global", store: storeTemplate },
      };
      const hooksStorePath = resolveSessionStorePathCore(storeTemplate, { agentId: "hooks" });
      await seedSessionStore(hooksStorePath, "global", {});
      enqueueSystemEvent("Mapped hook wake", { sessionKey: "global" });
      expect(peekSystemEventEntries("global").map((event) => event.text)).toEqual([
        "Mapped hook wake",
      ]);
      const systemEventBlocks = mockReplyWithSystemEvents(replySpy, cfg);

      const result = await runHeartbeatOnce({
        cfg,
        agentId: "hooks",
        source: "hook",
        intent: "immediate",
        reason: "hook:wake",
        deps: {
          getReplyFromConfig: replySpy,
          getQueueSize: () => 0,
        },
      });

      expect(result.status).toBe("ran");
      expect(replySpy).toHaveBeenCalledTimes(1);
      expect(replySpy.mock.calls[0]?.[0]).toMatchObject({
        AgentId: "hooks",
        SessionKey: "global",
      });
      expect(systemEventBlocks).toHaveLength(1);
      expect(systemEventBlocks[0]).toContain("Mapped hook wake");
      expect(peekSystemEventEntries("global")).toEqual([]);
    });
  });

  it("keeps a global hook event owned by another agent queued for its owner", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, replySpy }) => {
      const storeTemplate = path.join(tmpDir, "agents", "{agentId}", "sessions.json");
      const cfg: OpenClawConfig = {
        agents: {
          defaults: { workspace: tmpDir },
          entries: { main: { default: true }, alpha: {}, beta: {} },
        },
        session: { scope: "global", store: storeTemplate },
      };
      await seedSessionStore(
        resolveSessionStorePathCore(storeTemplate, { agentId: "alpha" }),
        "global",
        {},
      );
      await seedSessionStore(
        resolveSessionStorePathCore(storeTemplate, { agentId: "beta" }),
        "global",
        {},
      );
      // Two hook agents complete before the coalesced wakes fire; both events
      // land in the shared `global` queue with per-agent ownership.
      enqueueSystemEvent(
        "Hook Alpha: done",
        withSystemEventOwner({ sessionKey: "global" }, "alpha"),
      );
      enqueueSystemEvent("Hook Beta: done", withSystemEventOwner({ sessionKey: "global" }, "beta"));
      const systemEventBlocks = mockReplyWithSystemEvents(replySpy, cfg);

      const alphaResult = await runHeartbeatOnce({
        cfg,
        agentId: "alpha",
        source: "hook",
        intent: "immediate",
        reason: "hook:wake",
        deps: {
          getReplyFromConfig: replySpy,
          getQueueSize: () => 0,
        },
      });

      expect(alphaResult.status).toBe("ran");
      expect(replySpy).toHaveBeenCalledTimes(1);
      expect(replySpy.mock.calls[0]?.[0]).toMatchObject({
        AgentId: "alpha",
        SessionKey: "global",
      });
      // The first targeted wake must not drain the other agent's queued event.
      expect(systemEventBlocks[0]).toContain("Hook Alpha: done");
      expect(systemEventBlocks[0]).not.toContain("Hook Beta: done");
      expect(peekSystemEventEntries("global").map((event) => event.text)).toEqual([
        "Hook Beta: done",
      ]);

      const betaResult = await runHeartbeatOnce({
        cfg,
        agentId: "beta",
        source: "hook",
        intent: "immediate",
        reason: "hook:wake",
        deps: {
          getReplyFromConfig: replySpy,
          getQueueSize: () => 0,
        },
      });

      expect(betaResult.status).toBe("ran");
      expect(replySpy).toHaveBeenCalledTimes(2);
      expect(systemEventBlocks[1]).toContain("Hook Beta: done");
      expect(systemEventBlocks[1]).not.toContain("Hook Alpha: done");
      expect(peekSystemEventEntries("global")).toEqual([]);
    });
  });

  it.each([
    { name: "alert", replyText: "needs attention", showOk: false },
    { name: "heartbeat ok", replyText: "HEARTBEAT_OK", showOk: true },
  ])("forwards agent identity on $name delivery", async ({ replyText, showOk }) => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: { every: "5m", target: "slack", to: "channel:C123" },
          },
          entries: { main: { identity: { name: "Pulse", emoji: "📟" } } },
        },
        channels: { slack: { heartbeatVisibility: { showOk } } },
        session: { store: storePath },
      };
      await seedMainSessionStore(storePath, cfg, {
        lastChannel: "slack",
        lastProvider: "slack",
        lastTo: "channel:C123",
      });
      replySpy.mockResolvedValue({ text: replyText });
      const sendSlack = vi.fn().mockResolvedValue({ messageId: "m1", channelId: "C123" });

      await runHeartbeatOnce({
        cfg,
        deps: {
          getReplyFromConfig: replySpy,
          slack: sendSlack,
          getQueueSize: () => 0,
          nowMs: () => 0,
        },
      });

      expect(replySpy.mock.calls[0]?.[0]).toMatchObject({ AgentId: "main" });
      expect(sendSlack).toHaveBeenCalledTimes(1);
      expect(sendSlack.mock.calls[0]?.[2]).toMatchObject({
        identity: { name: "Pulse", emoji: "📟" },
      });
    });
  });
});
