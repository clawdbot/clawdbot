import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "./agent-command.test-mocks.js";
import "../cron/isolated-agent.mocks.js";
import { __testing as acpManagerTesting } from "../acp/control-plane/manager.js";
import { __testing as agentCommandTesting } from "../agents/agent-command.js";
import { resolveSession } from "../agents/command/session.js";
import { loadModelCatalog } from "../agents/model-catalog.js";
import * as modelSelectionModule from "../agents/model-selection.js";
import { runEmbeddedPiAgent } from "../agents/pi-embedded.js";
import * as commandConfigResolutionModule from "../cli/command-config-resolution.js";
import type { OpenClawConfig } from "../config/config.js";
import * as configModule from "../config/config.js";
import { clearSessionStoreCacheForTest } from "../config/sessions.js";
import { resetAgentEventsForTest, resetAgentRunContextForTest } from "../infra/agent-events.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  createDefaultAgentCommandResult,
  mockAgentCommandConfig,
  withAgentCommandTempHome,
} from "./agent-command.test-support.js";

vi.mock("../agents/auth-profiles.js", () => {
  return {
    ensureAuthProfileStore: vi.fn(() => ({ version: 1, profiles: {} })),
  };
});

vi.mock("../agents/auth-profiles/store.js", () => {
  const createEmptyStore = () => ({ version: 1, profiles: {} });
  return {
    clearRuntimeAuthProfileStoreSnapshots: vi.fn(),
    ensureAuthProfileStore: vi.fn(createEmptyStore),
    ensureAuthProfileStoreForLocalUpdate: vi.fn(createEmptyStore),
    hasAnyAuthProfileStoreSource: vi.fn(() => false),
    loadAuthProfileStore: vi.fn(createEmptyStore),
    loadAuthProfileStoreForRuntime: vi.fn(createEmptyStore),
    loadAuthProfileStoreForSecretsRuntime: vi.fn(createEmptyStore),
    replaceRuntimeAuthProfileStoreSnapshots: vi.fn(),
    saveAuthProfileStore: vi.fn(),
    updateAuthProfileStoreWithLock: vi.fn(async () => createEmptyStore()),
  };
});

vi.mock("../agents/command/session-store.js", () => {
  return {
    updateSessionStoreAfterAgentRun: vi.fn(async () => undefined),
  };
});

const runtime: RuntimeEnv = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(() => {
    throw new Error("exit");
  }),
};

const configSpy = vi.spyOn(configModule, "loadConfig");
const readConfigFileSnapshotForWriteSpy = vi.spyOn(configModule, "readConfigFileSnapshotForWrite");

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  return withAgentCommandTempHome("openclaw-agent-", fn);
}

function mockConfig(
  home: string,
  storePath: string,
  agentOverrides?: Parameters<typeof mockAgentCommandConfig>[3],
) {
  return mockAgentCommandConfig(configSpy, home, storePath, agentOverrides);
}

beforeEach(() => {
  vi.clearAllMocks();
  clearSessionStoreCacheForTest();
  resetAgentEventsForTest();
  resetAgentRunContextForTest();
  resetPluginRuntimeStateForTest();
  acpManagerTesting.resetAcpSessionManagerForTests();
  configModule.clearRuntimeConfigSnapshot();
  vi.mocked(runEmbeddedPiAgent).mockResolvedValue(createDefaultAgentCommandResult());
  vi.mocked(loadModelCatalog).mockResolvedValue([]);
  vi.mocked(modelSelectionModule.isCliProvider).mockImplementation(() => false);
  readConfigFileSnapshotForWriteSpy.mockResolvedValue({
    snapshot: { valid: false, resolved: {} as OpenClawConfig },
    writeOptions: {},
  } as Awaited<ReturnType<typeof configModule.readConfigFileSnapshotForWrite>>);
});

describe("agentCommand runtime config", () => {
  it("sets runtime snapshots from source config before embedded agent run", async () => {
    await withTempHome(async (home) => {
      const setRuntimeConfigSnapshotSpy = vi.spyOn(configModule, "setRuntimeConfigSnapshot");

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

      configSpy.mockReturnValue(loadedConfig);
      readConfigFileSnapshotForWriteSpy.mockResolvedValue({
        snapshot: { valid: true, resolved: sourceConfig },
        writeOptions: {},
      } as Awaited<ReturnType<typeof configModule.readConfigFileSnapshotForWrite>>);
      const resolveConfigWithSecretsSpy = vi
        .spyOn(commandConfigResolutionModule, "resolveCommandConfigWithSecrets")
        .mockResolvedValueOnce({
          resolvedConfig,
          effectiveConfig: resolvedConfig,
          diagnostics: [],
        });

      const prepared = await agentCommandTesting.resolveAgentRuntimeConfig(runtime);

      expect(resolveConfigWithSecretsSpy).toHaveBeenCalledWith({
        config: loadedConfig,
        commandName: "agent",
        targetIds: expect.objectContaining({
          has: expect.any(Function),
        }),
        runtime,
      });
      const targetIds = resolveConfigWithSecretsSpy.mock.calls[0]?.[0].targetIds;
      expect(targetIds.has("models.providers.*.apiKey")).toBe(true);
      expect(targetIds.has("channels.telegram.botToken")).toBe(false);
      expect(setRuntimeConfigSnapshotSpy).toHaveBeenCalledWith(resolvedConfig, sourceConfig);
      expect(prepared.cfg).toBe(resolvedConfig);
    });
  });

  it("includes channel secret targets when delivery is requested", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      const loadedConfig = mockConfig(home, store);
      const resolveConfigWithSecretsSpy = vi
        .spyOn(commandConfigResolutionModule, "resolveCommandConfigWithSecrets")
        .mockResolvedValueOnce({
          resolvedConfig: loadedConfig,
          effectiveConfig: loadedConfig,
          diagnostics: [],
        });

      await agentCommandTesting.resolveAgentRuntimeConfig(runtime, {
        runtimeTargetsChannelSecrets: true,
      });

      const targetIds = resolveConfigWithSecretsSpy.mock.calls[0]?.[0].targetIds;
      expect(targetIds.has("channels.telegram.botToken")).toBe(true);
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
