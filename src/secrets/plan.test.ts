import { describe, expect, it } from "vitest";
import {
  INVALID_EXEC_SECRET_REF_IDS,
  VALID_EXEC_SECRET_REF_IDS,
} from "../test-utils/secret-ref-test-vectors.js";
import {
  TALK_TEST_PROVIDER_API_KEY_PATH,
  TALK_TEST_PROVIDER_API_KEY_PATH_SEGMENTS,
  TALK_TEST_PROVIDER_ID,
} from "../test-utils/talk-test-provider.js";
import { isSecretsApplyPlan, resolveValidatedPlanTarget } from "./plan.js";

type ValidatedPlanTarget = NonNullable<ReturnType<typeof resolveValidatedPlanTarget>>;

function requireValidatedPlanTarget(
  resolved: ReturnType<typeof resolveValidatedPlanTarget>,
): ValidatedPlanTarget {
  if (!resolved) {
    throw new Error("expected validated secrets plan target");
  }
  return resolved;
}

describe("secrets plan validation", () => {
  it("accepts legacy provider target types", () => {
    const resolved = resolveValidatedPlanTarget({
      type: "models.providers.apiKey",
      path: "models.providers.openai.apiKey",
      pathSegments: ["models", "providers", "openai", "apiKey"],
      providerId: "openai",
    });
    expect(requireValidatedPlanTarget(resolved).pathSegments).toEqual([
      "models",
      "providers",
      "openai",
      "apiKey",
    ]);
  });

  it("accepts expanded target types beyond legacy surface", () => {
    const resolved = resolveValidatedPlanTarget({
      type: "channels.telegram.botToken",
      path: "channels.telegram.botToken",
      pathSegments: ["channels", "telegram", "botToken"],
    });
    expect(requireValidatedPlanTarget(resolved).pathSegments).toEqual([
      "channels",
      "telegram",
      "botToken",
    ]);
  });

  it("accepts model provider header targets with wildcard-backed paths", () => {
    const resolved = resolveValidatedPlanTarget({
      type: "models.providers.headers",
      path: "models.providers.openai.headers.x-api-key",
      pathSegments: ["models", "providers", "openai", "headers", "x-api-key"],
      providerId: "openai",
    });
    expect(requireValidatedPlanTarget(resolved).pathSegments).toEqual([
      "models",
      "providers",
      "openai",
      "headers",
      "x-api-key",
    ]);
  });

  it("rejects target paths that do not match the registered shape", () => {
    const resolved = resolveValidatedPlanTarget({
      type: "channels.telegram.botToken",
      path: "channels.telegram.webhookSecret",
      pathSegments: ["channels", "telegram", "webhookSecret"],
    });
    expect(resolved).toBeNull();
  });

  it("validates plan files with non-legacy target types", () => {
    const isValid = isSecretsApplyPlan({
      version: 1,
      protocolVersion: 1,
      generatedAt: "2026-02-28T00:00:00.000Z",
      generatedBy: "manual",
      targets: [
        {
          type: "talk.providers.*.apiKey",
          path: TALK_TEST_PROVIDER_API_KEY_PATH,
          pathSegments: [...TALK_TEST_PROVIDER_API_KEY_PATH_SEGMENTS],
          providerId: TALK_TEST_PROVIDER_ID,
          ref: { source: "env", provider: "default", id: "TALK_API_KEY" },
        },
      ],
    });
    expect(isValid).toBe(true);
  });

  it("requires agentId for auth-profiles plan targets", () => {
    const withoutAgent = isSecretsApplyPlan({
      version: 1,
      protocolVersion: 1,
      generatedAt: "2026-02-28T00:00:00.000Z",
      generatedBy: "manual",
      targets: [
        {
          type: "auth-profiles.api_key.key",
          path: "profiles.openai:default.key",
          pathSegments: ["profiles", "openai:default", "key"],
          ref: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
        },
      ],
    });
    expect(withoutAgent).toBe(false);

    const withAgent = isSecretsApplyPlan({
      version: 1,
      protocolVersion: 1,
      generatedAt: "2026-02-28T00:00:00.000Z",
      generatedBy: "manual",
      targets: [
        {
          type: "auth-profiles.api_key.key",
          path: "profiles.openai:default.key",
          pathSegments: ["profiles", "openai:default", "key"],
          agentId: "main",
          ref: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
        },
      ],
    });
    expect(withAgent).toBe(true);
  });

  it("accepts valid exec secret ref ids in plans", () => {
    for (const id of VALID_EXEC_SECRET_REF_IDS) {
      const isValid = isSecretsApplyPlan({
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
      expect(isValid, `expected valid plan exec ref id: ${id}`).toBe(true);
    }
  });

  it("rejects invalid exec secret ref ids in plans", () => {
    for (const id of INVALID_EXEC_SECRET_REF_IDS) {
      const isValid = isSecretsApplyPlan({
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
      expect(isValid, `expected invalid plan exec ref id: ${id}`).toBe(false);
    }
  });
});
