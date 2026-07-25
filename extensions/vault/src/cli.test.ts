import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerVaultCommands } from "./cli.js";

type VaultPlan = {
  providerUpserts: Record<string, unknown>;
  targets: Array<Record<string, unknown>>;
};

function captureStdout() {
  let output = "";
  const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    output += String(chunk);
    return true;
  }) as typeof process.stdout.write);
  return {
    output: () => output,
    restore: () => writeSpy.mockRestore(),
  };
}

function createProgram(config: Record<string, unknown> = {}): Command {
  const program = new Command();
  program.exitOverride();
  registerVaultCommands({ program, config: config as never });
  return program;
}

async function createSetupPlan(args: string[]): Promise<VaultPlan> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-vault-cli-"));
  const planPath = path.join(dir, "plan.json");
  const stdout = captureStdout();
  try {
    await createProgram().parseAsync(["vault", "setup", "--plan-out", planPath, ...args], {
      from: "user",
    });
    return JSON.parse(await fs.readFile(planPath, "utf8")) as VaultPlan;
  } finally {
    stdout.restore();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function runStatus(
  config: Record<string, unknown>,
  args: string[] = [],
): Promise<Record<string, unknown>> {
  const stdout = captureStdout();
  try {
    await createProgram(config).parseAsync(["vault", "status", "--json", ...args], {
      from: "user",
    });
    return JSON.parse(stdout.output()) as Record<string, unknown>;
  } finally {
    stdout.restore();
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("vault CLI setup plan", () => {
  it("generates plugin-managed provider config and model API-key targets", async () => {
    const plan = await createSetupPlan([
      "--openai-id",
      "providers/openai/apiKey",
      "--anthropic-id",
      "providers/anthropic/apiKey",
      "--provider-key",
      "local-openai=providers/local-openai/apiKey",
    ]);

    expect(plan.providerUpserts).toEqual({
      vault: {
        source: "exec",
        pluginIntegration: { pluginId: "vault", integrationId: "vault" },
      },
    });
    expect(plan.targets).toEqual([
      expect.objectContaining({
        type: "models.providers.apiKey",
        path: "models.providers.openai.apiKey",
        providerId: "openai",
        ref: { source: "exec", provider: "vault", id: "providers/openai/apiKey" },
      }),
      expect.objectContaining({
        type: "models.providers.apiKey",
        path: "models.providers.anthropic.apiKey",
        providerId: "anthropic",
      }),
      expect.objectContaining({
        type: "models.providers.apiKey",
        path: "models.providers.local-openai.apiKey",
        providerId: "local-openai",
      }),
    ]);
  });

  it("generates arbitrary known OpenClaw and auth-profile targets", async () => {
    const plan = await createSetupPlan([
      "--target",
      "channels.telegram.botToken=channels/telegram/botToken",
      "--target",
      "models.providers.openai.headers.x-api-key=providers/openai/proxyKey",
      "--target",
      "auth-profiles:main:profiles.openai:default.key=providers/openai/apiKey",
    ]);

    expect(plan.targets).toEqual([
      expect.objectContaining({
        type: "channels.telegram.botToken",
        path: "channels.telegram.botToken",
        pathSegments: ["channels", "telegram", "botToken"],
      }),
      expect.objectContaining({
        type: "models.providers.headers",
        path: "models.providers.openai.headers.x-api-key",
        providerId: "openai",
      }),
      expect.objectContaining({
        type: "auth-profiles.api_key.key",
        path: "profiles.openai:default.key",
        agentId: "main",
      }),
    ]);
  });

  it.each([
    [
      "duplicate providers",
      ["--openai-id", "providers/openai/apiKey", "--provider-key", "OpenAI=providers/openai/other"],
      "Duplicate model provider id",
    ],
    [
      "traversal secret ids",
      ["--provider-key", "openai=providers/../openai/apiKey"],
      "Invalid --provider-key openai Vault secret id",
    ],
    [
      "unsupported targets",
      ["--target", "secrets.github_pat=github/pat"],
      "Unknown or unsupported Vault setup target path",
    ],
    [
      "duplicate target paths",
      [
        "--openai-id",
        "providers/openai/apiKey",
        "--target",
        "models.providers.openai.apiKey=providers/openai/other",
      ],
      "Duplicate secret target path",
    ],
  ])("rejects %s", async (_label, args, message) => {
    await expect(createSetupPlan(args)).rejects.toThrow(message);
  });

  it.each([
    "providers/openai/apiKey/",
    "/providers/openai/apiKey",
    "providers//openai/apiKey",
    "apiKey",
  ])("rejects non-canonical Vault secret id %s", async (secretId) => {
    await expect(createSetupPlan(["--provider-key", `openai=${secretId}`])).rejects.toThrow(
      "Invalid --provider-key openai Vault secret id",
    );
  });
});

describe("vault CLI status", () => {
  it("discovers a configured custom Vault provider alias", async () => {
    const result = await runStatus({
      secrets: {
        providers: {
          "corp-vault": {
            source: "exec",
            pluginIntegration: { pluginId: "vault", integrationId: "vault" },
          },
        },
      },
    });
    expect(result.providerAlias).toBe("corp-vault");
  });

  it("requires an explicit alias when multiple Vault providers are configured", async () => {
    const config = {
      secrets: {
        providers: Object.fromEntries(
          ["corp-vault", "prod-vault"].map((alias) => [
            alias,
            {
              source: "exec",
              pluginIntegration: { pluginId: "vault", integrationId: "vault" },
            },
          ]),
        ),
      },
    };
    await expect(runStatus(config)).rejects.toThrow("Multiple Vault provider aliases");
    expect((await runStatus(config, ["--provider-alias", "prod-vault"])).providerAlias).toBe(
      "prod-vault",
    );
  });

  it("reports the packaged resolver fallback through the status command", async () => {
    vi.spyOn(fs, "access").mockImplementation(async (filePath) => {
      if (String(filePath).includes("extensions/vault/vault-secret-ref-resolver.js")) {
        return;
      }
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });
    const result = await runStatus({});
    expect(result.resolverScript).toMatch(/extensions\/vault\/vault-secret-ref-resolver\.js$/u);
  });
});
