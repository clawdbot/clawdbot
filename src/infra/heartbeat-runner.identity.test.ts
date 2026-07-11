import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveStorePath } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import { installHeartbeatRunnerTestRuntime } from "./heartbeat-runner.test-harness.js";
import {
  seedMainSessionStore,
  seedSessionStore,
  readSessionStoreForTest,
  withTempHeartbeatSandbox,
} from "./heartbeat-runner.test-utils.js";

installHeartbeatRunnerTestRuntime({ includeSlack: true });

describe("runHeartbeatOnce identity", () => {
  it.each([
    { isolatedSession: false, expectedSessionKey: "global" },
    { isolatedSession: true, expectedSessionKey: "global:heartbeat" },
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
            list: [{ id: "main", default: true }, { id: "historian2" }],
          },
          session: { scope: "global", dmScope: "per-channel-peer", store: storeTemplate },
        };
        const mainStorePath = resolveStorePath(storeTemplate, { agentId: "main" });
        const historianStorePath = resolveStorePath(storeTemplate, { agentId: "historian2" });
        await seedSessionStore(mainStorePath, "global", {
          lastChannel: "slack",
          lastProvider: "slack",
          lastTo: "channel:MAIN",
        });
        await seedSessionStore(historianStorePath, "global", {
          lastChannel: "slack",
          lastProvider: "slack",
          lastTo: "channel:HISTORIAN",
        });
        const mainStoreBefore = readSessionStoreForTest(mainStorePath);
        replySpy.mockResolvedValue({ text: "needs attention" });
        const sendSlack = vi.fn().mockResolvedValue({ messageId: "m1", channelId: "HISTORIAN" });

        await runHeartbeatOnce({
          cfg,
          agentId: "historian2",
          deps: {
            getReplyFromConfig: replySpy,
            slack: sendSlack,
            getQueueSize: () => 0,
          },
        });

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
        const historianStore = readSessionStoreForTest(historianStorePath);
        expect(historianStore.global).toBeDefined();
        expect(historianStore["global:heartbeat"] !== undefined).toBe(isolatedSession);
      });
    },
  );

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
          list: [{ id: "main", identity: { name: "Pulse", emoji: "📟" } }],
        },
        channels: { slack: { heartbeat: { showOk } } },
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
