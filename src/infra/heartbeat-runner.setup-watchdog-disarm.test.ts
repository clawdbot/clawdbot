import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveMainSessionKey } from "../config/sessions.js";
import { prepareHeartbeatRunStage } from "./heartbeat-runner-execution.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import { seedSessionStore, withTempHeartbeatSandbox } from "./heartbeat-runner.test-utils.js";

type CapturedController = {
  disarm: ReturnType<typeof vi.fn>;
  signal: AbortSignal;
};

const watchdogState = vi.hoisted(() => ({
  controllers: [] as CapturedController[],
  reset: () => {
    watchdogState.controllers.length = 0;
  },
}));

vi.mock("./heartbeat-runner-setup-watchdog.js", async (importActual) => {
  const actual = await importActual<typeof import("./heartbeat-runner-setup-watchdog.js")>();
  return {
    ...actual,
    createHeartbeatSetupAbortController: vi.fn((params) => {
      const controller = actual.createHeartbeatSetupAbortController(params);
      const disarmSpy = vi.fn(() => controller.disarm());
      watchdogState.controllers.push({ disarm: disarmSpy, signal: controller.signal });
      return { signal: controller.signal, disarm: disarmSpy };
    }),
  };
});

vi.mock("./heartbeat-runner-execution.js", async (importActual) => {
  const actual = await importActual<typeof import("./heartbeat-runner-execution.js")>();
  return {
    ...actual,
    prepareHeartbeatRunStage: vi.fn(actual.prepareHeartbeatRunStage),
  };
});

afterEach(() => {
  watchdogState.reset();
  vi.mocked(prepareHeartbeatRunStage).mockRestore();
  vi.restoreAllMocks();
});

describe("runHeartbeatOnce – setup watchdog lifecycle", () => {
  it("disarms setup watchdog when preparation returns skipped", async () => {
    vi.mocked(prepareHeartbeatRunStage).mockResolvedValue({
      kind: "skipped",
      reason: "no-route",
    } as const);

    await withTempHeartbeatSandbox(async ({ tmpDir, storePath }) => {
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
          getReplyFromConfig: vi.fn(),
          getQueueSize: () => 0,
          nowMs: () => 0,
        },
      });

      expect(result.status).toBe("skipped");
      if (result.status === "skipped") {
        expect(result.reason).toBe("no-route");
      }
      expect(watchdogState.controllers).toHaveLength(1);
      expect(watchdogState.controllers[0]!.disarm).toHaveBeenCalledTimes(1);
    });
  });

  it("disarms setup watchdog when alerts are disabled", async () => {
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
        channels: {
          whatsapp: {
            allowFrom: ["*"],
            heartbeatVisibility: {
              showAlerts: false,
              showOk: false,
              useIndicator: false,
            },
          },
        },
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

      expect(result.status).toBe("skipped");
      if (result.status === "skipped") {
        expect(result.reason).toBe("alerts-disabled");
      }
      expect(watchdogState.controllers).toHaveLength(1);
      expect(watchdogState.controllers[0]!.disarm).toHaveBeenCalledTimes(1);
    });
  });
});
