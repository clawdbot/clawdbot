// Model probe RPC tests cover validation, normalization, bounded execution, and redacted mapping.
import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProbeSummary } from "../../commands/models/list.probe.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const mocks = vi.hoisted(() => ({
  runAuthProbes: vi.fn(),
}));

vi.mock("../../commands/models/list.probe.js", async () => {
  const actual = await vi.importActual<typeof import("../../commands/models/list.probe.js")>(
    "../../commands/models/list.probe.js",
  );
  return { ...actual, runAuthProbes: mocks.runAuthProbes };
});

import { modelsProbeHandlers } from "./models-probe.js";

const handler = expectDefined(
  modelsProbeHandlers["models.probe"],
  'modelsProbeHandlers["models.probe"] test invariant',
);

function summary(results: AuthProbeSummary["results"]): AuthProbeSummary {
  return {
    startedAt: 1,
    finishedAt: 2,
    durationMs: 1,
    totalTargets: results.length,
    options: { timeoutMs: 20_000, concurrency: 2, maxTokens: 8 },
    results,
  };
}

function createOptions(params: Record<string, unknown>, cfg: OpenClawConfig = {}) {
  const respond = vi.fn();
  return {
    options: {
      req: { type: "req", id: "probe-1", method: "models.probe", params },
      params,
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: { getRuntimeConfig: () => cfg } as never,
    } as GatewayRequestHandlerOptions,
    respond,
  };
}

describe("models.probe", () => {
  beforeEach(() => {
    mocks.runAuthProbes.mockReset();
    mocks.runAuthProbes.mockResolvedValue(summary([]));
  });

  it("rejects invalid parameters before running a probe", async () => {
    const { options, respond } = createOptions({ provider: "openai", extra: true });
    await handler(options);
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
    expect(mocks.runAuthProbes).not.toHaveBeenCalled();
  });

  it("normalizes providers, trims profiles, and clamps the timeout", async () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.6", fallbacks: ["openai/gpt-5.5"] },
          utilityModel: "openai/gpt-5.6-luna",
        },
      },
    };
    const { options } = createOptions(
      { provider: " OpenAI ", profileId: " work ", timeoutMs: 1 },
      cfg,
    );
    await handler(options);
    expect(mocks.runAuthProbes).toHaveBeenCalledWith({
      cfg,
      providers: ["openai"],
      modelCandidates: ["openai/gpt-5.6", "openai/gpt-5.5", "openai/gpt-5.6-luna"],
      options: {
        provider: "openai",
        profileIds: ["work"],
        timeoutMs: 5_000,
        concurrency: 2,
        maxTokens: 8,
      },
    });
  });

  it("probes the requested provider so overrides and model selection resolve", async () => {
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          "byteplus-plan": {
            baseUrl: "https://ark.ap-southeast.bytepluses.com/api/coding/v3",
            api: "openai-completions",
            models: [],
          },
        },
      },
      auth: {
        profiles: {
          "byteplus:plan": { provider: "byteplus", mode: "api_key" },
        },
        order: { byteplus: ["byteplus:plan"] },
      },
      agents: { defaults: { model: { primary: "byteplus-plan/ark-code-latest" } } },
    };
    const { options, respond } = createOptions({ provider: "byteplus-plan" }, cfg);
    await handler(options);
    expect(mocks.runAuthProbes).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg,
        providers: ["byteplus-plan"],
        modelCandidates: ["byteplus-plan/ark-code-latest"],
        options: expect.objectContaining({ provider: "byteplus-plan" }),
      }),
    );
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ provider: "byteplus-plan" }),
      undefined,
    );
  });

  it("maps target results and reports provider success when one credential works", async () => {
    mocks.runAuthProbes.mockResolvedValue(
      summary([
        {
          provider: "openai",
          profileId: "old",
          label: "Old",
          source: "profile",
          status: "auth",
          error: "expired",
          latencyMs: 20,
        },
        {
          provider: "openai",
          profileId: "work",
          label: "Work",
          source: "profile",
          status: "ok",
          latencyMs: 125,
        },
      ]),
    );
    const { options, respond } = createOptions({ provider: "openai", timeoutMs: 90_000 });
    await handler(options);
    expect(mocks.runAuthProbes).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ includeDirectKeys: true, timeoutMs: 60_000 }),
      }),
    );
    expect(respond).toHaveBeenCalledWith(
      true,
      {
        provider: "openai",
        status: "ok",
        latencyMs: 125,
        results: [
          {
            profileId: "old",
            label: "Old",
            status: "auth",
            latencyMs: 20,
            error: "Authentication failed.",
          },
          { profileId: "work", label: "Work", status: "ok", latencyMs: 125 },
        ],
      },
      undefined,
    );
  });

  it("redacts credential-shaped text from target and provider errors", async () => {
    const secret = ["AI", "za", "SyOpaqueProviderCredential"].join("");
    mocks.runAuthProbes.mockResolvedValue(
      summary([
        {
          provider: "openai",
          label: "env",
          source: "env",
          status: "auth",
          error: `request rejected for ${secret}`,
        },
      ]),
    );
    const { options, respond } = createOptions({ provider: "openai" });
    await handler(options);
    const payload = respond.mock.calls[0]?.[1];
    expect(payload).toMatchObject({ provider: "openai", status: "auth" });
    expect(JSON.stringify(payload)).not.toContain(secret);
    expect(JSON.stringify(payload)).toContain("Authentication failed.");
  });
});
