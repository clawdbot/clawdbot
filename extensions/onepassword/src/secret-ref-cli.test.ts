import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeOnePasswordSecretId } from "../onepassword-secret-id.js";
import { registerOnePasswordSecretRefCommands, testing } from "./secret-ref-cli.js";

type OnePasswordPlan = {
  providerUpserts: Record<string, unknown>;
  targets: Array<Record<string, unknown>>;
};

function captureStdout() {
  let output = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });
  return () => output;
}

function createProgram(config: OpenClawConfig = {}): Command {
  const program = new Command().exitOverride();
  const onepassword = program.command("onepassword");
  registerOnePasswordSecretRefCommands({
    command: onepassword,
    config,
    tokenFile: path.join(os.tmpdir(), "openclaw-onepassword-missing-token"),
    env: { PATH: "" },
  });
  return program;
}

async function runStatus(
  config: OpenClawConfig,
  args: string[] = [],
): Promise<Record<string, unknown>> {
  const output = captureStdout();
  await createProgram(config).parseAsync(
    ["onepassword", "secretref", "status", "--json", ...args],
    { from: "user" },
  );
  return JSON.parse(output()) as Record<string, unknown>;
}

async function runSetup(planPath: string, args: string[]): Promise<string> {
  const output = captureStdout();
  await createProgram().parseAsync(
    ["onepassword", "secretref", "setup", "--plan-out", planPath, ...args],
    { from: "user" },
  );
  return output();
}

