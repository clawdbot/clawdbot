import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CliBackendPlugin } from "openclaw/plugin-sdk/cli-backend";
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import { buildGoogleGeminiCliBackend } from "./cli-backend.js";
import setupEntry from "./setup-api.js";

type GeminiPrepareContext = Parameters<
  NonNullable<ReturnType<typeof buildGoogleGeminiCliBackend>["prepareExecution"]>
>[0] & {
  env?: Record<string, string>;
  authCredential?: {
    type: "api_key" | "oauth" | "token";
    provider: string;
    access?: string;
    refresh?: string;
    expires?: number;
    idToken?: string;
    projectId?: string;
    key?: string;
    email?: string;
  };
};
type GeminiPreparedExecution = Awaited<
  ReturnType<NonNullable<ReturnType<typeof buildGoogleGeminiCliBackend>["prepareExecution"]>>
>;

async function stageGeminiPreparedExecution(
  prepared: GeminiPreparedExecution | null | undefined,
): Promise<void> {
  await prepared?.beforeExecution?.();
}

function buildGeminiOAuthPrepareContext(workspaceDir: string): GeminiPrepareContext {
  const agentDir = path.join(workspaceDir, "agent");
  return {
    workspaceDir,
    agentDir,
    provider: "google-gemini-cli",
    modelId: "gemini-3.1-pro-preview",
    authProfileId: "google-gemini-cli:user@example.test",
    // Private bundled-runtime bridge, not public Plugin SDK surface.
    authCredential: {
      type: "oauth",
      provider: "google-gemini-cli",
      access: "access-token",
      refresh: "refresh-token",
      expires: 1_800_000_000_000,
      idToken: "id-token",
      projectId: "profile-project",
      email: "user@example.test",
    },
  };
}

