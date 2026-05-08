import { describe, expect, it } from "vitest";
import { SENSITIVE_URL_HINT_TAG } from "../shared/net/redact-sensitive-url.js";
import { computeBaseConfigSchemaResponse } from "./schema-base.js";

const BASE_CONFIG_SCHEMA = computeBaseConfigSchemaResponse({
  generatedAt: "2026-05-05T00:00:00.000Z",
});

describe("base config schema", () => {
  it("is deterministic for a fixed generatedAt timestamp", () => {
    expect(
      computeBaseConfigSchemaResponse({
        generatedAt: BASE_CONFIG_SCHEMA.generatedAt,
      }),
    ).toEqual(BASE_CONFIG_SCHEMA);
  });

  it("includes explicit URL-secret tags for sensitive URL fields", () => {
    expect(BASE_CONFIG_SCHEMA.uiHints["mcp.servers.*.url"]?.tags).toContain(SENSITIVE_URL_HINT_TAG);
    expect(BASE_CONFIG_SCHEMA.uiHints["models.providers.*.baseUrl"]?.tags).toContain(
      SENSITIVE_URL_HINT_TAG,
    );
  });

  it("omits legacy compatibility paths from the public schema payload", () => {
    const rootProperties = (
      BASE_CONFIG_SCHEMA.schema as {
        properties?: Record<string, unknown>;
      }
    ).properties;
    const hooksInternalProperties = (
      BASE_CONFIG_SCHEMA.schema as {
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
    const uiHints = BASE_CONFIG_SCHEMA.uiHints as Record<string, unknown>;

    expect(rootProperties?.canvasHost).toBeUndefined();
    expect(hooksInternalProperties?.handlers).toBeUndefined();
    expect(uiHints.canvasHost).toBeUndefined();
    expect(uiHints["hooks.internal.handlers"]).toBeUndefined();
  });

  it("includes videoGenerationModel in the public schema payload", () => {
    const agentDefaultsProperties = (
      BASE_CONFIG_SCHEMA.schema as {
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
    const uiHints = BASE_CONFIG_SCHEMA.uiHints as Record<string, unknown>;

    expect(agentDefaultsProperties).toHaveProperty("videoGenerationModel");
    expect(uiHints).toHaveProperty("agents.defaults.videoGenerationModel.primary");
    expect(uiHints).toHaveProperty("agents.defaults.videoGenerationModel.fallbacks");
    expect(uiHints).toHaveProperty("agents.defaults.mediaGenerationAutoProviderFallback");
  });
});
