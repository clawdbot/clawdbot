import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inspectPathPermissions } from "@openclaw/fs-safe/permissions";
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
    {
      from: "user",
    },
  );
  return JSON.parse(output()) as Record<string, unknown>;
}

function createOpenAiPlan() {
  return testing.buildPlan({
    providerAlias: "onepassword",
    providerConfig: testing.buildProviderConfig(),
    providerSecrets: [{ providerId: "openai", secretId: "op://openclaw/OpenAI/credential" }],
  });
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

  it.each([
    ["posix", "/tmp/plan.json", "/tmp/plan.json"],
    ["posix", "/tmp/plan with spaces.json", "'/tmp/plan with spaces.json'"],
    ["posix", "/tmp/plan'$(touch pwn).json", "'/tmp/plan'\\''$(touch pwn).json'"],
    ["powershell", String.raw`C:\$env:TEMP\plan';.json`, String.raw`'C:\$env:TEMP\plan'';.json'`],
    ["cmd", String.raw`C:\Users\Jane Doe\plan.json`, String.raw`"C:\Users\Jane Doe\plan.json"`],
  ] satisfies Array<["cmd" | "posix" | "powershell", string, string]>)(
    "shell-quotes %s command arguments for %j",
    (shell, value, expected) => {
      expect(testing.quoteCliArg(value, shell)).toBe(expected);
    },
  );

  it("rejects line breaks in generated command arguments", () => {
    expect(() => testing.quoteCliArg("plan.json\nopenclaw secrets reload", "posix")).toThrow(
      /cannot contain CR or LF/,
    );
    expect(() => testing.quoteCliArg("plan.json\r& whoami", "cmd")).toThrow(
      /cannot contain CR or LF/,
    );
  });

  it("renders native follow-up commands for both Windows shells", () => {
    expect(testing.renderApplyCommands(String.raw`C:\Users\Jane Doe\plan;.json`, "win32")).toEqual([
      "PowerShell:",
      String.raw`  openclaw secrets apply --from 'C:\Users\Jane Doe\plan;.json' --dry-run --allow-exec`,
      String.raw`  openclaw secrets apply --from 'C:\Users\Jane Doe\plan;.json' --allow-exec`,
      "Command Prompt:",
      String.raw`  openclaw secrets apply --from "C:\Users\Jane Doe\plan;.json" --dry-run --allow-exec`,
      String.raw`  openclaw secrets apply --from "C:\Users\Jane Doe\plan;.json" --allow-exec`,
    ]);
  });

  it("omits unsafe interactive Command Prompt commands", () => {
    const commands = testing.renderApplyCommands(String.raw`C:\%TEMP%\plan!.json`, "win32");
    expect(commands).toContain(
      "Command Prompt: unavailable for paths containing % or !; use PowerShell.",
    );
    expect(commands.filter((command) => command.includes("openclaw secrets apply"))).toHaveLength(
      2,
    );
    expect(() => testing.quoteCliArg(String.raw`C:\%TEMP%\plan!.json`, "cmd")).toThrow(
      /cannot safely quote/,
    );
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

  it("rejects non-canonical auth-profile agent ids", () => {
    expect(() =>
      testing.parseConfigTargetMappings([
        "auth-profiles:../main:profiles.openai.key=op://openclaw/OpenAI/credential",
      ]),
    ).toThrow("Invalid --target auth-profiles target for 1Password");
  });

  it("rejects duplicate model providers", () => {
    expect(() =>
      testing.collectProviderSecrets({
        openaiId: "op://openclaw/OpenAI/credential",
        providerKey: ["openai=op://openclaw/OpenAI/other"],
      }),
    ).toThrow("Duplicate model provider id in 1Password setup: openai");
  });

  it("rejects setup plans without targets", () => {
    expect(() =>
      testing.buildPlan({
        providerAlias: "onepassword",
        providerConfig: testing.buildProviderConfig(),
        providerSecrets: [],
      }),
    ).toThrow("No SecretRef targets selected");
  });

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
        {
          env: { CLAW_1PASSWORD_OP: "op", PATH: "/bin" },
          tokenFile: "/missing-token",
        },
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
      testing.buildPlan({
        providerAlias: "onepassword",
        providerConfig: testing.buildProviderConfig(),
        providerSecrets: [],
        configTargetSecrets: [
          {
            path: "secrets.github_pat",
            secretId: "op://openclaw/GitHub/pat",
          },
        ],
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
    const plan = createOpenAiPlan();
    try {
      await testing.writePlanFile(plan, planPath);
      if (process.platform !== "win32") {
        expect((await fs.stat(planPath)).mode & 0o777).toBe(0o600);
      } else {
        const permissions = await inspectPathPermissions(planPath);
        expect(permissions).toMatchObject({
          ok: true,
          source: "windows-acl",
          ownerTrusted: true,
          groupReadable: false,
          groupWritable: false,
          worldReadable: false,
          worldWritable: false,
        });
      }
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

  it.skipIf(process.platform === "win32")(
    "rejects plan output in a directory writable by another account",
    async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-1password-plan-test-"));
      const planPath = path.join(tempDir, "plan.json");
      const plan = createOpenAiPlan();
      try {
        await fs.chmod(tempDir, 0o777);
        await expect(testing.writePlanFile(plan, planPath)).rejects.toThrow(
          "path is writable by another user",
        );
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
      const trustedDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "openclaw-1password-plan-trusted-"),
      );
      const aliasParent = await fs.mkdtemp(
        path.join(os.tmpdir(), "openclaw-1password-plan-alias-"),
      );
      const aliasDir = path.join(aliasParent, "output");
      const canonicalPlanPath = path.join(await fs.realpath(trustedDir), "plan.json");
      const plan = createOpenAiPlan();
      try {
        await fs.symlink(trustedDir, aliasDir);
        await fs.chmod(aliasParent, 0o777);
        await expect(testing.writePlanFile(plan, path.join(aliasDir, "plan.json"))).resolves.toBe(
          canonicalPlanPath,
        );
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

  it.skipIf(process.platform === "win32")(
    "rejects unrenderable plan paths before creating a file",
    async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-1password-plan-test-"));
      const planPath = path.join(tempDir, "plan\n.json");
      const plan = createOpenAiPlan();
      try {
        await expect(testing.writePlanFile(plan, planPath)).rejects.toThrow(
          "Command argument cannot contain CR or LF",
        );
        await expect(fs.stat(planPath)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    },
  );

  it("writes a Windows plan through the atomic private-file primitive", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-1password-plan-test-"));
    const planPath = path.join(tempDir, "plan.json");
    const plan = createOpenAiPlan();
    const createPrivateWindowsFile = vi.fn(async (filePath: string, content: string) => {
      await fs.writeFile(filePath, content, { flag: "wx" });
    });
    const resolveTrustedPlanDirectory = vi.fn(async (directoryPath: string) => directoryPath);
    try {
      await testing.writePlanFile(plan, planPath, {
        platform: "win32",
        createPrivateWindowsFile,
        resolveTrustedPlanDirectory,
      });
      expect(resolveTrustedPlanDirectory).toHaveBeenCalledWith(path.resolve(tempDir));
      expect(createPrivateWindowsFile).toHaveBeenCalledWith(planPath, expect.any(String));
      expect(JSON.parse(await fs.readFile(planPath, "utf8"))).toMatchObject({ version: 1 });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("prints the readiness check before plan application", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-1password-setup-test-"));
    const planPath = path.join(tempDir, "plan with spaces.json");
    const canonicalPlanPath = path.join(await fs.realpath(tempDir), "plan with spaces.json");
    const output = captureStdout();
    try {
      await createProgram({}).parseAsync(
        [
          "onepassword",
          "secretref",
          "setup",
          "--openai-id",
          "op://openclaw/OpenAI/credential",
          "--plan-out",
          planPath,
        ],
        { from: "user" },
      );
      expect(output()).toContain("openclaw onepassword secretref status");
      expect(output()).toContain(
        `openclaw secrets apply --from '${canonicalPlanPath}' --dry-run --allow-exec`,
      );
      expect(output()).toContain(
        `openclaw secrets apply --from '${canonicalPlanPath}' --allow-exec`,
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
    expect(result).toMatchObject({
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
    expect(result.providerAlias).toBe("corp-onepassword");
    expect(result.providerReady).toBe(true);
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
