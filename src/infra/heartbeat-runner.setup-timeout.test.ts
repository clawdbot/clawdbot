import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveMainSessionKey } from "../config/sessions.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import { seedSessionStore, withTempHeartbeatSandbox } from "./heartbeat-runner.test-utils.js";

let stallHeartbeatDelivery = false;

vi.mock("./outbound/targets.js", async (importActual) => {
  const actual = await importActual<typeof import("./outbound/targets.js")>();
  return {
    ...actual,
    resolveHeartbeatDeliveryTargetWithSessionRoute: (
      ...args: Parameters<typeof actual.resolveHeartbeatDeliveryTargetWithSessionRoute>
    ) => {
      if (stallHeartbeatDelivery) {
        return new Promise(() => {});
      }
      return actual.resolveHeartbeatDeliveryTargetWithSessionRoute(...args);
    },
  };
});

afterEach(() => {
  stallHeartbeatDelivery = false;
  vi.restoreAllMocks();
});

describe("runHeartbeatOnce – heartbeat setup timeout", () => {
  it("fails fast when the reply stalls before model selection", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: {
              every: "5m",
              target: "whatsapp",
              timeoutSeconds: 1800,
            },
          },
        },
        channels: { whatsapp: { allowFrom: ["*"] } },
        session: { store: storePath },
      };
      const sessionKey = resolveMainSessionKey(cfg);
      await seedSessionStore(storePath, sessionKey, {
        lastChannel: "whatsapp",
        lastTo: "+1555",
      });

      // Never resolve and never report model selection -> setup timeout fires.
      replySpy.mockImplementation((_ctx, opts) => {
        return new Promise((_, reject) => {
          const signal = opts?.abortSignal;
          const rejectWithReason = () => {
            const reason = signal?.reason;
            reject(reason instanceof Error ? reason : new Error(String(reason)));
          };
          if (signal?.aborted) {
            rejectWithReason();
            return;
          }
          signal?.addEventListener("abort", rejectWithReason, { once: true });
        });
      });

      const result = await runHeartbeatOnce({
        cfg,
        sessionKey,
        setupTimeoutMs: 50,
        deps: {
          getReplyFromConfig: replySpy,
          getQueueSize: () => 0,
          nowMs: () => 0,
        },
      });

      expect(result.status).toBe("failed");
      if (result.status === "failed") {
        expect(result.reason).toMatch(/heartbeat setup timeout/);
        expect(result.reason).toMatch(/no model selected/);
      }
    });
  });

  it("does not fire when model selection disarms the guard", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: {
              every: "5m",
              target: "whatsapp",
              timeoutSeconds: 1800,
            },
          },
        },
        channels: { whatsapp: { allowFrom: ["*"] } },
        session: { store: storePath },
      };
      const sessionKey = resolveMainSessionKey(cfg);
      await seedSessionStore(storePath, sessionKey, {
        lastChannel: "whatsapp",
        lastTo: "+1555",
      });

      replySpy.mockImplementation(async (_ctx, opts) => {
        opts?.onModelSelected?.({ provider: "test", model: "test", thinkLevel: undefined });
        return { text: "HEARTBEAT_OK" };
      });

      const result = await runHeartbeatOnce({
        cfg,
        sessionKey,
        setupTimeoutMs: 50,
        deps: {
          getReplyFromConfig: replySpy,
          getQueueSize: () => 0,
          nowMs: () => 0,
        },
      });

      expect(result.status).toBe("ran");
    });
  });

  it("fails fast when delivery resolution stalls during preparation", async () => {
    stallHeartbeatDelivery = true;
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: {
              every: "5m",
              target: "whatsapp",
              timeoutSeconds: 1800,
            },
          },
        },
        channels: { whatsapp: { allowFrom: ["*"] } },
        session: { store: storePath },
      };
      const sessionKey = resolveMainSessionKey(cfg);
      await seedSessionStore(storePath, sessionKey, {
        lastChannel: "whatsapp",
        lastTo: "+1555",
      });

      const result = await runHeartbeatOnce({
        cfg,
        sessionKey,
        setupTimeoutMs: 50,
        deps: {
          getReplyFromConfig: replySpy,
          getQueueSize: () => 0,
          nowMs: () => 0,
        },
      });

      expect(result.status).toBe("failed");
      if (result.status === "failed") {
        expect(result.reason).toMatch(/heartbeat setup timeout/);
        expect(result.reason).toMatch(/no model selected/);
      }
    });
  });
});
