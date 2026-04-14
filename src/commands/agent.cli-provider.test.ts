import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "./agent-command.test-mocks.js";
import "../cron/isolated-agent.mocks.js";
import * as cliRunnerModule from "../agents/cli-runner.js";
import { FailoverError } from "../agents/failover-error.js";
import { loadModelCatalog } from "../agents/model-catalog.js";
import * as modelSelectionModule from "../agents/model-selection.js";
import { runEmbeddedPiAgent } from "../agents/pi-embedded.js";
import * as configIoModule from "../config/io.js";
import { createDefaultAgentCommandResult } from "./agent-command.test-support.js";
import {
  mockSharedAgentCommandConfig,
  resetSharedAgentCommandRuntimeState,
  runtime,
  withSharedAgentCommandTempHome,
} from "./agent-runtime-config.test-support.js";
import { agentCommand } from "./agent.js";

const configSpy = vi.spyOn(configIoModule, "loadConfig");
const readConfigFileSnapshotForWriteSpy = vi.spyOn(
  configIoModule,
  "readConfigFileSnapshotForWrite",
);
const runCliAgentSpy = vi.spyOn(cliRunnerModule, "runCliAgent");

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  return withSharedAgentCommandTempHome("openclaw-agent-cli-", fn);
}

function mockConfig(
  home: string,
  storePath: string,
  agentOverrides?: Parameters<typeof mockSharedAgentCommandConfig>[3],
) {
  return mockSharedAgentCommandConfig(configSpy, home, storePath, agentOverrides);
}

function writeSessionStoreSeed(
  storePath: string,
  sessions: Record<string, Record<string, unknown>>,
) {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify(sessions, null, 2));
}

function readSessionStore<T>(storePath: string): Record<string, T> {
  return JSON.parse(fs.readFileSync(storePath, "utf-8")) as Record<string, T>;
}

function expectLastEmbeddedProviderModel(provider: string, model: string): void {
  const callArgs = vi.mocked(runEmbeddedPiAgent).mock.calls.at(-1)?.[0];
  expect(callArgs?.provider).toBe(provider);
  expect(callArgs?.model).toBe(model);
}

beforeEach(() => {
  resetSharedAgentCommandRuntimeState(readConfigFileSnapshotForWriteSpy);
  runCliAgentSpy.mockResolvedValue(createDefaultAgentCommandResult() as never);
});

describe("agentCommand CLI provider handling", () => {
  it("rejects explicit CLI overrides that are outside the models allowlist", async () => {
    vi.mocked(modelSelectionModule.isCliProvider).mockImplementation(
      (provider) => provider.trim().toLowerCase() === "claude-cli",
    );
    try {
      await withTempHome(async (home) => {
        const store = path.join(home, "sessions.json");
        mockConfig(home, store, {
          models: {
            "openai/gpt-4.1-mini": {},
          },
        });

        await expect(
          agentCommand(
            {
              message: "use disallowed cli override",
              sessionKey: "agent:main:subagent:cli-override-error",
              model: "claude-cli/opus",
            },
            runtime,
          ),
        ).rejects.toThrow('Model override "claude-cli/opus" is not allowed for agent "main".');
      });
    } finally {
      vi.mocked(modelSelectionModule.isCliProvider).mockImplementation(() => false);
    }
  });

  it("clears stored CLI overrides when they fall outside the models allowlist", async () => {
    vi.mocked(modelSelectionModule.isCliProvider).mockImplementation(
      (provider) => provider.trim().toLowerCase() === "claude-cli",
    );
    try {
      await withTempHome(async (home) => {
        const store = path.join(home, "sessions.json");
        writeSessionStoreSeed(store, {
          "agent:main:subagent:clear-cli-overrides": {
            sessionId: "session-clear-cli-overrides",
            updatedAt: Date.now(),
            providerOverride: "claude-cli",
            modelOverride: "opus",
          },
        });

        mockConfig(home, store, {
          model: { primary: "openai/gpt-4.1-mini" },
          models: {
            "openai/gpt-4.1-mini": {},
          },
        });

        vi.mocked(loadModelCatalog).mockResolvedValueOnce([
          { id: "gpt-4.1-mini", name: "GPT-4.1 Mini", provider: "openai" },
          { id: "opus", name: "Opus", provider: "claude-cli" },
        ]);

        await agentCommand(
          {
            message: "hi",
            sessionKey: "agent:main:subagent:clear-cli-overrides",
          },
          runtime,
        );

        expectLastEmbeddedProviderModel("openai", "gpt-4.1-mini");

        const saved = readSessionStore<{
          providerOverride?: string;
          modelOverride?: string;
        }>(store);
        expect(saved["agent:main:subagent:clear-cli-overrides"]?.providerOverride).toBeUndefined();
        expect(saved["agent:main:subagent:clear-cli-overrides"]?.modelOverride).toBeUndefined();
      });
    } finally {
      vi.mocked(modelSelectionModule.isCliProvider).mockImplementation(() => false);
    }
  });

  it("clears stale Claude CLI legacy session IDs before retrying after session expiration", async () => {
    vi.mocked(modelSelectionModule.isCliProvider).mockImplementation(
      (provider) => provider.trim().toLowerCase() === "claude-cli",
    );
    try {
      await withTempHome(async (home) => {
        const store = path.join(home, "sessions.json");
        const sessionKey = "agent:main:subagent:cli-expired";
        writeSessionStoreSeed(store, {
          [sessionKey]: {
            sessionId: "session-cli-123",
            updatedAt: Date.now(),
            providerOverride: "claude-cli",
            modelOverride: "opus",
            cliSessionIds: { "claude-cli": "stale-cli-session" },
            claudeCliSessionId: "stale-legacy-session",
          },
        });

        mockConfig(home, store, {
          model: { primary: "claude-cli/opus", fallbacks: [] },
          models: { "claude-cli/opus": {} },
        });

        runCliAgentSpy
          .mockRejectedValueOnce(
            new FailoverError("session expired", {
              reason: "session_expired",
              provider: "claude-cli",
              model: "opus",
              status: 410,
            }),
          )
          .mockRejectedValue(new Error("retry failed"));

        await expect(agentCommand({ message: "hi", sessionKey }, runtime)).rejects.toThrow(
          "retry failed",
        );

        expect(runCliAgentSpy).toHaveBeenCalledTimes(2);
        const firstCall = runCliAgentSpy.mock.calls[0]?.[0] as
          | { cliSessionId?: string }
          | undefined;
        const secondCall = runCliAgentSpy.mock.calls[1]?.[0] as
          | { cliSessionId?: string }
          | undefined;
        expect(firstCall?.cliSessionId).toBe("stale-cli-session");
        expect(secondCall?.cliSessionId).toBeUndefined();

        const saved = readSessionStore<{
          cliSessionIds?: Record<string, string>;
          claudeCliSessionId?: string;
        }>(store);
        expect(saved[sessionKey]?.cliSessionIds?.["claude-cli"]).toBeUndefined();
        expect(saved[sessionKey]?.claudeCliSessionId).toBeUndefined();
      });
    } finally {
      vi.mocked(modelSelectionModule.isCliProvider).mockImplementation(() => false);
    }
  });
});
