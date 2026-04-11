import { describe, expect, it } from "vitest";
import { SENSITIVE_URL_HINT_TAG } from "../shared/net/redact-sensitive-url.js";
import { DEFAULT_LLM_IDLE_TIMEOUT_SECONDS } from "./agent-timeout-defaults.js";
import { computeBaseConfigSchemaResponse } from "./schema-base.js";
import { GENERATED_BASE_CONFIG_SCHEMA } from "./schema.base.generated.js";

describe("generated base config schema", () => {
  it("matches the computed base config schema payload", () => {
    expect(
      computeBaseConfigSchemaResponse({
        generatedAt: GENERATED_BASE_CONFIG_SCHEMA.generatedAt,
      }),
    ).toEqual(GENERATED_BASE_CONFIG_SCHEMA);
  });

  it("includes explicit URL-secret tags for sensitive URL fields", () => {
    expect(GENERATED_BASE_CONFIG_SCHEMA.uiHints["mcp.servers.*.url"]?.tags).toContain(
      SENSITIVE_URL_HINT_TAG,
    );
    expect(GENERATED_BASE_CONFIG_SCHEMA.uiHints["models.providers.*.baseUrl"]?.tags).toContain(
      SENSITIVE_URL_HINT_TAG,
    );
  });

  it("omits legacy hooks.internal.handlers from the public schema payload", () => {
    const hooksInternalProperties = (
      GENERATED_BASE_CONFIG_SCHEMA.schema as {
        properties?: {
          hooks?: {
            properties?: {
              internal?: {
                properties?: Record<string, unknown>;
              };
            };
          };
        };
      }
    ).properties?.hooks?.properties?.internal?.properties;
    const uiHints = GENERATED_BASE_CONFIG_SCHEMA.uiHints as Record<string, unknown>;

    expect(hooksInternalProperties?.handlers).toBeUndefined();
    expect(uiHints["hooks.internal.handlers"]).toBeUndefined();
  });

  it("includes videoGenerationModel in the public schema payload", () => {
    const agentDefaultsProperties = (
      GENERATED_BASE_CONFIG_SCHEMA.schema as {
        properties?: {
          agents?: {
            properties?: {
              defaults?: {
                properties?: Record<string, unknown>;
              };
            };
          };
        };
      }
    ).properties?.agents?.properties?.defaults?.properties;
    const uiHints = GENERATED_BASE_CONFIG_SCHEMA.uiHints as Record<string, unknown>;

    expect(agentDefaultsProperties?.videoGenerationModel).toBeDefined();
    expect(uiHints["agents.defaults.videoGenerationModel.primary"]).toBeDefined();
    expect(uiHints["agents.defaults.videoGenerationModel.fallbacks"]).toBeDefined();
    expect(uiHints["agents.defaults.mediaGenerationAutoProviderFallback"]).toBeDefined();
  });

  it("keeps the LLM idle timeout schema help aligned with the runtime default", () => {
    const idleTimeoutDescription = (
      GENERATED_BASE_CONFIG_SCHEMA.schema as {
        properties?: {
          agents?: {
            properties?: {
              defaults?: {
                properties?: {
                  llm?: {
                    properties?: {
                      idleTimeoutSeconds?: {
                        description?: string;
                      };
                    };
                  };
                };
              };
            };
          };
        };
      }
    ).properties?.agents?.properties?.defaults?.properties?.llm?.properties?.idleTimeoutSeconds
      ?.description;

    expect(idleTimeoutDescription).toContain(
      `Default: ${DEFAULT_LLM_IDLE_TIMEOUT_SECONDS} seconds.`,
    );
  });
});
