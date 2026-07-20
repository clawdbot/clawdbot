/** Tests exec SecretRef id validation parity with provider contract helpers. */
import { Compile } from "typebox/compile";
import { describe, expect, it } from "vitest";
import { SecretRefSchema as GatewaySecretRefSchema } from "../../packages/gateway-protocol/src/schema.js";
import { validateConfigObjectRaw } from "../config/validation.js";
import { buildSecretInputSchema } from "../plugin-sdk/secret-input-schema.js";
import {
  INVALID_FILE_SECRET_REF_IDS,
  INVALID_EXEC_SECRET_REF_IDS,
  VALID_FILE_SECRET_REF_IDS,
  VALID_EXEC_SECRET_REF_IDS,
} from "../test-utils/secret-ref-test-vectors.js";
import {
  TALK_TEST_PROVIDER_API_KEY_PATH,
  TALK_TEST_PROVIDER_API_KEY_PATH_SEGMENTS,
  TALK_TEST_PROVIDER_ID,
} from "../test-utils/talk-test-provider.js";
import { isSecretsApplyPlan } from "./plan.js";
import { isValidExecSecretRefId, isValidFileSecretRefId } from "./ref-contract.js";
import { compileTargetRegistryEntry, materializePathTokens } from "./target-registry-pattern.js";
import type { SecretTargetRegistryEntry } from "./target-registry-types.js";
import { listSecretTargetRegistryEntries } from "./target-registry.js";

