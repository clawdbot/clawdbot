import fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveMainSessionKey } from "../config/sessions.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import { installHeartbeatRunnerTestRuntime } from "./heartbeat-runner.test-harness.js";
import { withTempHeartbeatSandbox } from "./heartbeat-runner.test-utils.js";
import {
  enqueueSystemEvent,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "./system-events.js";

installHeartbeatRunnerTestRuntime();

afterEach(() => {
  resetSystemEventsForTest();
});

function requireFirstMockCall<T>(mock: { mock: { calls: T[][] } }, label: string): T[] {
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  return call;
}

describe("runHeartbeatOnce", () => {
  it("falls back to the main session when a subagent session key is forced", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: {
              every: "5m",
              target: "whatsapp",
            },
          },
        },
        channels: {
          whatsapp: {
            allowFrom: ["*"],
          },
        },
        session: { store: storePath },
      };

      const mainSessionKey = resolveMainSessionKey(cfg);
      await fs.writeFile(
        storePath,
        JSON.stringify({
          [mainSessionKey]: {
            sessionId: "sid-main",
            updatedAt: Date.now(),
            lastChannel: "whatsapp",
            lastProvider: "whatsapp",
            lastTo: "120363401234567890@g.us",
          },
          "agent:main:subagent:demo": {
            sessionId: "sid-subagent",
            updatedAt: Date.now(),
            lastChannel: "whatsapp",
            lastProvider: "whatsapp",
            lastTo: "120363409999999999@g.us",
          },
        }),
      );

      replySpy.mockResolvedValue({ text: "Final alert" });
      const sendWhatsApp = vi.fn().mockResolvedValue({
        messageId: "m1",
        toJid: "jid",
      });

      await runHeartbeatOnce({
        cfg,
        sessionKey: "agent:main:subagent:demo",
        deps: {
          getReplyFromConfig: replySpy,
          whatsapp: sendWhatsApp,
          getQueueSize: () => 0,
          nowMs: () => 0,
        },
      });

      expect(replySpy).toHaveBeenCalledTimes(1);
      const [replyParams, _replyRuntime, replyConfig] = requireFirstMockCall(
        replySpy,
        "reply",
      ) as Parameters<typeof replySpy>;
      expect(replyParams?.SessionKey).toBe(mainSessionKey);
      expect(replyParams?.OriginatingChannel).toBeUndefined();
      expect(replyParams?.OriginatingTo).toBeUndefined();
      expect(replyConfig).toBe(cfg);
    });
  });

  it("routes single-owner dmScope=main direct event wakes to the main session", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: {
              every: "5m",
              target: "telegram",
            },
          },
        },
        channels: {
          telegram: {
            allowFrom: ["123"],
          },
        },
        session: { store: storePath, dmScope: "main" },
      };

      const mainSessionKey = resolveMainSessionKey(cfg);
      await fs.writeFile(
        storePath,
        JSON.stringify({
          [mainSessionKey]: {
            sessionId: "sid-main",
            updatedAt: Date.now(),
            lastChannel: "telegram",
            lastProvider: "telegram",
            lastTo: "123",
          },
          "agent:main:telegram:default:direct:123": {
            sessionId: "sid-orphan",
            updatedAt: Date.now(),
            lastChannel: "telegram",
            lastProvider: "telegram",
            lastTo: "456",
          },
        }),
      );
      enqueueSystemEvent("Exec completed (run-dm, code 0)", {
        sessionKey: mainSessionKey,
      });
      replySpy.mockResolvedValue({ text: "NO_REPLY" });

      await runHeartbeatOnce({
        cfg,
        sessionKey: "agent:main:telegram:default:direct:123",
        source: "exec-event",
        deps: {
          getReplyFromConfig: replySpy,
          telegram: vi.fn().mockResolvedValue({ messageId: "m1", chatId: "123" }),
          getQueueSize: () => 0,
          nowMs: () => 0,
        },
      });

      expect(replySpy).toHaveBeenCalledTimes(1);
      const [replyParams] = requireFirstMockCall(replySpy, "reply") as Parameters<typeof replySpy>;
      expect(replyParams?.SessionKey).toBe(mainSessionKey);
      expect(replyParams?.Body).toContain("async command completion event");
      expect(peekSystemEventEntries(mainSessionKey)).toStrictEqual([]);
    });
  });
});