function buildGeminiApiKeyPrepareContext(workspaceDir: string): GeminiPrepareContext {
  const agentDir = path.join(workspaceDir, "agent");
  return {
    workspaceDir,
    agentDir,
    provider: "google-gemini-cli",
    modelId: "gemini-3.1-flash-lite",
    authProfileId: "google:api-key",
    // Private bundled-runtime bridge, not public Plugin SDK surface.
    authCredential: {
      type: "api_key",
      provider: "google",
      key: "gemini-api-key",
      email: "user@example.test",
    },
  };
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

describe("google setup entry", () => {
  it("registers setup runtime providers declared by the manifest", () => {
    const providerIds: string[] = [];
    const cliBackendIds: string[] = [];

    setupEntry.register({
      registerProvider(provider: ProviderPlugin) {
        providerIds.push(provider.id);
      },
      registerCliBackend(backend: CliBackendPlugin) {
        cliBackendIds.push(backend.id);
      },
    } as never);

    expect(providerIds).toEqual(["google-vertex"]);
    expect(cliBackendIds).toEqual(["google-gemini-cli"]);
  });
});

describe("google gemini cli backend config", () => {
  it.each([
    {
      phase: "fresh",
      key: "args" as const,
      expected: [
        "--skip-trust",
        "--approval-mode",
        "auto_edit",
        "--output-format",
        "stream-json",
        "--prompt",
        "{prompt}",
      ],
    },
    {
      phase: "resume",
      key: "resumeArgs" as const,
      expected: [
        "--skip-trust",
        "--approval-mode",
        "auto_edit",
        "--resume",
        "{sessionId}",
        "--output-format",
        "stream-json",
        "--prompt",
        "{prompt}",
      ],
    },
  ])("preserves the legacy $phase command bytes in plugin code", ({ key, expected }) => {
    const backend = buildGoogleGeminiCliBackend();

    expect(backend.config.command).toBe("gemini");
    expect(backend.config[key]).toEqual(expected);
    expect(backend.config.env).toBeUndefined();
    expect(backend.config.clearEnv).toBeUndefined();
  });

  it("declares its bundled package implementation boundary", () => {
    const backend = buildGoogleGeminiCliBackend();
    expect(backend.runtimeArtifact).toEqual({
      kind: "bundled-package-tree",
      packageName: "@google/gemini-cli",
      entrypoint: "command",
    });
    expect(backend.nativeToolMode).toBe("selectable");
    expect(backend.toolAvailabilityEnforcement).toBe("prepare-execution");
  });

  it("keeps legacy json output overrides on the json parser", () => {
    const backend = buildGoogleGeminiCliBackend();
    const normalized = backend.normalizeConfig?.({
      ...backend.config,
      args: ["--skip-trust", "--output-format", "json", "--prompt", "{prompt}"],
      resumeArgs: [
        "--skip-trust",
        "--resume",
        "{sessionId}",
        "--output-format=json",
        "--prompt",
        "{prompt}",
      ],
    });

    expect(normalized?.output).toBe("json");
    expect(normalized?.resumeOutput).toBe("json");
    expect(normalized?.jsonlDialect).toBeUndefined();
  });

  it("keeps short stream-json output overrides on the jsonl parser", () => {
    const backend = buildGoogleGeminiCliBackend();
    const normalized = backend.normalizeConfig?.({
      ...backend.config,
      args: ["--skip-trust", "-o", "stream-json", "--prompt", "{prompt}"],
      resumeArgs: [
        "--skip-trust",
        "--resume",
        "{sessionId}",
        "-o=stream-json",
        "--prompt",
        "{prompt}",
      ],
    });

    expect(normalized?.output).toBe("jsonl");
    expect(normalized?.resumeOutput).toBe("jsonl");
    expect(normalized?.jsonlDialect).toBe("gemini-stream-json");
  });
});

describe("google gemini cli backend auth bridge", () => {
  it.each([
    { auth: "ambient", allowed: ["memory_search"] },
    { auth: "ambient", allowed: [] },
    { auth: "oauth", allowed: ["memory_search"] },
    { auth: "oauth", allowed: [] },
    { auth: "api-key", allowed: ["memory_search"] },
    { auth: "api-key", allowed: [] },
  ] as const)(
    "enforces exact system policy for $auth auth with $allowed",
    async ({ auth, allowed }) => {
      await withTempDir("openclaw-test-workspace-", async (workspaceDir) => {
        const backend = buildGoogleGeminiCliBackend();
        const inheritedSettingsPath = path.join(workspaceDir, "generated-mcp-settings.json");
        await fs.writeFile(
          inheritedSettingsPath,
          `${JSON.stringify({
            tools: {
              core: ["run_shell_command"],
              allowed: ["*"],
              discoveryCommand: "hostile-discovery",
              callCommand: "hostile-call",
            },
            mcp: { allowed: ["openclaw", "hostile"], serverCommand: "hostile-mcp" },
            mcpServers: {
              openclaw: {
                url: "http://127.0.0.1:23119/mcp",
                headers: { authorization: "Bearer loopback-token" },
              },
              hostile: { command: "hostile-server" },
            },
            experimental: { enableAgents: true },
            agents: {
              overrides: {
                codebase_investigator: { enabled: true, custom: "preserved" },
                cli_help: { enabled: true },
              },
            },
            hooksConfig: { enabled: true, marker: "preserved" },
            skills: { enabled: true, marker: "preserved" },
          })}\n`,
          "utf8",
        );
        const context: GeminiPrepareContext =
          auth === "oauth"
            ? buildGeminiOAuthPrepareContext(workspaceDir)
            : auth === "api-key"
              ? buildGeminiApiKeyPrepareContext(workspaceDir)
              : {
                  workspaceDir,
                  provider: "google-gemini-cli",
                  modelId: "gemini-3.1-pro-preview",
                };
        context.env = { GEMINI_CLI_SYSTEM_SETTINGS_PATH: inheritedSettingsPath };
        context.toolAvailability = {
          native: [],
          openClaw: [...allowed],
          mcp: allowed.map((toolName) => `mcp__openclaw__${toolName}`),
        };
        const prepared = await backend.prepareExecution?.(context);
        try {
          expect(prepared?.toolAvailabilityEnforced).toBe(true);
          await stageGeminiPreparedExecution(prepared);
          const systemSettingsPath = prepared?.env?.GEMINI_CLI_SYSTEM_SETTINGS_PATH;
          expect(systemSettingsPath).toBeTruthy();
          const settings = JSON.parse(await fs.readFile(systemSettingsPath ?? "", "utf8")) as {
            tools?: {
              core?: string[];
              discoveryCommand?: string;
              callCommand?: string;
            };
            mcp?: { allowed?: string[]; serverCommand?: string };
            mcpServers?: Record<string, Record<string, unknown>>;
            experimental?: { enableAgents?: boolean };
            agents?: { overrides?: Record<string, Record<string, unknown>> };
            hooksConfig?: Record<string, unknown>;
            skills?: Record<string, unknown>;
            security?: { auth?: { selectedType?: string } };
          };
          expect(settings.tools?.core).toEqual(["mcp_openclaw_*"]);
          expect(settings.tools).not.toHaveProperty("allowed");
          expect(settings.tools?.discoveryCommand).toBe("");
          expect(settings.tools?.callCommand).toBe("");
          expect(settings.mcp?.allowed).toEqual(["openclaw"]);
          expect(settings.mcp?.serverCommand).toBe("");
          expect(settings.mcpServers?.openclaw).toMatchObject({
            url: "http://127.0.0.1:23119/mcp",
            headers: { authorization: "Bearer loopback-token" },
            includeTools: [...allowed],
          });
          expect(settings.mcpServers?.hostile).toBeUndefined();
          expect(settings.experimental?.enableAgents).toBe(false);
          expect(settings.agents?.overrides?.codebase_investigator).toEqual({
            enabled: false,
            custom: "preserved",
          });
          expect(settings.agents?.overrides?.cli_help?.enabled).toBe(false);
          expect(settings.hooksConfig).toEqual({ enabled: false, marker: "preserved" });
          expect(settings.skills).toEqual({ enabled: false, marker: "preserved" });
          expect(settings.security?.auth?.selectedType).toBe(
            auth === "oauth" ? "oauth-personal" : auth === "api-key" ? "gemini-api-key" : undefined,
          );
        } finally {
          await prepared?.cleanup?.();
        }
      });
    },
  );

  it("rejects native tools because Gemini exact policy only exposes OpenClaw MCP", async () => {
    await withTempDir("openclaw-test-workspace-", async (workspaceDir) => {
      const inheritedSettingsPath = path.join(workspaceDir, "generated-mcp-settings.json");
      await fs.writeFile(
        inheritedSettingsPath,
        JSON.stringify({ mcpServers: { openclaw: { url: "http://127.0.0.1/mcp" } } }),
        "utf8",
      );
      await expect(
        buildGoogleGeminiCliBackend().prepareExecution?.({
          workspaceDir,
          provider: "google-gemini-cli",
          modelId: "gemini-3.1-pro-preview",
          env: { GEMINI_CLI_SYSTEM_SETTINGS_PATH: inheritedSettingsPath },
          toolAvailability: { native: ["run_shell_command"], openClaw: [], mcp: [] },
        }),
      ).rejects.toThrow("cannot expose backend-native tools");
    });
  });

  it("materializes selected OpenClaw OAuth credentials into a persistent profile-scoped Gemini CLI home", async () => {
    const backend = buildGoogleGeminiCliBackend();
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-test-workspace-"));
    let home: string | undefined;
    const cleanups: Array<() => Promise<void>> = [];

    try {
      const context = buildGeminiOAuthPrepareContext(workspaceDir);
      const inheritedSettingsPath = path.join(workspaceDir, "generated-mcp-settings.json");
      await fs.writeFile(
        inheritedSettingsPath,
        `${JSON.stringify({
          security: {
            auth: {
              selectedType: "vertex-ai",
              enforcedType: "oauth-personal",
              useExternal: true,
            },
          },
          mcp: { allowed: ["openclaw"] },
          mcpServers: { openclaw: { url: "http://127.0.0.1:23119/mcp" } },
        })}\n`,
        "utf8",
      );
      context.env = { GEMINI_CLI_SYSTEM_SETTINGS_PATH: inheritedSettingsPath };
      const prepared = await backend.prepareExecution?.(context);
      if (prepared?.cleanup) {
        cleanups.push(prepared.cleanup);
      }
      await stageGeminiPreparedExecution(prepared);

      home = prepared?.env?.GEMINI_CLI_HOME;
      const systemSettingsPath = prepared?.env?.GEMINI_CLI_SYSTEM_SETTINGS_PATH;
      expect(home).toBeTruthy();
      expect(systemSettingsPath).toBeTruthy();
      expect(systemSettingsPath).not.toBe(inheritedSettingsPath);
      expect(path.dirname(systemSettingsPath ?? "")).not.toBe(home);
      expect(
        path.relative(resolvePreferredOpenClawTmpDir(), path.dirname(systemSettingsPath ?? "")),
      ).toMatch(/^openclaw-gemini-cli-/);
      expect(prepared?.env?.GEMINI_FORCE_FILE_STORAGE).toBe("true");
      expect(prepared?.env?.GOOGLE_CLOUD_PROJECT).toBe("profile-project");
      expect(prepared?.env?.GOOGLE_CLOUD_PROJECT_ID).toBe("profile-project");
      expect(prepared?.env?.GOOGLE_CLOUD_QUOTA_PROJECT).toBe("profile-project");
      if (!context.agentDir) {
        throw new Error("expected Gemini test context to include an agent directory");
      }
      expect(home).toContain(path.join(context.agentDir, "google-gemini-cli-home"));
      expect(home).not.toContain("user@example.test");

      const raw = await fs.readFile(path.join(home ?? "", ".gemini", "oauth_creds.json"), "utf8");
      expect(JSON.parse(raw)).toEqual({
        access_token: "access-token",
        refresh_token: "refresh-token",
        id_token: "id-token",
        expiry_date: 1_800_000_000_000,
        token_type: "Bearer",
      });
      const nestedSettingsRaw = await fs.readFile(
        path.join(home ?? "", ".gemini", "settings.json"),
        "utf8",
      );
      const rootSettingsRaw = await fs.readFile(path.join(home ?? "", "settings.json"), "utf8");
      expect(JSON.parse(nestedSettingsRaw)).toEqual({
        security: { auth: { selectedType: "oauth-personal" } },
      });
      expect(JSON.parse(rootSettingsRaw)).toEqual(JSON.parse(nestedSettingsRaw));
      const systemSettingsRaw = await fs.readFile(systemSettingsPath ?? "", "utf8");
      expect(JSON.parse(systemSettingsRaw)).toEqual({
        security: {
          auth: {
            selectedType: "oauth-personal",
            enforcedType: "oauth-personal",
            useExternal: true,
          },
        },
        mcp: { allowed: ["openclaw"] },
        mcpServers: { openclaw: { url: "http://127.0.0.1:23119/mcp" } },
      });

      const sessionMarker = path.join(home ?? "", ".gemini", "session-state.json");
      await fs.writeFile(sessionMarker, '{"keep":true}\n', "utf8");
      const cachedCredentialsPath = path.join(home ?? "", ".gemini", "gemini-credentials.json");
      await fs.writeFile(cachedCredentialsPath, "stale-cache", "utf8");

      const preparedAgain = await backend.prepareExecution?.(context);
      if (preparedAgain?.cleanup) {
        cleanups.push(preparedAgain.cleanup);
      }
      await stageGeminiPreparedExecution(preparedAgain);
      expect(preparedAgain?.env?.GEMINI_CLI_HOME).toBe(home);
      await expect(fs.access(sessionMarker)).resolves.toBeUndefined();
      await expect(fs.access(cachedCredentialsPath)).rejects.toThrow();
    } finally {
      for (const cleanup of cleanups.toReversed()) {
        await cleanup();
      }
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("stages Gemini CLI JSON through same-directory atomic renames", async () => {
    await withTempDir("openclaw-test-workspace-", async (workspaceDir) => {
      const backend = buildGoogleGeminiCliBackend();
      const realRename = fs.rename.bind(fs);
      const renameCalls: Array<{ from: string; to: string }> = [];
      const renameSpy = vi
        .spyOn(fs, "rename")
        .mockImplementation(async (...args: Parameters<typeof fs.rename>) => {
          renameCalls.push({ from: String(args[0]), to: String(args[1]) });
          await realRename(...args);
        });
      let prepared: GeminiPreparedExecution | null | undefined;

      try {
        prepared = await backend.prepareExecution?.(buildGeminiOAuthPrepareContext(workspaceDir));
        await stageGeminiPreparedExecution(prepared);

        const home = prepared?.env?.GEMINI_CLI_HOME;
        const systemSettingsPath = prepared?.env?.GEMINI_CLI_SYSTEM_SETTINGS_PATH;
        if (!home || !systemSettingsPath) {
          throw new Error("expected Gemini CLI staging paths");
        }
        const expectedTargets = [
          path.join(home, ".gemini", "settings.json"),
          path.join(home, "settings.json"),
          systemSettingsPath,
          path.join(home, ".gemini", "oauth_creds.json"),
        ];
        expect(renameCalls.map((call) => call.to).toSorted()).toEqual(expectedTargets.toSorted());
        for (const call of renameCalls) {
          expect(path.dirname(call.from)).toBe(path.dirname(call.to));
          expect(path.basename(call.from).startsWith(`.${path.basename(call.to)}.`)).toBe(true);
          expect(path.basename(call.from).endsWith(".tmp")).toBe(true);
        }
        const oauthStat = await fs.stat(path.join(home, ".gemini", "oauth_creds.json"));
        expect(oauthStat.mode & 0o777).toBe(0o600);
      } finally {
        renameSpy.mockRestore();
        await prepared?.cleanup?.();
      }
    });
  });

  it("prepares selected canonical Google API-key credentials and removes stale OAuth state for that profile home", async () => {
    const backend = buildGoogleGeminiCliBackend();
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-test-workspace-"));
    let home: string | undefined;
    const cleanups: Array<() => Promise<void>> = [];

    try {
      const context = buildGeminiApiKeyPrepareContext(workspaceDir);
      const firstPrepared = await backend.prepareExecution?.(context);
      if (firstPrepared?.cleanup) {
        cleanups.push(firstPrepared.cleanup);
      }
      await stageGeminiPreparedExecution(firstPrepared);
      home = firstPrepared?.env?.GEMINI_CLI_HOME;
      expect(home).toBeTruthy();
      await fs.writeFile(path.join(home ?? "", ".gemini", "oauth_creds.json"), "{}\n", "utf8");
      await fs.writeFile(
        path.join(home ?? "", ".gemini", "gemini-credentials.json"),
        "stale-cache",
        "utf8",
      );

      const prepared = await backend.prepareExecution?.(context);
      if (prepared?.cleanup) {
        cleanups.push(prepared.cleanup);
      }
      await stageGeminiPreparedExecution(prepared);

      home = prepared?.env?.GEMINI_CLI_HOME;
      expect(home).toBeTruthy();
      expect(prepared?.env?.GEMINI_API_KEY).toBe("gemini-api-key");
      expect(prepared?.env?.GEMINI_FORCE_FILE_STORAGE).toBe("true");
      expect(prepared?.clearEnv).toContain("GEMINI_API_KEY");
      expect(prepared?.clearEnv).toContain("GOOGLE_GENAI_USE_GCA");
      expect(prepared?.clearEnv).toContain("GOOGLE_GENAI_USE_VERTEXAI");
      expect(prepared?.clearEnv).toContain("GOOGLE_GEMINI_BASE_URL");

      const settingsRaw = await fs.readFile(
        path.join(home ?? "", ".gemini", "settings.json"),
        "utf8",
      );
      expect(JSON.parse(settingsRaw)).toEqual({
        security: { auth: { selectedType: "gemini-api-key" } },
      });
      await expect(
        fs.access(path.join(home ?? "", ".gemini", "oauth_creds.json")),
      ).rejects.toThrow();
      await expect(
        fs.access(path.join(home ?? "", ".gemini", "gemini-credentials.json")),
      ).rejects.toThrow();
    } finally {
      for (const cleanup of cleanups.toReversed()) {
        await cleanup();
      }
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("rejects inherited Gemini system settings that enforce a different auth type", async () => {
    const backend = buildGoogleGeminiCliBackend();
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-test-workspace-"));

    try {
      const inheritedSettingsPath = path.join(workspaceDir, "generated-mcp-settings.json");
      await fs.writeFile(
        inheritedSettingsPath,
        `${JSON.stringify({
          security: { auth: { enforcedType: "gemini-api-key" } },
        })}\n`,
        "utf8",
      );
      const context = buildGeminiOAuthPrepareContext(workspaceDir);
      context.env = { GEMINI_CLI_SYSTEM_SETTINGS_PATH: inheritedSettingsPath };

      await expect(backend.prepareExecution?.(context)).rejects.toThrow(/enforce gemini-api-key/);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("inherits process Gemini system settings when no generated settings path is present", async () => {
    const backend = buildGoogleGeminiCliBackend();
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-test-workspace-"));
    const originalSystemSettingsPath = process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH;
    let prepared:
      | Awaited<ReturnType<NonNullable<typeof backend.prepareExecution>>>
      | null
      | undefined;

    try {
      const inheritedSettingsPath = path.join(workspaceDir, "ambient-system-settings.json");
      await fs.writeFile(
        inheritedSettingsPath,
        `${JSON.stringify({
          security: {
            auth: {
              selectedType: "oauth-code-assist",
              enforcedType: "oauth-personal",
            },
            folderTrust: { enabled: true },
          },
        })}\n`,
        "utf8",
      );
      process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH = inheritedSettingsPath;

      prepared = await backend.prepareExecution?.(buildGeminiOAuthPrepareContext(workspaceDir));
      await stageGeminiPreparedExecution(prepared);

      const systemSettingsRaw = await fs.readFile(
        prepared?.env?.GEMINI_CLI_SYSTEM_SETTINGS_PATH ?? "",
        "utf8",
      );
      expect(JSON.parse(systemSettingsRaw)).toEqual({
        security: {
          auth: {
            selectedType: "oauth-personal",
            enforcedType: "oauth-personal",
          },
          folderTrust: { enabled: true },
        },
      });
    } finally {
      restoreEnv("GEMINI_CLI_SYSTEM_SETTINGS_PATH", originalSystemSettingsPath);
      await prepared?.cleanup?.();
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("rejects Vercel AI Gateway profiles for the Gemini CLI backend", async () => {
    const backend = buildGoogleGeminiCliBackend();
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-test-workspace-"));

    try {
      await expect(
        backend.prepareExecution?.({
          workspaceDir,
          agentDir: path.join(workspaceDir, "agent"),
          provider: "google-gemini-cli",
          modelId: "gemini-3.1-flash-lite",
          authProfileId: "vercel-ai-gateway:default",
          authCredential: {
            type: "api_key",
            provider: "vercel-ai-gateway",
            key: "vercel-key",
          },
        } as never),
      ).rejects.toThrow(/vercel-ai-gateway auth profile/);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("rejects selected Gemini token profiles before the CLI can use ambient auth", async () => {
    const backend = buildGoogleGeminiCliBackend();
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-test-workspace-"));

    try {
      await expect(
        backend.prepareExecution?.({
          workspaceDir,
          agentDir: path.join(workspaceDir, "agent"),
          provider: "google-gemini-cli",
          modelId: "gemini-3.1-flash-lite",
          authProfileId: "google-gemini-cli:token",
          authCredential: {
            type: "token",
            provider: "google-gemini-cli",
            token: "bearer-token",
          },
        } as never),
      ).rejects.toThrow(/OAuth or API-key auth profiles/);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("rejects selected Gemini profiles with no material before the CLI can use ambient auth", async () => {
    const backend = buildGoogleGeminiCliBackend();
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-test-workspace-"));

    try {
      await expect(
        backend.prepareExecution?.({
          workspaceDir,
          agentDir: path.join(workspaceDir, "agent"),
          provider: "google-gemini-cli",
          modelId: "gemini-3.1-flash-lite",
          authProfileId: "google-gemini-cli:missing",
        } as never),
      ).rejects.toThrow(/no credential material/);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("clears inherited Gemini auth credentials when staging selected OAuth credentials", async () => {
    const backend = buildGoogleGeminiCliBackend();
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-test-workspace-"));
    const originalUseGca = process.env.GOOGLE_GENAI_USE_GCA;
    const originalCloudAccessToken = process.env.GOOGLE_CLOUD_ACCESS_TOKEN;
    const originalGoogleApplicationCredentials = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    const originalForceEncryptedFileStorage = process.env.GEMINI_FORCE_ENCRYPTED_FILE_STORAGE;
    const originalGeminiApiKey = process.env.GEMINI_API_KEY;
    const originalGoogleApiKey = process.env.GOOGLE_API_KEY;
    const originalQuotaProject = process.env.GOOGLE_CLOUD_QUOTA_PROJECT;
    let prepared:
      | Awaited<ReturnType<NonNullable<typeof backend.prepareExecution>>>
      | null
      | undefined;

    process.env.GOOGLE_GENAI_USE_GCA = "true";
    process.env.GOOGLE_CLOUD_ACCESS_TOKEN = "ambient-cloud-token";
    process.env.GOOGLE_APPLICATION_CREDENTIALS = "/tmp/ambient-google-adc.json";
    process.env.GEMINI_FORCE_ENCRYPTED_FILE_STORAGE = "true";
    process.env.GEMINI_API_KEY = "ambient-gemini-key";
    process.env.GOOGLE_API_KEY = "ambient-google-key";
    process.env.GOOGLE_CLOUD_QUOTA_PROJECT = "ambient-project";

    try {
      prepared = await backend.prepareExecution?.(buildGeminiOAuthPrepareContext(workspaceDir));

      expect(prepared?.env?.GEMINI_CLI_HOME).toBeTruthy();
      expect(prepared?.clearEnv).toEqual([
        "GOOGLE_GENAI_USE_GCA",
        "GOOGLE_CLOUD_ACCESS_TOKEN",
        "GOOGLE_APPLICATION_CREDENTIALS",
        "GEMINI_FORCE_ENCRYPTED_FILE_STORAGE",
        "GEMINI_FORCE_FILE_STORAGE",
        "GOOGLE_GENAI_USE_VERTEXAI",
        "GOOGLE_API_KEY",
        "GOOGLE_CLOUD_PROJECT",
        "GOOGLE_CLOUD_PROJECT_ID",
        "GOOGLE_CLOUD_QUOTA_PROJECT",
        "GOOGLE_CLOUD_LOCATION",
        "GOOGLE_GEMINI_BASE_URL",
        "GEMINI_CLI_CUSTOM_HEADERS",
        "GEMINI_API_KEY_AUTH_MECHANISM",
        "GEMINI_API_KEY",
        "GEMINI_CLI_SYSTEM_SETTINGS_PATH",
      ]);
    } finally {
      restoreEnv("GOOGLE_GENAI_USE_GCA", originalUseGca);
      restoreEnv("GOOGLE_CLOUD_ACCESS_TOKEN", originalCloudAccessToken);
      restoreEnv("GOOGLE_APPLICATION_CREDENTIALS", originalGoogleApplicationCredentials);
      restoreEnv("GEMINI_FORCE_ENCRYPTED_FILE_STORAGE", originalForceEncryptedFileStorage);
      restoreEnv("GEMINI_API_KEY", originalGeminiApiKey);
      restoreEnv("GOOGLE_API_KEY", originalGoogleApiKey);
      restoreEnv("GOOGLE_CLOUD_QUOTA_PROJECT", originalQuotaProject);
      await prepared?.cleanup?.();
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("requires an agent directory for profile-owned Gemini CLI state", async () => {
    const backend = buildGoogleGeminiCliBackend();
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-test-workspace-"));

    try {
      const { agentDir: _agentDir, ...context } = buildGeminiOAuthPrepareContext(workspaceDir);
      await expect(backend.prepareExecution?.(context)).rejects.toThrow(/agent directory/);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("uses profile-only auth epochs for the private Gemini CLI bridge", () => {
    const backend = buildGoogleGeminiCliBackend();

    expect(backend.authEpochMode).toBe("profile-only");
    expect(backend.prepareExecution).toBeTypeOf("function");
  });
});
