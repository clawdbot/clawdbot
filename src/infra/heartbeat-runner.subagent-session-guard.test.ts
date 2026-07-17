// Tests heartbeat runner guardrails for subagent sessions.
import fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveMainSessionKey } from "../config/sessions.js";
import { resolveAgentMainSessionKey } from "../config/sessions/main-session.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import { installHeartbeatRunnerTestRuntime } from "./heartbeat-runner.test-harness.js";
import { withTempHeartbeatSandbox } from "./heartbeat-runner.test-utils.js";
import { markTrustedContinuationHeartbeatWake } from "./heartbeat-wake.js";
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

  it("routes trusted continuation wakes to same-agent subagent sessions", async () => {
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
      const subagentSessionKey = "agent:main:subagent:demo";
      await fs.writeFile(
        storePath,
        JSON.stringify({
          [mainSessionKey]: {
            sessionId: "sid-main",
            updatedAt: Date.now(),
            lastChannel: "whatsapp",
            lastProvider: "whatsapp",
            lastTo: "fixture-main-heartbeat-target",
          },
          [subagentSessionKey]: {
            sessionId: "sid-subagent",
            updatedAt: Date.now(),
            lastChannel: "whatsapp",
            lastProvider: "whatsapp",
            lastTo: "fixture-subagent-heartbeat-target",
          },
        }),
      );

      replySpy.mockResolvedValue({ text: "Final alert" });
      const sendWhatsApp = vi.fn().mockResolvedValue({
        messageId: "m1",
        toJid: "jid",
      });

      await runHeartbeatOnce(
        markTrustedContinuationHeartbeatWake({
          cfg,
          sessionKey: subagentSessionKey,
          reason: "delegate-return",
          deps: {
            getReplyFromConfig: replySpy,
            whatsapp: sendWhatsApp,
            getQueueSize: () => 0,
            nowMs: () => 0,
          },
        }),
      );

      expect(replySpy).toHaveBeenCalledTimes(1);
      const [replyParams] = requireFirstMockCall(replySpy, "reply") as Parameters<typeof replySpy>;
      expect(replyParams?.SessionKey).toBe(subagentSessionKey);
    });
  });

  it("rejects trusted continuation routing for unscoped legacy subagent keys", async () => {
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
      const legacySubagentSessionKey = "subagent:legacy";
      await fs.writeFile(
        storePath,
        JSON.stringify({
          [mainSessionKey]: {
            sessionId: "sid-main",
            updatedAt: Date.now(),
            lastChannel: "whatsapp",
            lastProvider: "whatsapp",
            lastTo: "fixture-main-heartbeat-target",
          },
          [legacySubagentSessionKey]: {
            sessionId: "sid-legacy-subagent",
            updatedAt: Date.now() + 10_000,
            lastChannel: "whatsapp",
            lastProvider: "whatsapp",
            lastTo: "fixture-legacy-subagent-target",
          },
        }),
      );

      replySpy.mockResolvedValue({ text: "NO_REPLY" });
      await runHeartbeatOnce(
        markTrustedContinuationHeartbeatWake({
          cfg,
          sessionKey: legacySubagentSessionKey,
          reason: "delegate-return",
          deps: {
            getReplyFromConfig: replySpy,
            whatsapp: vi.fn().mockResolvedValue({ messageId: "m1", toJid: "jid" }),
            getQueueSize: () => 0,
            nowMs: () => 0,
          },
        }),
      );

      expect(replySpy).toHaveBeenCalledTimes(1);
      const [replyParams] = requireFirstMockCall(replySpy, "reply") as Parameters<typeof replySpy>;
      expect(replyParams?.SessionKey).toBe(mainSessionKey);
    });
  });

  it("keeps trusted continuation routing constrained to the resolved agent", async () => {
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
          list: [{ id: "main" }, { id: "ops" }],
        },
        channels: {
          whatsapp: {
            allowFrom: ["*"],
          },
        },
        session: { store: storePath },
      };

      const opsMainSessionKey = resolveAgentMainSessionKey({ cfg, agentId: "ops" });
      await fs.writeFile(
        storePath,
        JSON.stringify({
          [resolveMainSessionKey(cfg)]: {
            sessionId: "sid-main",
            updatedAt: Date.now(),
            lastChannel: "whatsapp",
            lastProvider: "whatsapp",
            lastTo: "fixture-main-heartbeat-target",
          },
          [opsMainSessionKey]: {
            sessionId: "sid-ops",
            updatedAt: Date.now(),
            lastChannel: "whatsapp",
            lastProvider: "whatsapp",
            lastTo: "fixture-ops-heartbeat-target",
          },
          "agent:main:subagent:demo": {
            sessionId: "sid-main-subagent",
            updatedAt: Date.now() + 10_000,
            lastChannel: "whatsapp",
            lastProvider: "whatsapp",
            lastTo: "fixture-main-subagent-target",
          },
        }),
      );
      enqueueSystemEvent("main-only queue event", {
        sessionKey: "agent:main:subagent:demo",
        trusted: true,
      });
      enqueueSystemEvent("ops queue event", {
        sessionKey: opsMainSessionKey,
        trusted: true,
      });
      replySpy.mockResolvedValue({ text: "NO_REPLY" });

      await runHeartbeatOnce(
        markTrustedContinuationHeartbeatWake({
          cfg,
          agentId: "ops",
          sessionKey: "agent:main:subagent:demo",
          reason: "delegate-return",
          deps: {
            getReplyFromConfig: replySpy,
            whatsapp: vi.fn().mockResolvedValue({ messageId: "m1", toJid: "jid" }),
            getQueueSize: () => 0,
            nowMs: () => 0,
          },
        }),
      );

      expect(replySpy).toHaveBeenCalledTimes(1);
      const [replyParams] = requireFirstMockCall(replySpy, "reply") as Parameters<typeof replySpy>;
      expect(replyParams?.SessionKey).toBe(opsMainSessionKey);
      expect(peekSystemEventEntries("agent:main:subagent:demo")).toHaveLength(1);
      expect(peekSystemEventEntries(opsMainSessionKey)).toStrictEqual([]);
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
