import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "./agent-command.test-mocks.js";
import "../cron/isolated-agent.mocks.js";
import { __testing as agentCommandTesting } from "../agents/agent-command.js";
import { resolveSession } from "../agents/command/session.js";
import * as commandConfigResolutionModule from "../cli/command-config-resolution.js";
import type { OpenClawConfig } from "../config/config.js";
import * as configModule from "../config/config.js";
import {
  mockSharedAgentCommandConfig,
  resetSharedAgentCommandRuntimeState,
  runtime,
  withSharedAgentCommandTempHome,
} from "./agent-runtime-config.test-support.js";

vi.mock("../agents/command/session-store.js", () => {
  return {
    updateSessionStoreAfterAgentRun: vi.fn(async () => undefined),
  };
});

const configSpy = vi.spyOn(configModule, "loadConfig");
const readConfigFileSnapshotForWriteSpy = vi.spyOn(configModule, "readConfigFileSnapshotForWrite");

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  return withSharedAgentCommandTempHome("openclaw-agent-", fn);
}

function mockConfig(
  home: string,
  storePath: string,
  agentOverrides?: Parameters<typeof mockSharedAgentCommandConfig>[3],
) {
  return mockSharedAgentCommandConfig(configSpy, home, storePath, agentOverrides);
}

beforeEach(() => {
  resetSharedAgentCommandRuntimeState(readConfigFileSnapshotForWriteSpy);
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