async function createSetupPlan(args: string[]): Promise<OnePasswordPlan> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-onepassword-cli-"));
  const planPath = path.join(dir, "plan.json");
  try {
    await runSetup(planPath, args);
    return JSON.parse(await fs.readFile(planPath, "utf8")) as OnePasswordPlan;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("1Password SecretRef setup", () => {
  it("builds provider config and model API-key targets", async () => {
    const plan = await createSetupPlan([
      "--anthropic-id",
      "op://openclaw/Anthropic/credential",
      "--openrouter-id",
      "openclaw/OpenRouter/credential",
      "--provider-key",
      "xai=op://openclaw/xAI/credential",
    ]);

    expect(plan.providerUpserts.onepassword).toEqual({
      source: "exec",
      pluginIntegration: { pluginId: "onepassword", integrationId: "onepassword" },
    });
    expect(plan.targets).toEqual([
      expect.objectContaining({
        type: "models.providers.apiKey",
        providerId: "anthropic",
        ref: { source: "exec", provider: "onepassword", id: "op://openclaw/Anthropic/credential" },
      }),
      expect.objectContaining({ providerId: "openrouter" }),
      expect.objectContaining({ providerId: "xai" }),
    ]);
  });

  it("builds arbitrary known OpenClaw and auth-profile targets", async () => {
    const plan = await createSetupPlan([
      "--target",
      "channels.telegram.botToken=op://openclaw/Telegram/botToken",
      "--target",
      "models.providers.openai.headers.x-api-key=op://openclaw/OpenAI/proxyKey",
      "--target",
      "auth-profiles:main:profiles.openai.key=op://openclaw/OpenAI/credential",
    ]);

    expect(plan.targets).toEqual([
      expect.objectContaining({
        type: "channels.telegram.botToken",
        path: "channels.telegram.botToken",
      }),
      expect.objectContaining({
        type: "models.providers.headers",
        providerId: "openai",
      }),
      expect.objectContaining({
        type: "auth-profiles.api_key.key",
        path: "profiles.openai.key",
        agentId: "main",
      }),
    ]);
  });

  it("encodes native 1Password refs with spaces and selectors", async () => {
    const nativeRef = "op://Personal/OpenClaw QA API Key/password?attribute=value%20one";
    const plan = await createSetupPlan(["--provider-key", `openai=${nativeRef}`]);
    expect(plan.targets[0]).toMatchObject({
      providerId: "openai",
      ref: { id: encodeOnePasswordSecretId(nativeRef) },
    });
  });

  it.each([
    [
      "duplicate providers",
      [
        "--openai-id",
        "op://openclaw/OpenAI/credential",
        "--provider-key",
        "OpenAI=op://openclaw/OpenAI/other",
      ],
      "Duplicate model provider id",
    ],
    [
      "non-canonical auth-profile agent ids",
      ["--target", "auth-profiles:../main:profiles.openai.key=op://openclaw/OpenAI/credential"],
      "Invalid --target auth-profiles target for 1Password",
    ],
    [
      "traversal secret ids",
      ["--provider-key", "openai=op://openclaw/../credential"],
      "Invalid --provider-key openai 1Password SecretRef id",
    ],
    [
      "unsupported targets",
      ["--target", "secrets.github_pat=op://openclaw/GitHub/pat"],
      "Unknown or unsupported 1Password setup target path",
    ],
    [
      "duplicate target paths",
      [
        "--openai-id",
        "op://openclaw/OpenAI/credential",
        "--target",
        "models.providers.openai.apiKey=op://openclaw/OpenAI/other",
      ],
      "Duplicate secret target path",
    ],
    ["empty plans", [], "No SecretRef targets selected"],
  ])("rejects %s", async (_label, args, message) => {
    await expect(createSetupPlan(args)).rejects.toThrow(message);
  });

  it.each(["/absolute/path", "op://openclaw\\OpenAI\\credential", "op://vault/clé"])(
    "rejects invalid 1Password ref %s",
    async (id) => {
      await expect(createSetupPlan(["--provider-key", `openai=${id}`])).rejects.toThrow(
        "Invalid --provider-key openai 1Password SecretRef id",
      );
    },
  );

  it("prints a quoted canonical plan path after the readiness command", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-1password-setup-test-"));
    const planPath = path.join(tempDir, "plan with spaces.json");
    const canonicalPlanPath = path.join(await fs.realpath(tempDir), "plan with spaces.json");
    try {
      const output = await runSetup(planPath, ["--openai-id", "op://openclaw/OpenAI/credential"]);
      expect(output).toContain("openclaw onepassword secretref status");
      expect(output).toContain(
        `openclaw secrets apply --from '${canonicalPlanPath}' --dry-run --allow-exec`,
      );
      expect(output).toContain(`openclaw secrets apply --from '${canonicalPlanPath}' --allow-exec`);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "rejects plan output in a directory writable by another account",
    async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-secret-plan-test-"));
      const planPath = path.join(tempDir, "plan.json");
      try {
        await fs.chmod(tempDir, 0o777);
        await expect(
          runSetup(planPath, ["--openai-id", "op://openclaw/OpenAI/credential"]),
        ).rejects.toThrow("path is writable by another user");
        await expect(fs.stat(planPath)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await fs.chmod(tempDir, 0o700);
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "writes through the canonical directory instead of a replaceable alias",
    async () => {
      const trustedDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-secret-plan-trusted-"));
      const aliasParent = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-secret-plan-alias-"));
      const aliasDir = path.join(aliasParent, "output");
      const canonicalPlanPath = path.join(await fs.realpath(trustedDir), "plan.json");
      try {
        await fs.symlink(trustedDir, aliasDir);
        await fs.chmod(aliasParent, 0o777);
        const output = await runSetup(path.join(aliasDir, "plan.json"), [
          "--openai-id",
          "op://openclaw/OpenAI/credential",
        ]);
        expect(output).toContain(`Plan written to ${canonicalPlanPath}`);
        expect(JSON.parse(await fs.readFile(canonicalPlanPath, "utf8"))).toMatchObject({
          version: 1,
        });
      } finally {
        await fs.chmod(aliasParent, 0o700);
        await fs.rm(aliasParent, { recursive: true, force: true });
        await fs.rm(trustedDir, { recursive: true, force: true });
      }
    },
  );
});

describe("1Password readiness", () => {
  it("reports trusted executable and token prerequisites without exposing the token", async () => {
    const resolveTrustedCli = vi.fn(async () => "/trusted/op");
    const readTokenFile = vi.fn(() => "not-a-real-service-account-token");
    await expect(
      testing.inspectSecretRefReadiness(
        {
          env: { CLAW_1PASSWORD_OP: "/trusted/op", PATH: "/bin" },
          tokenFile: "/state/credentials/onepassword/service-account-token",
        },
        { resolveTrustedCli, readTokenFile },
      ),
    ).resolves.toEqual({
      opCommand: "/trusted/op",
      opBinaryPath: "/trusted/op",
      opStatus: "ready",
      tokenFile: "/state/credentials/onepassword/service-account-token",
      tokenFileStatus: "ready",
      prerequisitesReady: true,
    });
    expect(resolveTrustedCli).toHaveBeenCalledWith({
      configuredPath: "/trusted/op",
      pathEnv: "/bin",
    });
    expect(readTokenFile).toHaveBeenCalledWith(
      "/state/credentials/onepassword/service-account-token",
    );
  });

  it("reports untrusted op and unsafe token prerequisites", async () => {
    await expect(
      testing.inspectSecretRefReadiness(
        { env: { CLAW_1PASSWORD_OP: "op", PATH: "/bin" }, tokenFile: "/missing-token" },
        {
          resolveTrustedCli: async () => {
            throw new Error("unsafe path detail");
          },
          readTokenFile: () => {
            throw new Error("unsafe token detail");
          },
        },
      ),
    ).resolves.toEqual({
      opCommand: "op",
      opBinaryPath: null,
      opStatus: "untrusted",
      tokenFile: "/missing-token",
      tokenFileStatus: "missing-or-unsafe",
      prerequisitesReady: false,
    });
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
    expect(result).toMatchObject({
      providerAlias: "corp-onepassword",
      providerReady: true,
      opStatus: "not-found",
      tokenFileStatus: "missing-or-unsafe",
      prerequisitesReady: false,
      ready: false,
      issues: ["op-not-found", "token-file-missing-or-unsafe"],
    });
  });

  it("prefers the managed integration when the default alias is unrelated", async () => {
    const result = await runStatus({
      secrets: {
        providers: {
          onepassword: { source: "exec", command: "/legacy/resolver" },
          "corp-onepassword": {
            source: "exec",
            pluginIntegration: { pluginId: "onepassword", integrationId: "onepassword" },
          },
        },
      },
    });
    expect(result).toMatchObject({ providerAlias: "corp-onepassword", providerReady: true });
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
