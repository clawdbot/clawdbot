import AjvPkg from "ajv";
import { describe, expect, it } from "vitest";
import { validateConfigObjectRaw } from "../config/validation.js";
import { SecretRefSchema as GatewaySecretRefSchema } from "../gateway/protocol/schema/primitives.js";
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
import { materializePathTokens, parsePathPattern } from "./target-registry-pattern.js";
import { canonicalizeSecretTargetCoverageId } from "./target-registry-test-helpers.js";
import { listSecretTargetRegistryEntries } from "./target-registry.js";

describe("exec SecretRef id parity", () => {
  const Ajv = AjvPkg as unknown as new (opts?: object) => import("ajv").default;
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validateGatewaySecretRef = ajv.compile(GatewaySecretRefSchema);
  const pluginSdkSecretInput = buildSecretInputSchema();

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

  for (const id of [...VALID_FILE_SECRET_REF_IDS, ...INVALID_FILE_SECRET_REF_IDS]) {
    it(`keeps config/gateway/plugin parity for file id "${id}"`, () => {
      const expected = isValidFileSecretRefId(id);
      expect(configAcceptsFileRef(id)).toBe(expected);
      expect(validateGatewaySecretRef({ source: "file", provider: "default", id })).toBe(expected);
      expect(
        pluginSdkSecretInput.safeParse({ source: "file", provider: "default", id }).success,
      ).toBe(expected);
    });
  }

  for (const id of [...VALID_EXEC_SECRET_REF_IDS, ...INVALID_EXEC_SECRET_REF_IDS]) {
    it(`keeps config/plan/gateway/plugin parity for exec id "${id}"`, () => {
      const expected = isValidExecSecretRefId(id);
      expect(configAcceptsExecRef(id)).toBe(expected);
      expect(planAcceptsExecRef(id)).toBe(expected);
      expect(validateGatewaySecretRef({ source: "exec", provider: "vault", id })).toBe(expected);
      expect(
        pluginSdkSecretInput.safeParse({ source: "exec", provider: "vault", id }).success,
      ).toBe(expected);
    });
  }

  function classifyTargetClass(id: string): string {
    const canonicalId = canonicalizeSecretTargetCoverageId(id);
    if (canonicalId.startsWith("auth-profiles.")) {
      return "auth-profiles";
    }
    if (canonicalId.startsWith("agents.")) {
      return "agents";
    }
    if (canonicalId.startsWith("channels.")) {
      return "channels";
    }
    if (canonicalId.startsWith("cron.")) {
      return "cron";
    }
    if (canonicalId.startsWith("gateway.auth.")) {
      return "gateway.auth";
    }
    if (canonicalId.startsWith("gateway.remote.")) {
      return "gateway.remote";
    }
    if (canonicalId.startsWith("messages.")) {
      return "messages";
    }
    if (canonicalId.startsWith("models.providers.") && canonicalId.includes(".headers.")) {
      return "models.headers";
    }
    if (canonicalId.startsWith("models.providers.") && canonicalId.includes(".request.")) {
      return "models.request";
    }
    if (canonicalId.startsWith("models.providers.")) {
      return "models.apiKey";
    }
    if (canonicalId.startsWith("skills.entries.")) {
      return "skills";
    }
    if (canonicalId.startsWith("talk.")) {
      return "talk";
    }
    if (canonicalId.startsWith("tools.web.fetch.")) {
      return "tools.web.fetch";
    }
    if (
      canonicalId.startsWith("plugins.entries.") &&
      canonicalId.includes(".config.webFetch.apiKey")
    ) {
      return "tools.web.fetch";
    }
    if (
      canonicalId.startsWith("plugins.entries.") &&
      canonicalId.includes(".config.webSearch.apiKey")
    ) {
      return "tools.web.search";
    }
    if (canonicalId.startsWith("tools.web.search.")) {
      return "tools.web.search";
    }
    if (canonicalId.startsWith("plugins.entries.")) {
      return "plugins.config";
    }
    return "unclassified";
  }

  function samplePathSegments(pathPattern: string): string[] {
    const tokens = parsePathPattern(pathPattern);
    const captures = tokens.flatMap((token) => {
      if (token.kind === "literal") {
        return [];
      }
      return [token.kind === "array" ? "0" : "sample"];
    });
    const segments = materializePathTokens(tokens, captures);
    if (!segments) {
      throw new Error(`failed to sample path segments for pattern "${pathPattern}"`);
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
      const pathSegments = samplePathSegments(selected.pathPattern);
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
    expect(unclassifiedTargetIds).toEqual([]);
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
