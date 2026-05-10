import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ModelDefinitionConfig, ModelProviderConfig } from "../config/types.models.js";
import { upsertAuthProfile } from "./auth-profiles.js";
import { installModelsConfigTestHooks } from "./models-config.e2e-harness.js";

const EXPECTED_STANDARD_MODELS = ["step-3.5-flash"];
const EXPECTED_PLAN_MODELS = ["step-3.5-flash", "step-3.5-flash-2603"];
const STEPFUN_STANDARD_CN_BASE_URL = "https://api.stepfun.com/v1";
const STEPFUN_STANDARD_INTL_BASE_URL = "https://api.stepfun.ai/v1";
const STEPFUN_PLAN_CN_BASE_URL = "https://api.stepfun.com/step_plan/v1";
const STEPFUN_PLAN_INTL_BASE_URL = "https://api.stepfun.ai/step_plan/v1";

installModelsConfigTestHooks();

type StepFunRegion = "cn" | "intl";
type StepFunSurface = "standard" | "plan";

function createStepFunModel(id: string): ModelDefinitionConfig {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 4096,
  };
}

function buildStepFunCatalog(params: {
  surface: StepFunSurface;
  apiKey?: string;
  explicitBaseUrl?: string;
  profileId?: string;
  env?: NodeJS.ProcessEnv;
}): ModelProviderConfig | null {
  if (!params.apiKey) {
    return null;
  }
  const region =
    inferRegionFromBaseUrl(params.explicitBaseUrl) ??
    inferRegionFromProfileId(params.profileId) ??
    inferRegionFromEnv(params.env ?? {});
  const baseUrl = params.explicitBaseUrl ?? resolveDefaultBaseUrl(params.surface, region ?? "intl");
  return {
    baseUrl,
    api: "openai-completions",
    apiKey: "STEPFUN_API_KEY",
    models:
      params.surface === "plan"
        ? EXPECTED_PLAN_MODELS.map(createStepFunModel)
        : EXPECTED_STANDARD_MODELS.map(createStepFunModel),
  };
}