describe("exec SecretRef id parity", () => {
  const validateGatewaySecretRef = Compile(GatewaySecretRefSchema);
  const pluginSdkSecretInput = buildSecretInputSchema();
  const validEnvSecretRefIds = ["OPENAI_API_KEY", "A", "A_1", `A${"B".repeat(127)}`];
  const invalidEnvSecretRefIds = ["", "openai_api_key", "OPENAI-API-KEY", "1OPENAI", "A B"];

  function configAcceptsExecRef(id: string): boolean {
    const result = validateConfigObjectRaw({
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            apiKey: { source: "exec", provider: "vault", id },
            models: [{ id: "gpt-5", name: "gpt-5" }],
          },
        },
      },
    });
    return result.ok;
  }

  function configAcceptsFileRef(id: string): boolean {
    const result = validateConfigObjectRaw({
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            apiKey: { source: "file", provider: "default", id },
            models: [{ id: "gpt-5", name: "gpt-5" }],
          },
        },
      },
    });
    return result.ok;
  }

  function configAcceptsRef(ref: unknown): boolean {
    const result = validateConfigObjectRaw({
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            apiKey: ref,
            models: [{ id: "gpt-5", name: "gpt-5" }],
          },
        },
      },
    });
    return result.ok;
  }

  function planAcceptsExecRef(id: string): boolean {
    return isSecretsApplyPlan({
      version: 1,
      protocolVersion: 1,
      generatedAt: "2026-03-10T00:00:00.000Z",
      generatedBy: "manual",
      targets: [
        {
          type: "talk.providers.*.apiKey",
          path: TALK_TEST_PROVIDER_API_KEY_PATH,
          pathSegments: [...TALK_TEST_PROVIDER_API_KEY_PATH_SEGMENTS],
          providerId: TALK_TEST_PROVIDER_ID,
          ref: { source: "exec", provider: "vault", id },
        },
      ],
    });
  }

  function planAcceptsRef(ref: unknown) {
    return isSecretsApplyPlan({
      version: 1,
      protocolVersion: 1,
      generatedAt: "2026-03-10T00:00:00.000Z",
      generatedBy: "manual",
      targets: [
        {
          type: "talk.providers.*.apiKey",
          path: TALK_TEST_PROVIDER_API_KEY_PATH,
          pathSegments: [...TALK_TEST_PROVIDER_API_KEY_PATH_SEGMENTS],
          providerId: TALK_TEST_PROVIDER_ID,
          ref,
        },
      ],
    });
  }

  for (const id of [...validEnvSecretRefIds, ...invalidEnvSecretRefIds]) {
    it(`keeps plan/gateway/plugin parity for env id "${id}"`, () => {
      const expected = validEnvSecretRefIds.includes(id);
      expect(planAcceptsRef({ source: "env", provider: "default", id })).toBe(expected);
      expect(validateGatewaySecretRef.Check({ source: "env", provider: "default", id })).toBe(
        expected,
      );
      expect(
        pluginSdkSecretInput.safeParse({ source: "env", provider: "default", id }).success,
      ).toBe(expected);
    });
  }

  for (const id of [...VALID_FILE_SECRET_REF_IDS, ...INVALID_FILE_SECRET_REF_IDS]) {
    it(`keeps config/gateway/plugin parity for file id "${id}"`, () => {
      const expected = isValidFileSecretRefId(id);
      expect(configAcceptsFileRef(id)).toBe(expected);
      expect(planAcceptsRef({ source: "file", provider: "default", id })).toBe(expected);
      expect(validateGatewaySecretRef.Check({ source: "file", provider: "default", id })).toBe(
        expected,
      );
      expect(
        pluginSdkSecretInput.safeParse({ source: "file", provider: "default", id }).success,
      ).toBe(expected);
    });
  }

  it("rejects invalid provider aliases across plan/gateway/plugin refs", () => {
    const ref = { source: "env" as const, provider: "Default", id: "OPENAI_API_KEY" };

    expect(planAcceptsRef(ref)).toBe(false);
    expect(validateGatewaySecretRef.Check(ref)).toBe(false);
    expect(pluginSdkSecretInput.safeParse(ref).success).toBe(false);
  });

  for (const ref of [
    { source: "env", provider: "default", id: "OPENAI_API_KEY", extra: "x" },
    { source: "file", provider: "default", id: "value", extra: "x" },
    { source: "exec", provider: "vault", id: "vault/openai/api-key", extra: "x" },
  ]) {
    it(`rejects non-canonical ${ref.source} refs with extra properties across config/plan/gateway/plugin`, () => {
      expect(configAcceptsRef(ref)).toBe(false);
      expect(planAcceptsRef(ref)).toBe(false);
      expect(validateGatewaySecretRef.Check(ref)).toBe(false);
      expect(pluginSdkSecretInput.safeParse(ref).success).toBe(false);
    });
  }

  for (const id of [...VALID_EXEC_SECRET_REF_IDS, ...INVALID_EXEC_SECRET_REF_IDS]) {
    it(`keeps config/plan/gateway/plugin parity for exec id "${id}"`, () => {
      const expected = isValidExecSecretRefId(id);
      expect(configAcceptsExecRef(id)).toBe(expected);
      expect(planAcceptsExecRef(id)).toBe(expected);
      expect(validateGatewaySecretRef.Check({ source: "exec", provider: "vault", id })).toBe(
        expected,
      );
      expect(
        pluginSdkSecretInput.safeParse({ source: "exec", provider: "vault", id }).success,
      ).toBe(expected);
    });
  }

  function classifyTargetClass(id: string): string {
    if (id.startsWith("auth-profiles.")) {
      return "auth-profiles";
    }
    if (id.startsWith("agents.")) {
      return "agents";
    }
    if (id.startsWith("channels.")) {
      return "channels";
    }
    if (id.startsWith("cron.")) {
      return "cron";
    }
    if (id.startsWith("gateway.auth.")) {
      return "gateway.auth";
    }
    if (id.startsWith("gateway.remote.")) {
      return "gateway.remote";
    }
    if (id.startsWith("messages.")) {
      return "messages";
    }
    if (id.startsWith("models.providers.") && id.includes(".headers.")) {
      return "models.headers";
    }
    if (id.startsWith("models.providers.") && id.includes(".request.")) {
      return "models.request";
    }
    if (id.startsWith("models.providers.")) {
      return "models.apiKey";
    }
    if (id.startsWith("skills.entries.")) {
      return "skills";
    }
    if (id.startsWith("talk.")) {
      return "talk";
    }
    if (id.startsWith("tools.web.fetch.")) {
      return "tools.web.fetch";
    }
    if (id.startsWith("plugins.entries.") && id.includes(".config.webFetch.apiKey")) {
      return "tools.web.fetch";
    }
    if (id.startsWith("plugins.entries.") && id.includes(".config.webSearch.apiKey")) {
      return "tools.web.search";
    }
    if (id.startsWith("tools.web.search.")) {
      return "tools.web.search";
    }
    if (id.startsWith("plugins.entries.")) {
      return "plugins.config";
    }
    return "unclassified";
  }

  function samplePathSegments(entry: SecretTargetRegistryEntry): string[] {
    const tokens = compileTargetRegistryEntry(entry).pathTokens;
    const captures = tokens.flatMap((token) => {
      if (token.kind === "literal") {
        return [];
      }
      return [token.kind === "array" ? "0" : "sample"];
    });
    const segments = materializePathTokens(tokens, captures);
    if (!segments) {
      throw new Error(`failed to sample path segments for pattern "${entry.pathPattern}"`);
    }
    return segments;
  }

  const registryPlanTargets = listSecretTargetRegistryEntries().filter(
    (entry) => entry.includeInPlan,
  );
  const unclassifiedTargetIds = registryPlanTargets
    .filter((entry) => classifyTargetClass(entry.id) === "unclassified")
    .map((entry) => entry.id);
  const sampledTargetsByClass = [
    ...new Set(registryPlanTargets.map((entry) => classifyTargetClass(entry.id))),
  ]
    .toSorted((a, b) => a.localeCompare(b))
    .map((className) => {
      const candidates = registryPlanTargets
        .filter((entry) => classifyTargetClass(entry.id) === className)
        .toSorted((a, b) => a.id.localeCompare(b.id));
      const selected = candidates[0];
      if (!selected) {
        throw new Error(`missing sampled target for class "${className}"`);
      }
      const pathSegments = samplePathSegments(selected);
      return {
        className,
        id: selected.id,
        type: selected.targetType,
        configFile: selected.configFile,
        pathSegments,
      };
    });

  function planAcceptsExecRefForSample(params: {
    type: string;
    configFile: "openclaw.json" | "auth-profiles.json";
    pathSegments: string[];
    id: string;
  }): boolean {
    return isSecretsApplyPlan({
      version: 1,
      protocolVersion: 1,
      generatedAt: "2026-03-10T00:00:00.000Z",
      generatedBy: "manual",
      targets: [
        {
          type: params.type,
          path: params.pathSegments.join("."),
          pathSegments: params.pathSegments,
          ref: { source: "exec", provider: "vault", id: params.id },
          ...(params.configFile === "auth-profiles.json" ? { agentId: "main" } : {}),
        },
      ],
    });
  }

  it("derives sampled class coverage from target registry metadata", () => {
    expect(unclassifiedTargetIds).toStrictEqual([]);
    expect(sampledTargetsByClass.length).toBeGreaterThan(0);
  });

  for (const sample of sampledTargetsByClass) {
    it(`rejects traversal-segment exec ids for sampled class "${sample.className}" (example: "${sample.id}")`, () => {
      expect(
        planAcceptsExecRefForSample({
          type: sample.type,
          configFile: sample.configFile,
          pathSegments: sample.pathSegments,
          id: "vault/openai/apiKey",
        }),
      ).toBe(true);
      expect(
        planAcceptsExecRefForSample({
          type: sample.type,
          configFile: sample.configFile,
          pathSegments: sample.pathSegments,
          id: "vault/../apiKey",
        }),
      ).toBe(false);
    });
  }
});
