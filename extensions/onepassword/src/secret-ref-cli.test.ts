import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeOnePasswordSecretId } from "../onepassword-secret-id.js";
import { registerOnePasswordSecretRefCommands, testing } from "./secret-ref-cli.js";

function captureStdout() {
  let output = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });
  return () => output;
}

function createProgram(config: OpenClawConfig): Command {
  const program = new Command().exitOverride();
  const onepassword = program.command("onepassword");
  registerOnePasswordSecretRefCommands({ command: onepassword, config });
  return program;
}

async function runStatus(
  config: OpenClawConfig,
  args: string[] = [],
): Promise<Record<string, unknown>> {
  const output = captureStdout();
  await createProgram(config).parseAsync(
    ["onepassword", "secretref", "status", "--json", ...args],
    {
      from: "user",
    },
  );
  return JSON.parse(output()) as Record<string, unknown>;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("1Password CLI helpers", () => {
  it("builds a secrets apply plan for model provider API keys", () => {
    const plan = testing.buildPlan({
      providerAlias: "onepassword",
      providerConfig: testing.buildProviderConfig(),
      providerSecrets: [
        {
          providerId: "anthropic",
          secretId: "op://openclaw/Anthropic/credential",
        },
        {
          providerId: "openrouter",
          secretId: "openclaw/OpenRouter/credential",
        },
      ],
    });

    expect(plan.providerUpserts.onepassword).toEqual({
      source: "exec",
      pluginIntegration: {
        pluginId: "onepassword",
        integrationId: "onepassword",
      },
    });
    expect(plan.targets).toEqual([
      {
        type: "models.providers.apiKey",
        path: "models.providers.anthropic.apiKey",
        pathSegments: ["models", "providers", "anthropic", "apiKey"],
        providerId: "anthropic",
        ref: {
          source: "exec",
          provider: "onepassword",
          id: "op://openclaw/Anthropic/credential",
        },
      },
      {
        type: "models.providers.apiKey",
        path: "models.providers.openrouter.apiKey",
        pathSegments: ["models", "providers", "openrouter", "apiKey"],
        providerId: "openrouter",
        ref: {
          source: "exec",
          provider: "onepassword",
          id: "openclaw/OpenRouter/credential",
        },
      },
    ]);
  });

  it("builds a secrets apply plan for arbitrary known openclaw secret targets", () => {
    const plan = testing.buildPlan({
      providerAlias: "onepassword",
      providerConfig: testing.buildProviderConfig(),
      providerSecrets: [],
      configTargetSecrets: testing.parseConfigTargetMappings([
        "channels.telegram.botToken=op://openclaw/Telegram/botToken",
        "models.providers.openai.headers.x-api-key=op://openclaw/OpenAI/proxyKey",
        "auth-profiles:main:profiles.openai.key=op://openclaw/OpenAI/credential",
      ]),
    });

    expect(plan.targets).toEqual([
      {
        type: "channels.telegram.botToken",
        path: "channels.telegram.botToken",
        pathSegments: ["channels", "telegram", "botToken"],
        ref: {
          source: "exec",
          provider: "onepassword",
          id: "op://openclaw/Telegram/botToken",
        },
      },
      {
        type: "models.providers.headers",
        path: "models.providers.openai.headers.x-api-key",
        pathSegments: ["models", "providers", "openai", "headers", "x-api-key"],
        providerId: "openai",
        ref: {
          source: "exec",
          provider: "onepassword",
          id: "op://openclaw/OpenAI/proxyKey",
        },
      },
      {
        type: "auth-profiles.api_key.key",
        path: "profiles.openai.key",
        pathSegments: ["profiles", "openai", "key"],
        agentId: "main",
        ref: {
          source: "exec",
          provider: "onepassword",
          id: "op://openclaw/OpenAI/credential",
        },
      },
    ]);
  });

  it("parses custom provider mappings", () => {
    expect(testing.parseProviderKeyMappings(["xai=op://openclaw/xAI/credential"])).toEqual([
      {
        providerId: "xai",
        secretId: "op://openclaw/xAI/credential",
      },
    ]);
  });

  it("accepts native 1Password refs with spaces and encoded selectors", () => {
    const nativeRef = "op://Personal/OpenClaw QA API Key/password?attribute=value%20one";
    expect(testing.parseProviderKeyMappings([`openai=${nativeRef}`])).toEqual([
      {
        providerId: "openai",
        secretId: encodeOnePasswordSecretId(nativeRef),
      },
    ]);
  });

  it("parses config target mappings", () => {
    expect(
      testing.parseConfigTargetMappings([
        "channels.telegram.botToken=op://openclaw/Telegram/botToken",
        "auth-profiles:main:profiles.openai.key=op://openclaw/OpenAI/credential",
      ]),
    ).toEqual([
      {
        path: "channels.telegram.botToken",
        secretId: "op://openclaw/Telegram/botToken",
      },
      {
        path: "profiles.openai.key",
        agentId: "main",
        secretId: "op://openclaw/OpenAI/credential",
      },
    ]);
  });

  it("rejects duplicate model providers", () => {
    expect(() =>
      testing.collectProviderSecrets({
        openaiId: "op://openclaw/OpenAI/credential",
        providerKey: ["openai=op://openclaw/OpenAI/other"],
      }),
    ).toThrow("Duplicate model provider id in 1Password setup: openai");
  });

  it("rejects traversal segments in SecretRef ids", () => {
    expect(() => testing.parseProviderKeyMappings(["openai=op://openclaw/../credential"])).toThrow(
      "Invalid --provider-key openai 1Password SecretRef id",
    );
  });

  it("rejects invalid 1Password references before encoding", () => {
    for (const id of ["/absolute/path", "op://openclaw\\OpenAI\\credential", "op://vault/clé"]) {
      expect(() => testing.parseProviderKeyMappings([`openai=${id}`])).toThrow(
        "Invalid --provider-key openai 1Password SecretRef id",
      );
    }
  });

  it("rejects unsupported config target paths", () => {
    expect(() =>
      testing.createConfigSecretTarget({
        providerAlias: "onepassword",
        path: "secrets.github_pat",
        secretId: "op://openclaw/GitHub/pat",
      }),
    ).toThrow("Unknown or unsupported 1Password setup target path: secrets.github_pat");
  });

  it("rejects duplicate config target paths", () => {
    expect(() =>
      testing.buildPlan({
        providerAlias: "onepassword",
        providerConfig: testing.buildProviderConfig(),
        providerSecrets: [
          {
            providerId: "openai",
            secretId: "op://openclaw/OpenAI/credential",
          },
        ],
        configTargetSecrets: [
          {
            path: "models.providers.openai.apiKey",
            secretId: "op://openclaw/OpenAI/other",
          },
        ],
      }),
    ).toThrow("Duplicate secret target path in 1Password setup: models.providers.openai.apiKey");
  });

  it("creates plan files exclusively with owner-only permissions", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-1password-plan-test-"));
    const planPath = path.join(tempDir, "plan.json");
    const plan = testing.buildPlan({
      providerAlias: "onepassword",
      providerConfig: testing.buildProviderConfig(),
      providerSecrets: [],
    });
    try {
      await testing.writePlanFile(plan, planPath);
      expect((await fs.stat(planPath)).mode & 0o777).toBe(0o600);
      await expect(testing.writePlanFile(plan, planPath)).rejects.toThrow(
        "Plan path already exists",
      );

      const symlinkPath = path.join(tempDir, "symlink.json");
      await fs.symlink(planPath, symlinkPath);
      await expect(testing.writePlanFile(plan, symlinkPath)).rejects.toThrow(
        "Plan path already exists",
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("1Password CLI status", () => {
  it("discovers a configured custom provider alias", async () => {
    const result = await runStatus({
      secrets: {
        providers: {
          "corp-onepassword": {
            source: "exec",
            pluginIntegration: { pluginId: "onepassword", integrationId: "onepassword" },
          },
        },
      },
    });
    expect(result.providerAlias).toBe("corp-onepassword");
  });

  it("requires an explicit alias when multiple providers are configured", async () => {
    const config: OpenClawConfig = {
      secrets: {
        providers: Object.fromEntries(
          ["corp-onepassword", "prod-onepassword"].map((alias) => [
            alias,
            {
              source: "exec",
              pluginIntegration: { pluginId: "onepassword", integrationId: "onepassword" },
            },
          ]),
        ),
      },
    };
    await expect(runStatus(config)).rejects.toThrow("Multiple 1Password provider aliases");
    expect((await runStatus(config, ["--provider-alias", "prod-onepassword"])).providerAlias).toBe(
      "prod-onepassword",
    );
  });
});
