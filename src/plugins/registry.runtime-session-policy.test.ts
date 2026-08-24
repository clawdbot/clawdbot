// Verifies plugin registry ownership around lifecycle session resets.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginRecord } from "./loader-records.js";
import { createPluginRegistry } from "./registry.js";
import { createPluginRuntime } from "./runtime/index.js";
import type { PluginRuntime } from "./runtime/types.js";

const emptyConfig = {} satisfies OpenClawConfig;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createTestRegistry(runtime: PluginRuntime) {
  return createPluginRegistry({
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
    runtime,
    activateGlobalSideEffects: false,
  });
}

function createRecord(params: { id: string; channelIds?: string[] }) {
  const record = createPluginRecord({
    id: params.id,
    source: `/plugins/${params.id}/index.js`,
    origin: "bundled",
    enabled: true,
    configSchema: false,
  });
  record.channelIds = params.channelIds ?? [];
  return record;
}

describe("plugin registry runtime session policy", () => {
  it("lets only the channel and harness owners rotate locked sessions", async () => {
    const tempDir = tempDirs.make("openclaw-plugin-session-reset-");
    const storePath = path.join(tempDir, "sessions.json");
    const channelSessionKey = "agent:main:msteams:direct:user-aad";
    const harnessSessionKey = "agent:main:harness:codex:thread-1";
    const channelTranscriptPath = path.join(tempDir, "channel-session.jsonl");
    const harnessTranscriptPath = path.join(tempDir, "harness-session.jsonl");
    fs.writeFileSync(channelTranscriptPath, '{"type":"session","id":"channel-old"}\n', "utf8");
    fs.writeFileSync(harnessTranscriptPath, '{"type":"session","id":"harness-old"}\n', "utf8");

    try {
      const runtime = createPluginRuntime();
      await runtime.agent.session.upsertSessionEntry({
        agentId: "main",
        entry: {
          agentHarnessId: "codex",
          label: "Teams",
          modelSelectionLocked: true,
          sessionFile: channelTranscriptPath,
          sessionId: "channel-old",
          updatedAt: 10,
        },
        sessionKey: channelSessionKey,
        storePath,
      });
      await runtime.agent.session.upsertSessionEntry({
        agentId: "main",
        entry: {
          agentHarnessId: "codex",
          label: "Harness",
          modelSelectionLocked: true,
          sessionFile: harnessTranscriptPath,
          sessionId: "harness-old",
          updatedAt: 20,
        },
        sessionKey: harnessSessionKey,
        storePath,
      });

      const pluginRegistry = createTestRegistry(runtime);
      const ownerApi = pluginRegistry.createApi(createRecord({ id: "codex-owner" }), {
        config: emptyConfig,
      });
      const teamsApi = pluginRegistry.createApi(
        createRecord({ id: "msteams", channelIds: ["msteams"] }),
        { config: emptyConfig },
      );
      const otherApi = pluginRegistry.createApi(createRecord({ id: "other-plugin" }), {
        config: emptyConfig,
      });
      const voiceApi = pluginRegistry.createApi(createRecord({ id: "voice-call" }), {
        config: emptyConfig,
      });
      const harnessReset = vi.fn(async () => {});
      ownerApi.registerAgentHarness({
        id: "codex",
        label: "Codex",
        delegatedExecutionPluginIds: ["voice-call"],
        reset: harnessReset,
        supports: () => ({ supported: true }),
        runAttempt: async () => {
          throw new Error("unused");
        },
      });

      await expect(
        voiceApi.runtime.agent.session.resetSessionEntryLifecycle({
          sessionKey: harnessSessionKey,
          storePath,
          update: () => ({ updatedAt: 0 }),
        }),
      ).rejects.toThrow('owned by plugin "codex-owner"');

      const harnessResult = await ownerApi.runtime.agent.session.resetSessionEntryLifecycle({
        expectedSessionId: "harness-old",
        expectedUpdatedAt: 20,
        sessionKey: harnessSessionKey,
        storePath,
        update: (entry, { nextSessionId }) => ({
          label: entry.label,
          sessionId: nextSessionId,
          updatedAt: 0,
        }),
      });
      expect(harnessResult).toMatchObject({ label: "Harness", updatedAt: 0 });
      expect(harnessResult?.sessionId).not.toBe("harness-old");

      const channelResult = await teamsApi.runtime.channel.session.resetSessionEntryLifecycle({
        channelId: "msteams",
        expectedSessionId: "channel-old",
        expectedUpdatedAt: 10,
        sessionKey: channelSessionKey,
        storePath,
        update: (entry, { nextSessionId }) => ({
          label: entry.label,
          sessionId: nextSessionId,
          updatedAt: 0,
        }),
      });
      expect(channelResult).toMatchObject({ label: "Teams", updatedAt: 0 });
      expect(channelResult?.sessionId).not.toBe("channel-old");
      expect(channelResult?.sessionFile).not.toBe(channelTranscriptPath);

      expect(harnessReset).toHaveBeenCalledWith({
        reason: "reset",
        sessionId: "harness-old",
        sessionKey: harnessSessionKey,
      });
      expect(harnessReset).toHaveBeenCalledWith({
        reason: "reset",
        sessionId: "channel-old",
        sessionKey: channelSessionKey,
      });
      expect(fs.existsSync(channelTranscriptPath)).toBe(true);
      expect(fs.existsSync(harnessTranscriptPath)).toBe(true);

      const staleResult = await teamsApi.runtime.channel.session.resetSessionEntryLifecycle({
        channelId: "msteams",
        expectedSessionId: "channel-old",
        expectedUpdatedAt: 10,
        sessionKey: channelSessionKey,
        storePath,
        update: () => ({ updatedAt: 0 }),
      });
      expect(staleResult).toBeNull();

      await expect(
        otherApi.runtime.channel.session.resetSessionEntryLifecycle({
          channelId: "msteams",
          sessionKey: channelSessionKey,
          storePath,
          update: () => ({ updatedAt: 0 }),
        }),
      ).rejects.toThrow('does not own channel "msteams"');
    } finally {
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("guards branch, rewind, and fork gateway mutations for harness-owned sessions", async () => {
    const sessionKey = "agent:main:harness:codex:thread-1";
    const entry: SessionEntry = {
      agentHarnessId: "codex",
      modelSelectionLocked: true,
      sessionId: "reserved-session",
      updatedAt: 1,
    };
    const runtime = createPluginRuntime();
    runtime.agent.session.getSessionEntry = vi.fn(() => entry);
    let gatewayRequestCalls = 0;
    const gatewayRequest = async <T = unknown>(): Promise<T> => {
      gatewayRequestCalls += 1;
      throw new Error("gateway request must not run");
    };
    runtime.gateway = {
      isAvailable: vi.fn(async () => true),
      request: gatewayRequest,
    };

    const pluginRegistry = createTestRegistry(runtime);
    const ownerApi = pluginRegistry.createApi(createRecord({ id: "codex-owner" }), {
      config: emptyConfig,
    });
    const otherApi = pluginRegistry.createApi(createRecord({ id: "other-plugin" }), {
      config: emptyConfig,
    });
    ownerApi.registerAgentHarness({
      id: "codex",
      label: "Codex",
      supports: () => ({ supported: true }),
      runAttempt: async () => {
        throw new Error("unused");
      },
    });

    for (const method of ["sessions.branches.switch", "sessions.rewind", "sessions.fork"]) {
      await expect(otherApi.runtime.gateway.request(method, { sessionKey })).rejects.toThrow(
        'owned by plugin "codex-owner"',
      );
    }
    expect(gatewayRequestCalls).toBe(0);
  });
});
