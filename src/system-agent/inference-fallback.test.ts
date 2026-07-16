import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
import { verifySystemAgentInferenceWithFallback } from "./inference-fallback.js";
import type { SystemAgentConfiguredRoute } from "./inference-route.js";

const runtime = {} as RuntimeEnv;

function route(agentId: string, provider: string): SystemAgentConfiguredRoute {
  return {
    runner: "embedded",
    agentHarnessRuntimeOverride: "openclaw",
    runConfig: {},
    modelLabel: `${provider}/model`,
    provider,
    model: "model",
    agentDir: `/tmp/${agentId}`,
    agentId,
  };
}

const config: OpenClawConfig = {
  agents: {
    defaults: { model: { primary: "zeta/model" } },
    list: [
      { id: "requester", model: "zeta/model" },
      { id: "beta", model: "beta/model" },
      { id: "alpha", model: "alpha/model" },
    ],
  },
};

describe("system-agent inference fallback", () => {
  it("tries requester first, then authenticated providers by provider id", async () => {
    const attempts: string[] = [];
    const verify = vi.fn(async ({ agentId }: { agentId: string }) => {
      attempts.push(agentId);
      return agentId === "beta"
        ? ({ ok: true, modelRef: "beta/model", latencyMs: 1, binding: {} } as never)
        : ({ ok: false, status: "unavailable", error: "down" } as const);
    });

    const result = await verifySystemAgentInferenceWithFallback({
      requestingAgentId: "requester",
      runtime,
      deps: {
        readConfig: async () => config,
        resolveRoute: async (_cfg, agentId) =>
          route(agentId, agentId === "requester" ? "zeta" : agentId),
        hasAuth: async () => true,
        verify: verify as never,
      },
    });

    expect(result.ok).toBe(true);
    expect(attempts).toEqual(["requester", "alpha", "beta"]);
  });

  it("skips unauthenticated fallback providers", async () => {
    const attempts: string[] = [];
    await verifySystemAgentInferenceWithFallback({
      requestingAgentId: "requester",
      runtime,
      deps: {
        readConfig: async () => config,
        resolveRoute: async (_cfg, agentId) =>
          route(agentId, agentId === "requester" ? "zeta" : agentId),
        hasAuth: async ({ provider }) => provider !== "alpha",
        verify: async ({ agentId }) => {
          attempts.push(agentId);
          return { ok: false, status: "unavailable", error: "down" };
        },
      },
    });

    expect(attempts).toEqual(["requester", "beta"]);
  });

  it("uses a later authenticated route for one fallback provider", async () => {
    const attempts: string[] = [];
    const duplicateProviderConfig: OpenClawConfig = {
      agents: {
        defaults: { model: { primary: "zeta/model" } },
        list: [
          { id: "requester", model: "zeta/model" },
          { id: "alpha-bad", model: "alpha/model" },
          { id: "alpha-good", model: "alpha/model" },
        ],
      },
    };

    const result = await verifySystemAgentInferenceWithFallback({
      requestingAgentId: "requester",
      runtime,
      deps: {
        readConfig: async () => duplicateProviderConfig,
        resolveRoute: async (_cfg, agentId) =>
          route(agentId, agentId === "requester" ? "zeta" : "alpha"),
        hasAuth: async ({ agentDir }) => agentDir?.endsWith("alpha-good") === true,
        verify: async ({ agentId }) => {
          attempts.push(agentId);
          return agentId === "alpha-good"
            ? ({ ok: true, modelRef: "alpha/model", latencyMs: 1, binding: {} } as never)
            : ({ ok: false, status: "unavailable", error: "down" } as const);
        },
      },
    });

    expect(result.ok).toBe(true);
    expect(attempts).toEqual(["requester", "alpha-good"]);
  });

  it("tries another credential owner of the same provider after an auth failure", async () => {
    const attempts: string[] = [];
    const sameProviderConfig: OpenClawConfig = {
      agents: {
        defaults: { model: { primary: "alpha/model" } },
        list: [
          { id: "requester", model: "alpha/model" },
          { id: "alpha-other", model: "alpha/model" },
        ],
      },
    };

    const result = await verifySystemAgentInferenceWithFallback({
      requestingAgentId: "requester",
      runtime,
      deps: {
        readConfig: async () => sameProviderConfig,
        resolveRoute: async (_cfg, agentId) => route(agentId, "alpha"),
        hasAuth: async () => true,
        verify: async ({ agentId }) => {
          attempts.push(agentId);
          return agentId === "alpha-other"
            ? ({ ok: true, modelRef: "alpha/model", latencyMs: 1, binding: {} } as never)
            : ({ ok: false, status: "auth", error: "stale key" } as const);
        },
      },
    });

    expect(result.ok).toBe(true);
    expect(attempts).toEqual(["requester", "alpha-other"]);
  });

  it("treats a rate limit as credential-scoped and tries another owner", async () => {
    const attempts: string[] = [];
    const sameProviderConfig: OpenClawConfig = {
      agents: {
        defaults: { model: { primary: "alpha/model" } },
        list: [
          { id: "requester", model: "alpha/model" },
          { id: "alpha-other", model: "alpha/model" },
        ],
      },
    };

    const result = await verifySystemAgentInferenceWithFallback({
      requestingAgentId: "requester",
      runtime,
      deps: {
        readConfig: async () => sameProviderConfig,
        resolveRoute: async (_cfg, agentId) => route(agentId, "alpha"),
        hasAuth: async () => true,
        verify: async ({ agentId }) => {
          attempts.push(agentId);
          return agentId === "alpha-other"
            ? ({ ok: true, modelRef: "alpha/model", latencyMs: 1, binding: {} } as never)
            : ({ ok: false, status: "rate_limit", error: "429" } as const);
        },
      },
    });

    expect(result.ok).toBe(true);
    expect(attempts).toEqual(["requester", "alpha-other"]);
  });

  it("retires the whole provider after a provider-wide failure", async () => {
    const attempts: string[] = [];
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { model: { primary: "alpha/model" } },
        list: [
          { id: "requester", model: "alpha/model" },
          { id: "alpha-other", model: "alpha/model" },
          { id: "beta", model: "beta/model" },
        ],
      },
    };

    const result = await verifySystemAgentInferenceWithFallback({
      requestingAgentId: "requester",
      runtime,
      deps: {
        readConfig: async () => cfg,
        resolveRoute: async (_cfg, agentId) =>
          route(agentId, agentId === "beta" ? "beta" : "alpha"),
        hasAuth: async () => true,
        verify: async ({ agentId }) => {
          attempts.push(agentId);
          return agentId === "beta"
            ? ({ ok: true, modelRef: "beta/model", latencyMs: 1, binding: {} } as never)
            : ({ ok: false, status: "unavailable", error: "down" } as const);
        },
      },
    });

    expect(result.ok).toBe(true);
    // alpha-other is skipped: the requester's alpha route failed provider-wide.
    expect(attempts).toEqual(["requester", "beta"]);
  });

  it("does not fail over on bad answers", async () => {
    const verify = vi.fn(
      async () => ({ ok: false, status: "format", error: "bad answer" }) as const,
    );

    await verifySystemAgentInferenceWithFallback({
      requestingAgentId: "requester",
      runtime,
      deps: {
        readConfig: async () => config,
        resolveRoute: async (_cfg, agentId) =>
          route(agentId, agentId === "requester" ? "zeta" : agentId),
        hasAuth: async () => true,
        verify,
      },
    });

    expect(verify).toHaveBeenCalledOnce();
  });
});
