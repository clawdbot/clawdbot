import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CliBackendAuthProfilePreparationError } from "openclaw/plugin-sdk/cli-backend";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import { buildGoogleGeminiCliBackend } from "./cli-backend.js";

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
  isolatedCompletionCwd?: string;
  isolatedCompletionPrompt?: string;
  isolatedCompletionSystemPrompt?: string;
  isolatedCompletionModelId?: string;
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

describe("google gemini cli backend auth bridge", () => {
  it("rejects a selected OAuth profile for isolated completion", async () => {
    await withTempDir("openclaw-test-workspace-", async (workspaceDir) => {
      await expect(
        buildGoogleGeminiCliBackend().prepareExecution?.({
          ...buildGeminiOAuthPrepareContext(workspaceDir),
          toolAvailability: { native: [], openClaw: [], mcp: [] },
          isolatedCompletionModelId: "gemini-3.1-flash-preview",
          isolatedCompletionSystemPrompt: "Return only JSON.",
        } as GeminiPrepareContext),
      ).rejects.toMatchObject({
        code: "unsupported",
        message: expect.stringContaining(
          "Code Assist auth can inject administrator-required tools",
        ),
      });
    });
  });

  it("rejects a selected OAuth profile for an ordinary exact-tool turn", async () => {
    await withTempDir("openclaw-test-workspace-", async (workspaceDir) => {
      await expect(
        buildGoogleGeminiCliBackend().prepareExecution?.({
          ...buildGeminiOAuthPrepareContext(workspaceDir),
          toolAvailability: { native: [], openClaw: [], mcp: [] },
        } as GeminiPrepareContext),
      ).rejects.toThrow("Code Assist auth can inject administrator-required tools");
    });
  });

  it("rejects ambient OAuth for an ordinary exact-tool turn", async () => {
    await withTempDir("openclaw-test-workspace-", async (workspaceDir) => {
      const ambientHome = path.join(workspaceDir, "ambient-home");
      await fs.mkdir(path.join(ambientHome, ".gemini"), { recursive: true });
      await fs.writeFile(
        path.join(ambientHome, ".gemini", "settings.json"),
        `${JSON.stringify({ security: { auth: { selectedType: "oauth-personal" } } })}\n`,
      );

      await expect(
        buildGoogleGeminiCliBackend().prepareExecution?.({
          workspaceDir,
          provider: "google-gemini-cli",
          modelId: "gemini-3.1-flash-preview",
          env: { GEMINI_CLI_HOME: ambientHome },
          toolAvailability: { native: [], openClaw: [], mcp: [] },
        } as GeminiPrepareContext),
      ).rejects.toThrow("Code Assist auth can inject administrator-required tools");
    });
  });

  it("lets a prepared API-key selector override ambient Code Assist flags", async () => {
    await withTempDir("openclaw-test-workspace-", async (workspaceDir) => {
      const originalUseGca = process.env.GOOGLE_GENAI_USE_GCA;
      process.env.GOOGLE_GENAI_USE_GCA = "true";
      let prepared: GeminiPreparedExecution | null | undefined;
      try {
        prepared = await buildGoogleGeminiCliBackend().prepareExecution?.({
          workspaceDir,
          provider: "google-gemini-cli",
          modelId: "gemini-3.1-pro-preview",
          env: { GEMINI_API_KEY: "prepared-key" },
          toolAvailability: { native: [], openClaw: [], mcp: [] },
        });
        expect(prepared?.env?.GEMINI_API_KEY).toBe("prepared-key");
        expect(prepared?.env?.GOOGLE_GENAI_USE_GCA).toBe("false");
      } finally {
        restoreEnv("GOOGLE_GENAI_USE_GCA", originalUseGca);
        await prepared?.cleanup?.();
      }
    });
  });

  it("preserves only auth variables from ambient Gemini dotenv files", async () => {
    await withTempDir("openclaw-test-workspace-", async (workspaceDir) => {
      const ambientHome = path.join(workspaceDir, "ambient-home");
      const ambientGeminiDir = path.join(ambientHome, ".gemini");
      await fs.mkdir(ambientGeminiDir, { recursive: true });
      await fs.writeFile(
        path.join(ambientGeminiDir, "settings.json"),
        `${JSON.stringify({
          security: { auth: { selectedType: "gemini-api-key" } },
          privacy: { usageStatisticsEnabled: false },
        })}\n`,
      );
      await fs.writeFile(
        path.join(ambientGeminiDir, ".env"),
        'GEMINI_API_KEY="ambient-api-key"\nGEMINI_TELEMETRY_ENABLED="true"\nGEMINI_TELEMETRY_LOG_PROMPTS="true"\nUNRELATED_USER_SETTING="must-not-cross"\n',
      );
      await fs.writeFile(
        path.join(ambientHome, ".env"),
        'GOOGLE_CLOUD_PROJECT="ambient-project"\nANOTHER_SETTING="must-not-cross"\n',
      );

      const originalGeminiCliHome = process.env.GEMINI_CLI_HOME;
      process.env.GEMINI_CLI_HOME = ambientHome;
      const prepared = await buildGoogleGeminiCliBackend().prepareExecution?.({
        workspaceDir,
        provider: "google-gemini-cli",
        modelId: "gemini-3.1-flash-preview",
        toolAvailability: { native: [], openClaw: [], mcp: [] },
        isolatedCompletionModelId: "gemini-3.1-flash-preview",
        isolatedCompletionSystemPrompt: "Return only JSON.",
      } as GeminiPrepareContext);
      const isolatedHome = prepared?.env?.GEMINI_CLI_HOME ?? "";
      try {
        await stageGeminiPreparedExecution(prepared);
        expect(prepared?.env?.GEMINI_API_KEY).toBe("ambient-api-key");
        expect(prepared?.clearEnv).toContain("GEMINI_API_KEY");
        await expect(fs.access(path.join(isolatedHome, ".gemini", ".env"))).rejects.toThrow();
        await expect(fs.access(path.join(isolatedHome, ".env"))).rejects.toThrow();
        const systemSettings = JSON.parse(
          await fs.readFile(prepared?.env?.GEMINI_CLI_SYSTEM_SETTINGS_PATH ?? "", "utf8"),
        ) as Record<string, unknown>;
        expect(systemSettings).toMatchObject({
          security: { auth: { selectedType: "gemini-api-key" } },
          privacy: { usageStatisticsEnabled: false },
          telemetry: { logPrompts: false },
        });
      } finally {
        restoreEnv("GEMINI_CLI_HOME", originalGeminiCliHome);
        await prepared?.cleanup?.();
      }
    });
  });

  it("does not import auth from the untrusted project dotenv", async () => {
    await withTempDir("openclaw-test-workspace-", async (workspaceDir) => {
      const ambientHome = path.join(workspaceDir, "ambient-home");
      await fs.mkdir(path.join(ambientHome, ".gemini"), { recursive: true });
      await fs.writeFile(path.join(ambientHome, ".gemini", ".env"), 'GEMINI_API_KEY="home-key"\n');
      const projectDir = path.join(workspaceDir, "project", "nested");
      await fs.mkdir(path.join(projectDir, ".gemini"), { recursive: true });
      await fs.writeFile(
        path.join(projectDir, ".gemini", ".env"),
        'GEMINI_API_KEY="project-key"\nUNRELATED_PROJECT_SETTING="must-not-cross"\n',
      );

      const originalGeminiCliHome = process.env.GEMINI_CLI_HOME;
      process.env.GEMINI_CLI_HOME = ambientHome;
      const prepared = await buildGoogleGeminiCliBackend().prepareExecution?.({
        workspaceDir: projectDir,
        provider: "google-gemini-cli",
        modelId: "gemini-3.1-flash-preview",
        toolAvailability: { native: [], openClaw: [], mcp: [] },
        isolatedCompletionModelId: "gemini-3.1-flash-preview",
        isolatedCompletionSystemPrompt: "Return only JSON.",
      } as GeminiPrepareContext);
      try {
        await stageGeminiPreparedExecution(prepared);
        expect(prepared?.env?.GEMINI_API_KEY).toBe("home-key");
      } finally {
        restoreEnv("GEMINI_CLI_HOME", originalGeminiCliHome);
        await prepared?.cleanup?.();
      }
    });
  });

  it("rebases relative ambient Vertex credential paths to the original workspace", async () => {
    await withTempDir("openclaw-test-workspace-", async (workspaceDir) => {
      const ambientHome = path.join(workspaceDir, "ambient-home");
      await fs.mkdir(path.join(ambientHome, ".gemini"), { recursive: true });
      await fs.writeFile(
        path.join(ambientHome, ".gemini", "settings.json"),
        `${JSON.stringify({ security: { auth: { selectedType: "vertex-ai" } } })}\n`,
      );
      await fs.writeFile(
        path.join(ambientHome, ".gemini", ".env"),
        'GOOGLE_GENAI_USE_VERTEXAI="true"\nGOOGLE_APPLICATION_CREDENTIALS="./credentials.json"\n',
      );

      const originalGeminiCliHome = process.env.GEMINI_CLI_HOME;
      process.env.GEMINI_CLI_HOME = ambientHome;
      const prepared = await buildGoogleGeminiCliBackend().prepareExecution?.({
        workspaceDir,
        provider: "google-gemini-cli",
        modelId: "gemini-3.1-flash-preview",
        toolAvailability: { native: [], openClaw: [], mcp: [] },
        isolatedCompletionModelId: "gemini-3.1-flash-preview",
        isolatedCompletionSystemPrompt: "Return only JSON.",
      } as GeminiPrepareContext);
      try {
        await stageGeminiPreparedExecution(prepared);
        expect(prepared?.env?.GOOGLE_GENAI_USE_VERTEXAI).toBe("true");
        expect(prepared?.env?.GOOGLE_APPLICATION_CREDENTIALS).toBe(
          path.join(workspaceDir, "credentials.json"),
        );
      } finally {
        restoreEnv("GEMINI_CLI_HOME", originalGeminiCliHome);
        await prepared?.cleanup?.();
      }
    });
  });

  it("rebases relative Vertex credentials inherited from the process", async () => {
    await withTempDir("openclaw-test-workspace-", async (workspaceDir) => {
      const ambientHome = path.join(workspaceDir, "ambient-home");
      await fs.mkdir(path.join(ambientHome, ".gemini"), { recursive: true });
      await fs.writeFile(
        path.join(ambientHome, ".gemini", "settings.json"),
        `${JSON.stringify({ security: { auth: { selectedType: "vertex-ai" } } })}\n`,
      );
      const originalGeminiCliHome = process.env.GEMINI_CLI_HOME;
      const originalApplicationCredentials = process.env.GOOGLE_APPLICATION_CREDENTIALS;
      process.env.GEMINI_CLI_HOME = ambientHome;
      process.env.GOOGLE_APPLICATION_CREDENTIALS = "./credentials.json";
      let prepared: GeminiPreparedExecution | null | undefined;
      try {
        prepared = await buildGoogleGeminiCliBackend().prepareExecution?.({
          workspaceDir,
          provider: "google-gemini-cli",
          modelId: "gemini-3.1-flash-preview",
          toolAvailability: { native: [], openClaw: [], mcp: [] },
          isolatedCompletionModelId: "gemini-3.1-flash-preview",
          isolatedCompletionSystemPrompt: "Return only JSON.",
        } as GeminiPrepareContext);
        expect(prepared?.env?.GOOGLE_APPLICATION_CREDENTIALS).toBe(
          path.join(workspaceDir, "credentials.json"),
        );
        expect(prepared?.clearEnv).toContain("GOOGLE_APPLICATION_CREDENTIALS");
      } finally {
        restoreEnv("GEMINI_CLI_HOME", originalGeminiCliHome);
        restoreEnv("GOOGLE_APPLICATION_CREDENTIALS", originalApplicationCredentials);
        await prepared?.cleanup?.();
      }
    });
  });

  it("rejects auto-routing models for isolated completion", async () => {
    await withTempDir("openclaw-test-workspace-", async (workspaceDir) => {
      await expect(
        buildGoogleGeminiCliBackend().prepareExecution?.({
          ...buildGeminiApiKeyPrepareContext(workspaceDir),
          modelId: "auto",
          toolAvailability: { native: [], openClaw: [], mcp: [] },
          isolatedCompletionModelId: "auto",
          isolatedCompletionSystemPrompt: "Return only JSON.",
        } as GeminiPrepareContext),
      ).rejects.toMatchObject({
        code: "input-rejected",
        message: expect.stringContaining("requires one concrete model id"),
      });
    });
  });

  it.each([
    { auth: "ambient", allowed: ["memory_search"] },
    { auth: "ambient", allowed: [] },
    { auth: "api-key", allowed: ["memory_search"] },
    { auth: "api-key", allowed: [] },
  ] as const)(
    "enforces exact system policy for $auth auth with $allowed",
    async ({ auth, allowed }) => {
      await withTempDir("openclaw-test-workspace-", async (workspaceDir) => {
        const backend = buildGoogleGeminiCliBackend();
        const ambientHome = path.join(workspaceDir, "ambient-home");
        await fs.mkdir(path.join(ambientHome, ".gemini"), { recursive: true });
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
          auth === "api-key"
            ? buildGeminiApiKeyPrepareContext(workspaceDir)
            : {
                workspaceDir,
                provider: "google-gemini-cli",
                modelId: "gemini-3.1-pro-preview",
              };
        context.env = {
          GEMINI_CLI_HOME: ambientHome,
          GEMINI_CLI_SYSTEM_SETTINGS_PATH: inheritedSettingsPath,
          ...(auth === "ambient" ? { GEMINI_API_KEY: "ambient-key" } : {}),
        };
        context.toolAvailability = {
          native: [],
          openClaw: [...allowed],
          mcp: allowed.map((toolName) => `mcp__openclaw__${toolName}`),
        };
        const prepared = await backend.prepareExecution?.(context);
        const preparedHome = prepared?.env?.GEMINI_CLI_HOME ?? "";
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
          expect(settings.tools?.core).toEqual(allowed.length > 0 ? ["mcp_openclaw_*"] : []);
          expect(settings.tools).not.toHaveProperty("allowed");
          expect(settings.tools?.discoveryCommand).toBe("");
          expect(settings.tools?.callCommand).toBe("");
          if (allowed.length > 0) {
            expect(settings.mcp?.allowed).toEqual(["openclaw"]);
          } else {
            expect(settings.mcp?.allowed).toHaveLength(1);
            expect(settings.mcp?.allowed?.[0]).toMatch(
              /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
            );
          }
          expect(settings.mcp?.serverCommand).toBe("");
          if (allowed.length > 0) {
            expect(settings.mcpServers?.openclaw).toMatchObject({
              url: "http://127.0.0.1:23119/mcp",
              headers: { authorization: "Bearer loopback-token" },
              includeTools: [...allowed],
            });
          } else {
            expect(settings.mcpServers).toEqual({});
          }
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
            auth === "api-key" ? "gemini-api-key" : undefined,
          );
          expect(prepared?.clearEnv).toContain("GEMINI_API_KEY");
          expect(prepared?.clearEnv).toContain("GEMINI_CLI_HOME");
          expect(preparedHome).toContain("openclaw-gemini-cli-");
          expect(preparedHome).not.toBe(ambientHome);
          expect(preparedHome).not.toContain(path.join(workspaceDir, "agent"));
        } finally {
          await prepared?.cleanup?.();
        }
        await expect(fs.access(preparedHome)).rejects.toThrow();
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
          env: {
            GEMINI_API_KEY: "ambient-key",
            GEMINI_CLI_SYSTEM_SETTINGS_PATH: inheritedSettingsPath,
          },
          toolAvailability: { native: ["run_shell_command"], openClaw: [], mcp: [] },
        }),
      ).rejects.toThrow("cannot expose backend-native tools");
    });
  });

  it("enforces an exact empty tool cap without an OpenClaw MCP server", async () => {
    await withTempDir("openclaw-test-workspace-", async (workspaceDir) => {
      const inheritedSettingsPath = path.join(workspaceDir, "system-settings.json");
      await fs.writeFile(
        inheritedSettingsPath,
        JSON.stringify({
          tools: { core: ["run_shell_command"], allowed: ["*"] },
          mcp: { allowed: ["hostile"] },
          mcpServers: {
            openclaw: { command: "inherited-openclaw-server" },
            hostile: { command: "hostile-server" },
          },
          experimental: { enableAgents: true },
          hooksConfig: { enabled: true },
          skills: { enabled: true },
        }),
        "utf8",
      );
      const prepared = await buildGoogleGeminiCliBackend().prepareExecution?.({
        workspaceDir,
        provider: "google-gemini-cli",
        modelId: "gemini-3.1-pro-preview",
        env: {
          GEMINI_API_KEY: "ambient-key",
          GEMINI_CLI_SYSTEM_SETTINGS_PATH: inheritedSettingsPath,
        },
        toolAvailability: { native: [], openClaw: [], mcp: [] },
      });
      try {
        expect(prepared?.toolAvailabilityEnforced).toBe(true);
        await stageGeminiPreparedExecution(prepared);
        const systemSettingsPath = prepared?.env?.GEMINI_CLI_SYSTEM_SETTINGS_PATH;
        const settings = JSON.parse(await fs.readFile(systemSettingsPath ?? "", "utf8")) as {
          tools?: { core?: string[] };
          mcp?: { allowed?: string[] };
          mcpServers?: Record<string, unknown>;
          experimental?: { enableAgents?: boolean };
          hooksConfig?: { enabled?: boolean };
          skills?: { enabled?: boolean };
        };
        expect(settings.tools?.core).toEqual([]);
        expect(settings.tools).not.toHaveProperty("allowed");
        expect(settings.mcp?.allowed).toHaveLength(1);
        expect(settings.mcp?.allowed?.[0]).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        );
        expect(settings.mcpServers).toEqual({});
        expect(settings.experimental?.enableAgents).toBe(false);
        expect(settings.hooksConfig?.enabled).toBe(false);
        expect(settings.skills?.enabled).toBe(false);
      } finally {
        await prepared?.cleanup?.();
      }
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

  it("stages expired legacy OAuth credentials for Gemini CLI-owned refresh", async () => {
    await withTempDir("openclaw-test-workspace-", async (workspaceDir) => {
      const context = buildGeminiOAuthPrepareContext(workspaceDir);
      if (!context.authCredential) {
        throw new Error("expected Gemini OAuth test credentials");
      }
      context.authCredential.expires = Date.now() - 60_000;

      const prepared = await buildGoogleGeminiCliBackend().prepareExecution?.(context);
      try {
        await stageGeminiPreparedExecution(prepared);
        const home = prepared?.env?.GEMINI_CLI_HOME;
        const raw = await fs.readFile(path.join(home ?? "", ".gemini", "oauth_creds.json"), "utf8");
        expect(JSON.parse(raw)).toMatchObject({
          access_token: "access-token",
          refresh_token: "refresh-token",
          expiry_date: context.authCredential.expires,
        });
      } finally {
        await prepared?.cleanup?.();
      }
    });
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
      const preparation = backend.prepareExecution?.({
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
      } as never);
      await expect(preparation).rejects.not.toBeInstanceOf(CliBackendAuthProfilePreparationError);
      await expect(preparation).rejects.toThrow(/vercel-ai-gateway auth profile/);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("rejects selected Gemini token profiles before the CLI can use ambient auth", async () => {
    const backend = buildGoogleGeminiCliBackend();
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-test-workspace-"));

    try {
      const preparation = backend.prepareExecution?.({
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
      } as never);
      await expect(preparation).rejects.not.toBeInstanceOf(CliBackendAuthProfilePreparationError);
      await expect(preparation).rejects.toThrow(/Google AI Studio API-key profile/);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("rejects selected Gemini profiles with no material before the CLI can use ambient auth", async () => {
    const backend = buildGoogleGeminiCliBackend();
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-test-workspace-"));

    try {
      const preparation = backend.prepareExecution?.({
        workspaceDir,
        agentDir: path.join(workspaceDir, "agent"),
        provider: "google-gemini-cli",
        modelId: "gemini-3.1-flash-lite",
        authProfileId: "google-gemini-cli:missing",
      } as never);
      await expect(preparation).rejects.toBeInstanceOf(CliBackendAuthProfilePreparationError);
      await expect(preparation).rejects.toThrow(
        /Open Models settings and connect Google with an AI Studio API key/,
      );
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("routes incomplete legacy Gemini OAuth profiles to supported Google setup", async () => {
    const backend = buildGoogleGeminiCliBackend();
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-test-workspace-"));

    try {
      const preparation = backend.prepareExecution?.({
        workspaceDir,
        agentDir: path.join(workspaceDir, "agent"),
        provider: "google-gemini-cli",
        modelId: "gemini-3.1-flash-lite",
        authProfileId: "google-gemini-cli:legacy",
        authCredential: {
          type: "oauth",
          provider: "google-gemini-cli",
          access: "expired-access-token",
        },
      } as never);
      await expect(preparation).rejects.toBeInstanceOf(CliBackendAuthProfilePreparationError);
      await expect(preparation).rejects.toThrow(
        /OAuth profile is incomplete and cannot be repaired by OpenClaw.*AI Studio API key/,
      );
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
    const mkdtempSpy = vi.spyOn(fs, "mkdtemp");

    try {
      const { agentDir: _agentDir, ...context } = buildGeminiOAuthPrepareContext(workspaceDir);
      mkdtempSpy.mockClear();
      await expect(backend.prepareExecution?.(context)).rejects.toThrow(/agent directory/);
      expect(mkdtempSpy).not.toHaveBeenCalled();
    } finally {
      mkdtempSpy.mockRestore();
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("does not allocate profile state when exact-tool transport discovery fails", async () => {
    const backend = buildGoogleGeminiCliBackend();
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-test-workspace-"));
    const ambientHome = path.join(workspaceDir, "ambient-home");
    await fs.mkdir(path.join(ambientHome, ".gemini"), { recursive: true });
    await fs.writeFile(path.join(ambientHome, ".gemini", ".env"), "GEMINI_API_KEY=ambient\n");
    const realReadFile = fs.readFile.bind(fs);
    const readFileSpy = vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
      if (typeof args[0] === "string" && args[0].endsWith(".env")) {
        throw new Error("transport env failure");
      }
      return await realReadFile(...args);
    });
    const mkdtempSpy = vi.spyOn(fs, "mkdtemp");

    try {
      const context = buildGeminiApiKeyPrepareContext(workspaceDir);
      context.env = { GEMINI_CLI_HOME: ambientHome };
      context.toolAvailability = { native: [], openClaw: [], mcp: [] };
      mkdtempSpy.mockClear();
      const preparation = backend.prepareExecution?.(context);
      await expect(preparation).rejects.not.toBeInstanceOf(CliBackendAuthProfilePreparationError);
      await expect(preparation).rejects.toThrow("transport env failure");
      expect(mkdtempSpy).not.toHaveBeenCalled();
    } finally {
      mkdtempSpy.mockRestore();
      readFileSpy.mockRestore();
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("uses profile-only auth epochs for the private Gemini CLI bridge", () => {
    const backend = buildGoogleGeminiCliBackend();

    expect(backend.authEpochMode).toBe("profile-only");
    expect(backend.prepareExecution).toBeTypeOf("function");
  });
});

describe("Gemini CLI backend descriptor watchdog defaults (#125045)", () => {
  it("does not ship stock watchdog defaults that disable resume-watchdog promotion", () => {
    // Same invariant as the Anthropic CLI backend: shipping byte-identical
    // copies of the fallback defaults only makes `configured` truthy and
    // disables the promotion gate in pickWatchdogProfile.
    const { config } = buildGoogleGeminiCliBackend();
    expect(config.reliability?.watchdog).toBeUndefined();
  });
});
