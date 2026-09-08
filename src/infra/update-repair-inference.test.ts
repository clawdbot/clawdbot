import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveAgentEntry } from "../agents/agent-scope-config.js";
import { splitTrailingAuthProfile } from "../agents/model-ref-profile.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
import type { SystemAgentConfiguredRoute } from "../system-agent/inference-route.js";
import { selectUpdateRepairInference } from "./update-repair-inference.js";

const mocks = vi.hoisted(() => ({
  hasAuth: vi.fn(),
  probe: vi.fn(),
  catalog: vi.fn(),
}));

vi.mock("../agents/auth-profiles/store-runtime.js", () => ({
  loadAuthProfileStoreForRuntime: () => ({ version: 1, profiles: {} }),
}));
vi.mock("../agents/model-auth-availability.js", () => ({
  createModelAuthAvailabilityResolver: () => ({
    evaluateModelAuth: (_provider: string, ref: { modelId: string }) => ({
      availability: mocks.hasAuth(ref),
    }),
  }),
}));
vi.mock("../agents/model-auth.js", () => ({ hasAvailableAuthForProvider: vi.fn() }));
vi.mock("../agents/model-catalog.js", () => ({ loadManifestModelCatalog: mocks.catalog }));
vi.mock("../system-agent/setup-inference.js", () => ({ verifySetupInference: vi.fn() }));
vi.mock("../system-agent/setup-inference-test.js", () => ({ runSetupInferenceTest: mocks.probe }));
vi.mock("../system-agent/setup-inference-persist.js", () => ({
  cleanupSetupInferenceTempDir: async ({ tempDir }: { tempDir: string }) => {
    const fs = await import("node:fs/promises");
    await fs.rm(tempDir, { recursive: true, force: true });
  },
}));
vi.mock("../system-agent/inference-route.js", () => ({
  resolveSystemAgentConfiguredRouteFromConfig: async (
    config: OpenClawConfig,
    agentId: string,
  ): Promise<SystemAgentConfiguredRoute | null> => {
    const configured = resolveAgentEntry(config, agentId)?.model ?? config.agents?.defaults?.model;
    const raw = typeof configured === "string" ? configured : configured?.primary;
    if (!raw) {
      return null;
    }
    const split = splitTrailingAuthProfile(raw);
    const slash = split.model.indexOf("/");
    const provider = split.model.slice(0, slash);
    return {
      runner: provider === "local-cli" ? "cli" : "embedded",
      provider,
      model: split.model.slice(slash + 1),
      modelLabel: split.model,
      runConfig: config,
      agentId,
      agentDir: `/isolated/${agentId}`,
      ...(split.profile ? { authProfileId: split.profile } : {}),
    };
  },
}));

const runtime: RuntimeEnv = { log() {}, error() {}, exit() {} };
const config: OpenClawConfig = {
  agents: {
    defaults: {
      systemAgent: { agentId: "owner" },
      model: { primary: "alpha/default", fallbacks: ["alpha/default-fallback"] },
    },
    entries: {
      owner: {
        model: {
          primary: "zeta/primary@owner-profile",
          fallbacks: ["zeta/backup", "zeta/spare"],
        },
      },
      other: { model: "alpha/other" },
    },
  },
};

function select(cfg = config, options: { signal?: AbortSignal; timeoutMs?: number } = {}) {
  return selectUpdateRepairInference({
    config: cfg,
    runtime,
    signal: options.signal ?? new AbortController().signal,
    timeoutMs: options.timeoutMs ?? 10_000,
  });
}

beforeEach(() => {
  mocks.hasAuth.mockReset().mockReturnValue(true);
  mocks.catalog.mockReset().mockReturnValue([]);
  mocks.probe.mockReset().mockResolvedValue({ ok: true, latencyMs: 1, text: "OK", auth: {} });
});

describe("update repair inference", () => {
  it("tries the owner's configured fallback before other agents and preserves auth ownership", async () => {
    mocks.probe.mockResolvedValueOnce({ ok: false, status: "format", error: "bad model" });
    const result = await select();

    expect(mocks.probe.mock.calls.map(([params]) => params.plan.modelRef)).toEqual([
      "zeta/primary",
      "zeta/backup",
    ]);
    expect(mocks.probe.mock.calls[0]?.[0].plan).toMatchObject({
      authProfileId: "owner-profile",
      agentDir: "/isolated/owner",
    });
    expect(mocks.hasAuth.mock.calls[0]?.[0]).toMatchObject({
      modelId: "primary",
      pinnedProfileId: "owner-profile",
    });
    expect(result).toMatchObject({
      ok: true,
      route: { agentId: "owner", model: "backup", provider: "zeta" },
      modelFallbacks: ["zeta/spare"],
    });
  });

  it("exhausts owner models before another authenticated agent, including same-provider failures", async () => {
    mocks.probe.mockImplementation(async ({ plan }) =>
      plan.routeAgentId === "owner"
        ? { ok: false, status: "unavailable", error: "route unavailable" }
        : { ok: true, latencyMs: 1, text: "OK", auth: {} },
    );
    const result = await select();

    expect(mocks.probe.mock.calls.map(([params]) => params.plan.modelRef)).toEqual([
      "zeta/primary",
      "zeta/backup",
      "zeta/spare",
      "alpha/other",
    ]);
    expect(result).toMatchObject({
      ok: true,
      route: { agentId: "other", agentDir: "/isolated/other" },
    });
  });

  it("skips unauthenticated, CLI, manifest non-tool and custom non-tool routes before probing", async () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { systemAgent: { agentId: "owner" } },
        entries: {
          owner: {
            model: {
              primary: "zeta/no-auth",
              fallbacks: ["local-cli/model", "zeta/text-only", "custom/text-only", "zeta/tools"],
            },
          },
        },
      },
      models: {
        providers: {
          custom: {
            baseUrl: "http://127.0.0.1:12345",
            models: [
              {
                id: "text-only",
                name: "Text only",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 4096,
                maxTokens: 256,
                compat: { supportsTools: false },
              },
            ],
          },
        },
      },
    };
    mocks.catalog.mockReturnValue([
      { provider: "zeta", id: "text-only", compat: { supportsTools: false } },
    ]);
    mocks.hasAuth.mockImplementation(({ modelId }) => modelId !== "no-auth");
    const result = await select(cfg);

    expect(result).toMatchObject({ ok: true, route: { model: "tools" } });
    expect(mocks.probe.mock.calls.map(([params]) => params.plan.modelRef)).toEqual(["zeta/tools"]);
    expect(mocks.hasAuth.mock.calls.map(([params]) => params.modelId)).toEqual([
      "no-auth",
      "tools",
    ]);
  });

  it("returns unavailable when no route has usable auth", async () => {
    mocks.hasAuth.mockReturnValue(false);
    expect(await select()).toMatchObject({
      ok: false,
      reason: expect.stringContaining("usable inference"),
    });
    expect(mocks.probe).not.toHaveBeenCalled();
  });

  it("awaits an aborted probe's completion before returning", async () => {
    const controller = new AbortController();
    let drained = false;
    mocks.probe.mockImplementation(async ({ signal }: { signal: AbortSignal }) => {
      queueMicrotask(() => controller.abort());
      await new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve();
        } else {
          signal.addEventListener("abort", () => resolve(), { once: true });
        }
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      drained = true;
      return { ok: false, status: "timeout", error: "aborted" };
    });
    const result = await select(config, { signal: controller.signal });
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("budget") });
    expect(drained).toBe(true);
    expect(mocks.probe).toHaveBeenCalledOnce();
  });
});