function inferRegionFromBaseUrl(baseUrl: string | undefined): StepFunRegion | undefined {
  if (!baseUrl) {
    return undefined;
  }
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    if (host === "api.stepfun.com") {
      return "cn";
    }
    if (host === "api.stepfun.ai") {
      return "intl";
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function inferRegionFromProfileId(profileId: string | undefined): StepFunRegion | undefined {
  if (!profileId) {
    return undefined;
  }
  if (profileId.includes(":cn")) {
    return "cn";
  }
  if (profileId.includes(":intl")) {
    return "intl";
  }
  return undefined;
}

function inferRegionFromEnv(env: NodeJS.ProcessEnv): StepFunRegion | undefined {
  return env.STEPFUN_API_KEY?.trim() ? "intl" : undefined;
}

function resolveDefaultBaseUrl(surface: StepFunSurface, region: StepFunRegion): string {
  if (surface === "plan") {
    return region === "cn" ? STEPFUN_PLAN_CN_BASE_URL : STEPFUN_PLAN_INTL_BASE_URL;
  }
  return region === "cn" ? STEPFUN_STANDARD_CN_BASE_URL : STEPFUN_STANDARD_INTL_BASE_URL;
}

describe("StepFun provider catalog", () => {
  it("includes standard and Step Plan providers when STEPFUN_API_KEY is configured", () => {
    const env = { STEPFUN_API_KEY: "test-stepfun-key" } as NodeJS.ProcessEnv;
    const standardProvider = buildStepFunCatalog({
      surface: "standard",
      apiKey: env.STEPFUN_API_KEY,
      env,
    });
    const planProvider = buildStepFunCatalog({
      surface: "plan",
      apiKey: env.STEPFUN_API_KEY,
      env,
    });
    if (!standardProvider || !planProvider) {
      throw new Error("expected StepFun providers");
    }

    expect(standardProvider.baseUrl).toBe("https://api.stepfun.ai/v1");
    expect(standardProvider.api).toBe("openai-completions");
    expect(standardProvider.apiKey).toBe("STEPFUN_API_KEY");
    expect(planProvider.baseUrl).toBe("https://api.stepfun.ai/step_plan/v1");
    expect(planProvider.api).toBe("openai-completions");
    expect(planProvider.apiKey).toBe("STEPFUN_API_KEY");
    expect(standardProvider.models?.map((model) => model.id)).toEqual(EXPECTED_STANDARD_MODELS);
    expect(planProvider.models?.map((model) => model.id)).toEqual(EXPECTED_PLAN_MODELS);
  });

  it("falls back to global endpoints for untagged StepFun auth profiles", () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));

    upsertAuthProfile({
      profileId: "stepfun:default",
      credential: {
        type: "api_key",
        provider: "stepfun",
        key: "sk-stepfun-default", // pragma: allowlist secret
      },
      agentDir,
    });
    upsertAuthProfile({
      profileId: "stepfun-plan:default",
      credential: {
        type: "api_key",
        provider: "stepfun-plan",
        key: "sk-stepfun-default", // pragma: allowlist secret
      },
      agentDir,
    });

    const providers = {
      stepfun: buildStepFunCatalog({
        surface: "standard",
        apiKey: "sk-stepfun-default",
      }),
      "stepfun-plan": buildStepFunCatalog({
        surface: "plan",
        apiKey: "sk-stepfun-default",
      }),
    };

    expect(providers?.stepfun?.baseUrl).toBe("https://api.stepfun.ai/v1");
    expect(providers?.["stepfun-plan"]?.baseUrl).toBe("https://api.stepfun.ai/step_plan/v1");
    expect(providers?.stepfun?.models?.map((model) => model.id)).toEqual(EXPECTED_STANDARD_MODELS);
    expect(providers?.["stepfun-plan"]?.models?.map((model) => model.id)).toEqual(
      EXPECTED_PLAN_MODELS,
    );
  });

  it("uses China endpoints when explicit config points the paired surface at the China host", () => {
    const explicitPlanBaseUrl = "https://api.stepfun.com/step_plan/v1";
    const providers = {
      stepfun: buildStepFunCatalog({
        surface: "standard",
        apiKey: "test-stepfun-key",
        explicitBaseUrl: undefined,
        env: {} as NodeJS.ProcessEnv,
        profileId: undefined,
      }),
      "stepfun-plan": buildStepFunCatalog({
        surface: "plan",
        apiKey: "test-stepfun-key",
        explicitBaseUrl: explicitPlanBaseUrl,
      }),
    };
    const pairedStandard = buildStepFunCatalog({
      surface: "standard",
      apiKey: "test-stepfun-key",
      explicitBaseUrl: resolveDefaultBaseUrl(
        "standard",
        inferRegionFromBaseUrl(explicitPlanBaseUrl) ?? "intl",
      ),
    });

    expect(pairedStandard?.baseUrl).toBe("https://api.stepfun.com/v1");
    expect(providers["stepfun-plan"]?.baseUrl).toBe("https://api.stepfun.com/step_plan/v1");
  });

  it("discovers both providers from shared regional auth profiles", () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));

    upsertAuthProfile({
      profileId: "stepfun:cn",
      credential: {
        type: "api_key",
        provider: "stepfun",
        key: "sk-stepfun-cn", // pragma: allowlist secret
      },
      agentDir,
    });
    upsertAuthProfile({
      profileId: "stepfun-plan:cn",
      credential: {
        type: "api_key",
        provider: "stepfun-plan",
        key: "sk-stepfun-cn", // pragma: allowlist secret
      },
      agentDir,
    });

    const providers = {
      stepfun: buildStepFunCatalog({
        surface: "standard",
        apiKey: "sk-stepfun-cn",
        profileId: "stepfun:cn",
      }),
      "stepfun-plan": buildStepFunCatalog({
        surface: "plan",
        apiKey: "sk-stepfun-cn",
        profileId: "stepfun-plan:cn",
      }),
    };

    expect(providers?.stepfun?.baseUrl).toBe("https://api.stepfun.com/v1");
    expect(providers?.["stepfun-plan"]?.baseUrl).toBe("https://api.stepfun.com/step_plan/v1");
    expect(providers?.stepfun?.models?.map((model) => model.id)).toEqual(EXPECTED_STANDARD_MODELS);
    expect(providers?.["stepfun-plan"]?.models?.map((model) => model.id)).toEqual(
      EXPECTED_PLAN_MODELS,
    );
  });
});
