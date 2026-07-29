/**
 * Gateway startup orchestration tests.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const prepareModelRuntimeSnapshotMock = vi.fn(async (_params: unknown) => ({}));
const refreshPreparedModelRuntimeSnapshotsMock = vi.fn(
  async (
    _cfg: OpenClawConfig,
    _options?: {
      gatewayLifecycle?: boolean;
      defaultWorkspaceDir?: string;
      catalogMode?: "live" | "static";
    },
  ) => {},
);

vi.mock("../agents/agent-scope.js", () => ({
  resolveDefaultAgentDir: () => "/tmp/agent",
  resolveAgentWorkspaceDir: () => "/tmp/workspace",
  resolveDefaultAgentId: () => "default",
}));

vi.mock("../agents/prepared-model-runtime.js", () => ({
  publishPreparedModelRuntimeSnapshot: (params: unknown) => prepareModelRuntimeSnapshotMock(params),
  refreshPreparedModelRuntimeSnapshots: (
    cfg: OpenClawConfig,
    options?: {
      gatewayLifecycle?: boolean;
      defaultWorkspaceDir?: string;
      catalogMode?: "live" | "static";
    },
  ) => refreshPreparedModelRuntimeSnapshotsMock(cfg, options),
}));

let prewarmConfiguredPrimaryModel: typeof import("./server-startup-post-attach.js").testing.prewarmConfiguredPrimaryModel;
let publishStartupModelRuntime: typeof import("./server-startup-post-attach.js").testing.publishStartupModelRuntime;
let shouldSkipStartupModelPrewarm: typeof import("./server-startup-post-attach.js").testing.shouldSkipStartupModelPrewarm;

describe("gateway startup primary model warmup", () => {
  beforeAll(async () => {
    ({
      testing: {
        prewarmConfiguredPrimaryModel,
        publishStartupModelRuntime,
        shouldSkipStartupModelPrewarm,
      },
    } = await import("./server-startup-post-attach.js"));
  });

  beforeEach(() => {
    prepareModelRuntimeSnapshotMock.mockClear();
    refreshPreparedModelRuntimeSnapshotsMock.mockClear();
  });

  it("prewarms an explicit configured primary model", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.4",
          },
        },
      },
    } as OpenClawConfig;

    await prewarmConfiguredPrimaryModel({
      cfg,
      log: { warn: vi.fn() },
    });

    expect(refreshPreparedModelRuntimeSnapshotsMock).toHaveBeenCalledWith(cfg, {
      gatewayLifecycle: true,
      catalogMode: "static",
    });
  });

  it("prewarms the default catalog when no explicit primary model is configured", async () => {
    const cfg = {} as OpenClawConfig;
    await prewarmConfiguredPrimaryModel({
      cfg,
      log: { warn: vi.fn() },
    });

    expect(refreshPreparedModelRuntimeSnapshotsMock).toHaveBeenCalledWith(cfg, {
      gatewayLifecycle: true,
      catalogMode: "static",
    });
  });

  it("honors the startup model prewarm skip env", () => {
    expect(shouldSkipStartupModelPrewarm({})).toBe(false);
    expect(
      shouldSkipStartupModelPrewarm({
        OPENCLAW_SKIP_STARTUP_MODEL_PREWARM: "1",
      }),
    ).toBe(true);
    expect(
      shouldSkipStartupModelPrewarm({
        OPENCLAW_SKIP_STARTUP_MODEL_PREWARM: "true",
      }),
    ).toBe(true);
  });

  it("publishes required runtime snapshots when optional startup prewarm is skipped", async () => {
    vi.stubEnv("OPENCLAW_SKIP_STARTUP_MODEL_PREWARM", "1");
    const optionalPrewarm = vi.fn(async () => {});
    try {
      await publishStartupModelRuntime(
        {
          cfg: {} as OpenClawConfig,
          workspaceDir: "/tmp/skip-explicit-workspace",
          log: { warn: vi.fn() },
        },
        optionalPrewarm,
      );

      expect(refreshPreparedModelRuntimeSnapshotsMock).toHaveBeenCalledOnce();
      expect(refreshPreparedModelRuntimeSnapshotsMock).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ defaultWorkspaceDir: "/tmp/skip-explicit-workspace" }),
      );
      expect(optionalPrewarm).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("publishes lifecycle owners for configured CLI backends", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: {
            primary: "codex-cli/gpt-5.5",
          },
        },
      },
    } as OpenClawConfig;
    await prewarmConfiguredPrimaryModel({ cfg, log: { warn: vi.fn() } });

    expect(refreshPreparedModelRuntimeSnapshotsMock).toHaveBeenCalledWith(cfg, {
      gatewayLifecycle: true,
      catalogMode: "static",
    });
  });

  it("preserves the explicit startup workspace in the published default owner", async () => {
    const cfg = {} as OpenClawConfig;
    await prewarmConfiguredPrimaryModel({
      cfg,
      workspaceDir: "/tmp/explicit-workspace",
      log: { warn: vi.fn() },
    });

    expect(refreshPreparedModelRuntimeSnapshotsMock).toHaveBeenCalledWith(cfg, {
      gatewayLifecycle: true,
      catalogMode: "static",
      defaultWorkspaceDir: "/tmp/explicit-workspace",
    });
  });

  it("propagates lifecycle catalog preparation failure", async () => {
    const error = new Error("models write failed");
    refreshPreparedModelRuntimeSnapshotsMock.mockRejectedValueOnce(error);

    await expect(
      prewarmConfiguredPrimaryModel({
        cfg: {
          agents: {
            defaults: {
              model: {
                primary: "codex/gpt-5.4",
              },
            },
          },
        } as OpenClawConfig,
        log: { warn: vi.fn() },
      }),
    ).rejects.toBe(error);
  });
});
