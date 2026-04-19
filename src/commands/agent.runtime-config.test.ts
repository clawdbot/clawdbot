import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withTempHome as withTempHomeBase } from "../../test/helpers/temp-home.js";
import { resolveAgentRuntimeConfig } from "../agents/agent-runtime-config.js";
import { resolveSession } from "../agents/command/session.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
import { createThrowingTestRuntime } from "./test-runtime-config-helpers.js";

type ConfigSnapshotForWrite = {
  snapshot: { valid: boolean; resolved: OpenClawConfig };
  writeOptions: Record<string, never>;
};

type ResolveCommandConfigParams = {
  config: OpenClawConfig;
  commandName: string;
  targetIds: Set<string>;
  runtime: RuntimeEnv;
};

const loadConfigMock = vi.hoisted(() => vi.fn<() => OpenClawConfig>());
const readConfigFileSnapshotForWriteMock = vi.hoisted(() =>
  vi.fn<() => Promise<ConfigSnapshotForWrite>>(),
);
vi.mock("../config/io.js", () => ({
  loadConfig: loadConfigMock,
  readConfigFileSnapshotForWrite: readConfigFileSnapshotForWriteMock,
}));

vi.mock("../cli/command-secret-targets.js", () => ({
  getAgentRuntimeCommandSecretTargetIds: (params?: { includeChannelTargets?: boolean }) =>
    new Set([
      "models.providers.*.apiKey",
      ...(params?.includeChannelTargets === true ? ["channels.telegram.botToken"] : []),
    ]),
}));

const setRuntimeConfigSnapshotMock = vi.hoisted(() =>
  vi.fn<(cfg: OpenClawConfig, sourceConfig: OpenClawConfig) => void>(),
);
vi.mock("../config/runtime-snapshot.js", () => ({
  setRuntimeConfigSnapshot: setRuntimeConfigSnapshotMock,
}));

const resolveCommandConfigWithSecretsMock = vi.hoisted(() =>
  vi.fn<
    (params: ResolveCommandConfigParams) => Promise<{
      resolvedConfig: OpenClawConfig;
      effectiveConfig: OpenClawConfig;
      diagnostics: never[];
    }>
  >(),
);
vi.mock("../cli/command-config-resolution.runtime.js", () => ({
  resolveCommandConfigWithSecrets: resolveCommandConfigWithSecretsMock,
}));

const runtime = createThrowingTestRuntime();

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  return withTempHomeBase(fn, { prefix: "openclaw-agent-" });
}

function mockConfig(home: string, storePath: string): OpenClawConfig {
  const cfg = {
    agents: {
      defaults: {
        model: { primary: "anthropic/claude-opus-4-6" },
        models: { "anthropic/claude-opus-4-6": {} },
        workspace: path.join(home, "openclaw"),
      },
    },
    session: { store: storePath, mainKey: "main" },
  } as OpenClawConfig;
  loadConfigMock.mockReturnValue(cfg);
  return cfg;
}

beforeEach(() => {
  vi.clearAllMocks();
  readConfigFileSnapshotForWriteMock.mockResolvedValue({
    snapshot: { valid: false, resolved: {} as OpenClawConfig },
    writeOptions: {},
  });
});

describe("agentCommand runtime config", () => {
  it("sets runtime snapshots from source config before embedded agent run", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      const loadedConfig = {
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-opus-4-6" },
            models: { "anthropic/claude-opus-4-6": {} },
            workspace: path.join(home, "openclaw"),
          },
        },
        session: { store, mainKey: "main" },
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" }, // pragma: allowlist secret
              models: [],
            },
          },
        },
      } as unknown as OpenClawConfig;
      const sourceConfig = {
        ...loadedConfig,
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" }, // pragma: allowlist secret
              models: [],
            },
          },
        },
      } as unknown as OpenClawConfig;
      const resolvedConfig = {
        ...loadedConfig,
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              apiKey: "sk-resolved-runtime", // pragma: allowlist secret
              models: [],
            },
          },
        },
      } as unknown as OpenClawConfig;

      loadConfigMock.mockReturnValue(loadedConfig);
      readConfigFileSnapshotForWriteMock.mockResolvedValue({
        snapshot: { valid: true, resolved: sourceConfig },
        writeOptions: {},
      });
      resolveCommandConfigWithSecretsMock.mockResolvedValueOnce({
        resolvedConfig,
        effectiveConfig: resolvedConfig,
        diagnostics: [],
      });

      const prepared = await resolveAgentRuntimeConfig(runtime);

      expect(resolveCommandConfigWithSecretsMock).toHaveBeenCalledWith({
        config: loadedConfig,
        commandName: "agent",
        targetIds: expect.objectContaining({
          has: expect.any(Function),
        }),
        runtime,
      });
      const targetIds = resolveCommandConfigWithSecretsMock.mock.calls[0]?.[0].targetIds;
      expect(targetIds.has("models.providers.*.apiKey")).toBe(true);
      expect(targetIds.has("channels.telegram.botToken")).toBe(false);
      expect(setRuntimeConfigSnapshotMock).toHaveBeenCalledWith(resolvedConfig, sourceConfig);
      expect(prepared.cfg).toBe(resolvedConfig);
    });
  });

  it("includes channel secret targets when delivery is requested", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      const loadedConfig = mockConfig(home, store);
      loadedConfig.channels = {
        telegram: {
          botToken: { source: "env", provider: "default", id: "TELEGRAM_BOT_TOKEN" },
        },
      } as unknown as OpenClawConfig["channels"];
      resolveCommandConfigWithSecretsMock.mockResolvedValueOnce({
        resolvedConfig: loadedConfig,
        effectiveConfig: loadedConfig,
        diagnostics: [],
      });

      await resolveAgentRuntimeConfig(runtime, {
        runtimeTargetsChannelSecrets: true,
      });

      const targetIds = resolveCommandConfigWithSecretsMock.mock.calls[0]?.[0].targetIds;
      expect(targetIds.has("channels.telegram.botToken")).toBe(true);
    });
  });

  it("skips command secret resolution when no relevant SecretRef values exist", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      const loadedConfig = mockConfig(home, store);

      const prepared = await resolveAgentRuntimeConfig(runtime);

      expect(resolveCommandConfigWithSecretsMock).not.toHaveBeenCalled();
      expect(prepared.cfg).toBe(loadedConfig);
    });
  });

  it("derives a fresh session from --to", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      const cfg = mockConfig(home, store);

      const resolved = resolveSession({ cfg, to: "+1555" });

      expect(resolved.storePath).toBe(store);
      expect(resolved.sessionKey).toBeTruthy();
      expect(resolved.sessionId).toBeTruthy();
      expect(resolved.isNewSession).toBe(true);
    });
  });
});
