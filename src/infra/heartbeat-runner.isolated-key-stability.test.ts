import fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as replyModule from "../auto-reply/reply.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveMainSessionKey } from "../config/sessions.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import { seedSessionStore, withTempHeartbeatSandbox } from "./heartbeat-runner.test-utils.js";
import {
  enqueueSystemEvent,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "./system-events.js";

vi.mock("./outbound/deliver.js", () => ({
  deliverOutboundPayloads: vi.fn().mockResolvedValue([]),
  deliverOutboundPayloadsInternal: vi.fn().mockResolvedValue([]),
}));

afterEach(() => {
  vi.restoreAllMocks();
  resetSystemEventsForTest();
});

describe("runHeartbeatOnce – isolated session key stability (#59493)", () => {
  /**
   * Simulates the wake-request feedback loop:
   *   1. Normal heartbeat tick produces sessionKey "agent:main:main:heartbeat"
   *   2. An exec/subagent event during that tick calls requestHeartbeat()
   *      with the already-suffixed key "agent:main:main:heartbeat"
   *   3. The wake handler passes that key back into runHeartbeatOnce(sessionKey: ...)
   *
   * Before the fix, step 3 would append another ":heartbeat" producing
   * "agent:main:main:heartbeat:heartbeat". After the fix, the key remains
   * stable at "agent:main:main:heartbeat".
   */
  async function runIsolatedHeartbeat(params: {
    tmpDir: string;
    storePath: string;
    cfg: OpenClawConfig;
    sessionKey: string;
  }) {
    await seedSessionStore(params.storePath, params.sessionKey, {
      lastChannel: "whatsapp",
      lastProvider: "whatsapp",
      lastTo: "+1555",
    });

    const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
    replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });

    await runHeartbeatOnce({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
      deps: {
        getQueueSize: () => 0,
        nowMs: () => Date.now(),
      },
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    return replySpy.mock.calls[0]?.[0];
  }

  function makeIsolatedHeartbeatConfig(tmpDir: string, storePath: string): OpenClawConfig {
    return {
      agents: {
        defaults: {
          workspace: tmpDir,
          heartbeat: {
            every: "5m",
            target: "whatsapp",
            isolatedSession: true,
          },
        },
      },
      channels: { whatsapp: { allowFrom: ["*"] } },
      session: { store: storePath },
    };
  }

  function makeNamedIsolatedHeartbeatConfig(
    tmpDir: string,
    storePath: string,
    heartbeatSession: string,
  ): OpenClawConfig {
    return {
      agents: {
        defaults: {
          workspace: tmpDir,
          heartbeat: {
            every: "5m",
            target: "whatsapp",
            isolatedSession: true,
            session: heartbeatSession,
          },
        },
      },
      channels: { whatsapp: { allowFrom: ["*"] } },
      session: { store: storePath },
    };
  }

  it("does not accumulate :heartbeat suffix when wake passes an already-suffixed key", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath }) => {
      const cfg = makeIsolatedHeartbeatConfig(tmpDir, storePath);
      const baseSessionKey = resolveMainSessionKey(cfg);

      // Simulate wake-request path: key already has :heartbeat from a previous tick.
      const alreadySuffixedKey = `${baseSessionKey}:heartbeat`;
      await fs.writeFile(
        storePath,
        JSON.stringify({
          [alreadySuffixedKey]: {
            sessionId: "sid",
            updatedAt: Date.now(),
            lastChannel: "whatsapp",
            lastProvider: "whatsapp",
            lastTo: "+1555",
            heartbeatIsolatedBaseSessionKey: baseSessionKey,
          },
        }),
        "utf-8",
      );
      const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
      replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });

      await runHeartbeatOnce({
        cfg,
        sessionKey: alreadySuffixedKey,
        deps: {
          getQueueSize: () => 0,
          nowMs: () => Date.now(),
        },
      });

      // Key must remain stable — no double :heartbeat suffix.
      expect(replySpy.mock.calls[0]?.[0]?.SessionKey).toBe(`${baseSessionKey}:heartbeat`);
    });
  });

  it("appends :heartbeat exactly once from a clean base key", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath }) => {
      const cfg = makeIsolatedHeartbeatConfig(tmpDir, storePath);
      const baseSessionKey = resolveMainSessionKey(cfg);

      const ctx = await runIsolatedHeartbeat({
        tmpDir,
        storePath,
        cfg,
        sessionKey: baseSessionKey,
      });

      expect(ctx?.SessionKey).toBe(`${baseSessionKey}:heartbeat`);
    });
  });

  it("stays stable even with multiply-accumulated suffixes", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath }) => {
      const cfg = makeIsolatedHeartbeatConfig(tmpDir, storePath);
      const baseSessionKey = resolveMainSessionKey(cfg);

      // Simulate a key that already accumulated several :heartbeat suffixes
      // (from an unpatched gateway running for many ticks).
      const deeplyAccumulatedKey = `${baseSessionKey}:heartbeat:heartbeat:heartbeat`;

      const ctx = await runIsolatedHeartbeat({
        tmpDir,
        storePath,
        cfg,
        sessionKey: deeplyAccumulatedKey,
      });

      // After the fix, ALL trailing :heartbeat suffixes are stripped by the
      // (:heartbeat)+$ regex in a single pass, then exactly one is re-appended.
      // A deeply accumulated key converges to "<base>:heartbeat" in one call.
      expect(ctx?.SessionKey).toBe(`${baseSessionKey}:heartbeat`);

      const store = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
        string,
        { heartbeatIsolatedBaseSessionKey?: string }
      >;
      expect(store[deeplyAccumulatedKey]).toBeUndefined();
      expect(store[`${baseSessionKey}:heartbeat`]?.heartbeatIsolatedBaseSessionKey).toBe(
        baseSessionKey,
      );
    });
  });

  it("keeps isolated keys distinct when the configured base key already ends with :heartbeat", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath }) => {
      const cfg = makeNamedIsolatedHeartbeatConfig(tmpDir, storePath, "alerts:heartbeat");
      const baseSessionKey = "agent:main:alerts:heartbeat";

      const ctx = await runIsolatedHeartbeat({
        tmpDir,
        storePath,
        cfg,
        sessionKey: baseSessionKey,
      });

      expect(ctx?.SessionKey).toBe(`${baseSessionKey}:heartbeat`);
    });
  });

  it("consumes base-session cron events when isolated heartbeat runs on a :heartbeat session", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath }) => {
      const cfg = makeIsolatedHeartbeatConfig(tmpDir, storePath);
      const baseSessionKey = resolveMainSessionKey(cfg);
      const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
      replySpy
        .mockResolvedValueOnce({ text: "Relay this cron update now" })
        .mockResolvedValueOnce({ text: "HEARTBEAT_OK" });

      enqueueSystemEvent("Cron: QMD maintenance completed", {
        sessionKey: baseSessionKey,
        contextKey: "cron:qmd-maintenance",
      });

      await runHeartbeatOnce({
        cfg,
        agentId: "main",
        reason: "interval",
        deps: {
          getQueueSize: () => 0,
          nowMs: () => Date.now(),
        },
      });

      expect(peekSystemEventEntries(baseSessionKey)).toStrictEqual([]);

      await runHeartbeatOnce({
        cfg,
        agentId: "main",
        reason: "interval",
        deps: {
          getQueueSize: () => 0,
          nowMs: () => Date.now(),
        },
      });

      expect(replySpy).toHaveBeenCalledTimes(2);
      const firstCtx = replySpy.mock.calls[0]?.[0] as {
        Body?: string;
        Provider?: string;
        SessionKey?: string;
      };
      const secondCtx = replySpy.mock.calls[1]?.[0] as {
        Body?: string;
        Provider?: string;
        SessionKey?: string;
      };

      expect(firstCtx.SessionKey).toBe(`${baseSessionKey}:heartbeat`);
      expect(firstCtx.Provider).toBe("cron-event");
      expect(firstCtx.Body).toContain("Cron: QMD maintenance completed");
      expect(secondCtx.SessionKey).toBe(`${baseSessionKey}:heartbeat`);
      expect(secondCtx.Body).not.toContain("Cron: QMD maintenance completed");
    });
  });

  it("stays stable for wake re-entry when the configured base key already ends with :heartbeat", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath }) => {
      const cfg = makeNamedIsolatedHeartbeatConfig(tmpDir, storePath, "alerts:heartbeat");
      const baseSessionKey = "agent:main:alerts:heartbeat";
      const alreadyIsolatedKey = `${baseSessionKey}:heartbeat`;
      await fs.writeFile(
        storePath,
        JSON.stringify({
          [alreadyIsolatedKey]: {
            sessionId: "sid",
            updatedAt: Date.now(),
            lastChannel: "whatsapp",
            lastProvider: "whatsapp",
            lastTo: "+1555",
            heartbeatIsolatedBaseSessionKey: baseSessionKey,
          },
        }),
        "utf-8",
      );
      const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
      replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });

      await runHeartbeatOnce({
        cfg,
        sessionKey: alreadyIsolatedKey,
        deps: {
          getQueueSize: () => 0,
          nowMs: () => Date.now(),
        },
      });

      expect(replySpy.mock.calls[0]?.[0]?.SessionKey).toBe(alreadyIsolatedKey);
    });
  });

  it("classifies hook:wake exec events when they are queued on the active isolated session", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath }) => {
      const cfg = makeIsolatedHeartbeatConfig(tmpDir, storePath);
      const baseSessionKey = resolveMainSessionKey(cfg);
      const isolatedSessionKey = `${baseSessionKey}:heartbeat`;
      await fs.writeFile(
        storePath,
        JSON.stringify({
          [isolatedSessionKey]: {
            sessionId: "sid",
            updatedAt: Date.now(),
            lastChannel: "whatsapp",
            lastProvider: "whatsapp",
            lastTo: "+1555",
            heartbeatIsolatedBaseSessionKey: baseSessionKey,
          },
        }),
        "utf-8",
      );
      enqueueSystemEvent("exec finished: deploy succeeded", { sessionKey: isolatedSessionKey });
      const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
      replySpy.mockResolvedValue({ text: "Handled internally" });

      const result = await runHeartbeatOnce({
        cfg,
        sessionKey: isolatedSessionKey,
        reason: "hook:wake",
        deps: {
          getQueueSize: () => 0,
          nowMs: () => Date.now(),
        },
      });

      expect(result.status).toBe("ran");
      const calledCtx = replySpy.mock.calls[0]?.[0] as {
        SessionKey?: string;
        Provider?: string;
        ForceSenderIsOwnerFalse?: boolean;
      };
      expect(calledCtx.SessionKey).toBe(isolatedSessionKey);
      expect(calledCtx.Provider).toBe("exec-event");
      expect(calledCtx.ForceSenderIsOwnerFalse).toBe(true);
    });
  });

  it("keeps a forced real :heartbeat session distinct from the heartbeat-isolated sibling", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath }) => {
      const cfg = makeIsolatedHeartbeatConfig(tmpDir, storePath);
      const realSessionKey = "agent:main:alerts:heartbeat";

      const ctx = await runIsolatedHeartbeat({
        tmpDir,
        storePath,
        cfg,
        sessionKey: realSessionKey,
      });

      expect(ctx?.SessionKey).toBe(`${realSessionKey}:heartbeat`);
    });
  });

  it("stays stable when a forced real :heartbeat session re-enters through its isolated sibling", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath }) => {
      const cfg = makeIsolatedHeartbeatConfig(tmpDir, storePath);
      const realSessionKey = "agent:main:alerts:heartbeat";
      const isolatedSessionKey = `${realSessionKey}:heartbeat`;

      await fs.writeFile(
        storePath,
        JSON.stringify({
          [isolatedSessionKey]: {
            sessionId: "sid",
            updatedAt: Date.now(),
            lastChannel: "whatsapp",
            lastProvider: "whatsapp",
            lastTo: "+1555",
            heartbeatIsolatedBaseSessionKey: realSessionKey,
          },
        }),
        "utf-8",
      );

      const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
      replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });

      await runHeartbeatOnce({
        cfg,
        sessionKey: isolatedSessionKey,
        deps: {
          getQueueSize: () => 0,
          nowMs: () => Date.now(),
        },
      });

      expect(replySpy).toHaveBeenCalledTimes(1);
      expect(replySpy.mock.calls[0]?.[0]?.SessionKey).toBe(isolatedSessionKey);
    });
  });

  it("does not create an isolated session when task-based heartbeat skips for no-tasks-due", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath }) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: {
              isolatedSession: true,
              target: "whatsapp",
            },
          },
        },
        channels: { whatsapp: { allowFrom: ["*"] } },
        session: { store: storePath },
      };
      const baseSessionKey = resolveMainSessionKey(cfg);
      const isolatedSessionKey = `${baseSessionKey}:heartbeat`;
      await fs.writeFile(
        `${tmpDir}/HEARTBEAT.md`,
        `tasks:
  - name: daily-check
    interval: 1d
    prompt: "Check status"
`,
        "utf-8",
      );

      await fs.writeFile(
        storePath,
        JSON.stringify({
          [baseSessionKey]: {
            sessionId: "sid",
            updatedAt: Date.now(),
            lastChannel: "whatsapp",
            lastProvider: "whatsapp",
            lastTo: "+1555",
            heartbeatTaskState: {
              "daily-check": 1,
            },
          },
        }),
        "utf-8",
      );
      const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
      replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });

      const result = await runHeartbeatOnce({
        cfg,
        sessionKey: baseSessionKey,
        deps: {
          getQueueSize: () => 0,
          nowMs: () => 2,
        },
      });

      expect(result).toEqual({ status: "skipped", reason: "no-tasks-due" });
      expect(replySpy).not.toHaveBeenCalled();

      const store = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<string, unknown>;
      expect(store[isolatedSessionKey]).toBeUndefined();
    });
  });

  it("converges a legacy isolated key that lacks the stored marker (single :heartbeat suffix)", async () => {
    // Regression for: when an isolated session was created before
    // heartbeatIsolatedBaseSessionKey was introduced, sessionKey already equals
    // "<base>:heartbeat" but the stored entry has no marker. The fallback used to
    // treat "<base>:heartbeat" as the new base and persist it as the marker, so
    // the next wake re-entry would stabilise at "<base>:heartbeat:heartbeat"
    // instead of converging back to "<base>:heartbeat".
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath }) => {
      const cfg = makeIsolatedHeartbeatConfig(tmpDir, storePath);
      const baseSessionKey = resolveMainSessionKey(cfg);
      const legacyIsolatedKey = `${baseSessionKey}:heartbeat`;

      // Legacy entry: has :heartbeat suffix but no heartbeatIsolatedBaseSessionKey marker.
      await fs.writeFile(
        storePath,
        JSON.stringify({
          [legacyIsolatedKey]: {
            sessionId: "sid",
            updatedAt: Date.now(),
            lastChannel: "whatsapp",
            lastProvider: "whatsapp",
            lastTo: "+1555",
          },
        }),
        "utf-8",
      );
      const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
      replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });

      await runHeartbeatOnce({
        cfg,
        sessionKey: legacyIsolatedKey,
        deps: {
          getQueueSize: () => 0,
          nowMs: () => Date.now(),
        },
      });

      // Must converge to the same canonical isolated key, not produce :heartbeat:heartbeat.
      expect(replySpy.mock.calls[0]?.[0]?.SessionKey).toBe(legacyIsolatedKey);
    });
  });
});
