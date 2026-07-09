import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { testing } from "./cli.js";

describe("vault CLI setup plan", () => {
  it("generates plugin-managed provider config and model api key targets", () => {
    const providerConfig = testing.buildProviderConfig();
    const providerSecrets = testing.collectProviderSecrets({
      openaiId: "providers/openai/apiKey",
      anthropicId: "providers/anthropic/apiKey",
      providerKey: ["local-openai=providers/local-openai/apiKey"],
    });
    const plan = testing.buildPlan({
      providerAlias: "vault",
      providerConfig,
      providerSecrets,
    });

    expect(plan.providerUpserts).toEqual({
      vault: {
        source: "exec",
        pluginIntegration: {
          pluginId: "vault",
          integrationId: "vault",
        },
      },
    });
    expect(plan.targets).toEqual([
      {
        type: "models.providers.apiKey",
        path: "models.providers.openai.apiKey",
        pathSegments: ["models", "providers", "openai", "apiKey"],
        providerId: "openai",
        ref: {
          source: "exec",
          provider: "vault",
          id: "providers/openai/apiKey",
        },
      },
      {
        type: "models.providers.apiKey",
        path: "models.providers.anthropic.apiKey",
        pathSegments: ["models", "providers", "anthropic", "apiKey"],
        providerId: "anthropic",
        ref: {
          source: "exec",
          provider: "vault",
          id: "providers/anthropic/apiKey",
        },
      },
      {
        type: "models.providers.apiKey",
        path: "models.providers.local-openai.apiKey",
        pathSegments: ["models", "providers", "local-openai", "apiKey"],
        providerId: "local-openai",
        ref: {
          source: "exec",
          provider: "vault",
          id: "providers/local-openai/apiKey",
        },
      },
    ]);
  });

  it("generates targets for arbitrary known openclaw secret targets", () => {
    const plan = testing.buildPlan({
      providerAlias: "vault",
      providerConfig: testing.buildProviderConfig(),
      providerSecrets: [],
      configTargetSecrets: testing.parseConfigTargetMappings([
        "channels.telegram.botToken=channels/telegram/botToken",
        "models.providers.openai.headers.x-api-key=providers/openai/proxyKey",
        "auth-profiles:main:profiles.openai:default.key=providers/openai/apiKey",
      ]),
    });

    expect(plan.targets).toEqual([
      {
        type: "channels.telegram.botToken",
        path: "channels.telegram.botToken",
        pathSegments: ["channels", "telegram", "botToken"],
        ref: {
          source: "exec",
          provider: "vault",
          id: "channels/telegram/botToken",
        },
      },
      {
        type: "models.providers.headers",
        path: "models.providers.openai.headers.x-api-key",
        pathSegments: ["models", "providers", "openai", "headers", "x-api-key"],
        providerId: "openai",
        ref: {
          source: "exec",
          provider: "vault",
          id: "providers/openai/proxyKey",
        },
      },
      {
        type: "auth-profiles.api_key.key",
        path: "profiles.openai:default.key",
        pathSegments: ["profiles", "openai:default", "key"],
        agentId: "main",
        ref: {
          source: "exec",
          provider: "vault",
          id: "providers/openai/apiKey",
        },
      },
    ]);
  });

  it("parses config target mappings", () => {
    expect(
      testing.parseConfigTargetMappings([
        "channels.telegram.botToken=channels/telegram/botToken",
        "auth-profiles:main:profiles.openai:default.key=providers/openai/apiKey",
      ]),
    ).toEqual([
      {
        path: "channels.telegram.botToken",
        secretId: "channels/telegram/botToken",
      },
      {
        path: "profiles.openai:default.key",
        agentId: "main",
        secretId: "providers/openai/apiKey",
      },
    ]);
  });

  it("rejects duplicate model provider targets", () => {
    expect(() =>
      testing.collectProviderSecrets({
        openaiId: "providers/openai/apiKey",
        providerKey: ["OpenAI=providers/openai/other"],
      }),
    ).toThrow("Duplicate model provider id in Vault setup: OpenAI");
  });

  it("rejects traversal segments in Vault secret ids", () => {
    expect(() => testing.parseProviderKeyMappings(["openai=providers/../openai/apiKey"])).toThrow(
      "Invalid --provider-key openai Vault secret id",
    );
  });

  it.each([
    "providers/openai/apiKey/",
    "/providers/openai/apiKey",
    "providers//openai/apiKey",
    "apiKey",
  ])("rejects non-canonical Vault secret id %s", (secretId) => {
    expect(() => testing.parseProviderKeyMappings([`openai=${secretId}`])).toThrow(
      "Invalid --provider-key openai Vault secret id",
    );
  });

  it("rejects unsupported config target paths", () => {
    expect(() =>
      testing.createConfigSecretTarget({
        providerAlias: "vault",
        path: "secrets.github_pat",
        secretId: "github/pat",
      }),
    ).toThrow("Unknown or unsupported Vault setup target path: secrets.github_pat");
  });

  it("rejects duplicate config target paths", () => {
    expect(() =>
      testing.buildPlan({
        providerAlias: "vault",
        providerConfig: testing.buildProviderConfig(),
        providerSecrets: [
          {
            providerId: "openai",
            secretId: "providers/openai/apiKey",
          },
        ],
        configTargetSecrets: [
          {
            path: "models.providers.openai.apiKey",
            secretId: "providers/openai/other",
          },
        ],
      }),
    ).toThrow("Duplicate secret target path in Vault setup: models.providers.openai.apiKey");
  });

  it("discovers a configured custom Vault provider alias for status", () => {
    expect(
      testing.resolveStatusProviderAlias({
        secrets: {
          providers: {
            "corp-vault": {
              source: "exec",
              pluginIntegration: {
                pluginId: "vault",
                integrationId: "vault",
              },
            },
          },
        },
      }),
    ).toBe("corp-vault");
  });

  it("requires an explicit status alias when multiple Vault providers are configured", () => {
    const config = {
      secrets: {
        providers: {
          "corp-vault": {
            source: "exec" as const,
            pluginIntegration: {
              pluginId: "vault",
              integrationId: "vault",
            },
          },
          "prod-vault": {
            source: "exec" as const,
            pluginIntegration: {
              pluginId: "vault",
              integrationId: "vault",
            },
          },
        },
      },
    };

    expect(() => testing.resolveStatusProviderAlias(config)).toThrow(
      "Multiple Vault provider aliases are configured (corp-vault, prod-vault)",
    );
    expect(testing.resolveStatusProviderAlias(config, "prod-vault")).toBe("prod-vault");
  });

  it("reports the packaged resolver path when the CLI is bundled", async () => {
    const baseUrl = pathToFileURL("/app/dist/index.js").href;
    const [, bundledPath] = testing.resolverScriptPathCandidates(baseUrl);

    await expect(
      testing.resolveResolverScriptPath(baseUrl, async (filePath) => filePath === bundledPath),
    ).resolves.toBe(bundledPath);
  });
});
