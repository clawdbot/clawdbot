// Verifies plugin registry ownership around lifecycle session resets.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginRecord } from "./loader-records.js";
import type { OpenClawPluginApi } from "./plugin-api.types.js";
import { markPluginRegistryActive } from "./registry-lifecycle.js";
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

function registerTestChannel(api: OpenClawPluginApi, id: string) {
  api.registerChannel({
    plugin: {
      id,
      meta: {
        id,
        label: id,
        selectionLabel: id,
        docsPath: `/channels/${id}`,
        blurb: "test channel",
      },
      capabilities: { chatTypes: ["direct"] },
      config: {
        listAccountIds: () => [],
        resolveAccount: () => ({ accountId: "default" }),
      },
      outbound: { deliveryMode: "direct" },
    },
  });
}

describe("plugin registry runtime session policy", () => {
  it("lets only the channel and harness owners rotate locked sessions", async () => {
    const tempDir = tempDirs.make("openclaw-plugin-session-reset-");
    const storePath = path.join(tempDir, "sessions.json");
    const channelSessionKey = "agent:main:msteams:direct:user-aad";
    const unlockedChannelSessionKey = "agent:main:msteams:direct:user-unlocked";
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
      const ownerRecord = createRecord({ id: "codex-owner" });
      const teamsRecord = createRecord({ id: "msteams", channelIds: ["msteams"] });
      const otherRecord = createRecord({ id: "other-plugin" });
      const voiceRecord = createRecord({ id: "voice-call" });
      const ownerApi = pluginRegistry.createApi(ownerRecord, {
        config: emptyConfig,
      });
      const teamsApi = pluginRegistry.createApi(teamsRecord, { config: emptyConfig });
      const otherApi = pluginRegistry.createApi(otherRecord, {
        config: emptyConfig,
      });
      const voiceApi = pluginRegistry.createApi(voiceRecord, {
        config: emptyConfig,
      });
      registerTestChannel(teamsApi, "msteams");
      registerTestChannel(otherApi, "other-plugin");
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
      pluginRegistry.registry.plugins.push(ownerRecord, teamsRecord, otherRecord, voiceRecord);
      markPluginRegistryActive(pluginRegistry.registry);
      for (const registration of pluginRegistry.registry.channels) {
        expect(registration.resolveChannelRuntime?.()).toBeDefined();
      }

      await expect(
        voiceApi.runtime.agent.session.resetSessionEntryLifecycle({
          sessionKey: harnessSessionKey,
          storePath,
          update: () => ({ updatedAt: 0 }),
        }),
      ).rejects.toThrow('owned by plugin "codex-owner"');

      await runtime.agent.session.upsertSessionEntry({
        agentId: "main",
        entry: {
          label: "Unlocked Teams",
          sessionId: "channel-unlocked",
          updatedAt: 15,
        },
        sessionKey: unlockedChannelSessionKey,
        storePath,
      });
      await expect(
        otherApi.runtime.agent.session.resetSessionEntryLifecycle({
          expectedSessionId: "channel-unlocked",
          expectedUpdatedAt: 15,
          sessionKey: unlockedChannelSessionKey,
          storePath,
          update: () => ({ updatedAt: 0 }),
        }),
      ).rejects.toThrow("only when it owns the active agent harness");
      expect(
        runtime.agent.session.getSessionEntry({
          sessionKey: unlockedChannelSessionKey,
          storePath,
        }),
      ).toMatchObject({ sessionId: "channel-unlocked", updatedAt: 15 });

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

  it("rejects a revoked channel runtime before the real session store is mutated", async () => {
    const tempDir = tempDirs.make("openclaw-plugin-revoked-session-reset-");
    const storePath = path.join(tempDir, "sessions.json");
    const sessionKey = "agent:main:msteams:direct:user-aad";
    const runtime = createPluginRuntime();
    await runtime.agent.session.upsertSessionEntry({
      agentId: "main",
      entry: { sessionId: "revoked-old", updatedAt: 10 },
      sessionKey,
      storePath,
    });
    const pluginRegistry = createTestRegistry(runtime);
    const teamsRecord = createRecord({ id: "msteams", channelIds: ["msteams"] });
    const teamsApi = pluginRegistry.createApi(teamsRecord, { config: emptyConfig });
    registerTestChannel(teamsApi, "msteams");
    pluginRegistry.registry.plugins.push(teamsRecord);
    markPluginRegistryActive(pluginRegistry.registry);
    expect(pluginRegistry.registry.channels[0]?.resolveChannelRuntime?.()).toBeDefined();
    const retainedSessionRuntime = teamsApi.runtime.channel.session;

    pluginRegistry.rollbackPluginGlobalSideEffects("msteams", teamsRecord);

    await expect(
      retainedSessionRuntime.resetSessionEntryLifecycle({
        channelId: "msteams",
        expectedSessionId: "revoked-old",
        expectedUpdatedAt: 10,
        sessionKey,
        storePath,
        update: () => ({ updatedAt: 0 }),
      }),
    ).rejects.toThrow('Plugin "msteams" channel session runtime is no longer active.');
    expect(runtime.agent.session.getSessionEntry({ sessionKey, storePath })).toMatchObject({
      sessionId: "revoked-old",
      updatedAt: 10,
    });
  });

  it("revalidates a channel owner after awaited reset work before final persistence", async () => {
    const tempDir = tempDirs.make("openclaw-plugin-inflight-revoked-session-reset-");
    const storePath = path.join(tempDir, "sessions.json");
    const sessionKey = "agent:main:msteams:direct:user-aad";
    const runtime = createPluginRuntime();
    await runtime.agent.session.upsertSessionEntry({
      agentId: "main",
      entry: { sessionId: "inflight-old", updatedAt: 10 },
      sessionKey,
      storePath,
    });
    const pluginRegistry = createTestRegistry(runtime);
    const teamsRecord = createRecord({ id: "msteams", channelIds: ["msteams"] });
    const teamsApi = pluginRegistry.createApi(teamsRecord, { config: emptyConfig });
    registerTestChannel(teamsApi, "msteams");
    pluginRegistry.registry.plugins.push(teamsRecord);
    markPluginRegistryActive(pluginRegistry.registry);
    expect(pluginRegistry.registry.channels[0]?.resolveChannelRuntime?.()).toBeDefined();
    const retainedSessionRuntime = teamsApi.runtime.channel.session;

    let enterUpdate = () => {};
    const updateEntered = new Promise<void>((resolve) => {
      enterUpdate = resolve;
    });
    let releaseUpdate = () => {};
    const updateReleased = new Promise<void>((resolve) => {
      releaseUpdate = resolve;
    });
    const reset = retainedSessionRuntime.resetSessionEntryLifecycle({
      channelId: "msteams",
      expectedSessionId: "inflight-old",
      expectedUpdatedAt: 10,
      sessionKey,
      storePath,
      update: async () => {
        enterUpdate();
        await updateReleased;
        return { updatedAt: 0 };
      },
    });
    await updateEntered;
    pluginRegistry.rollbackPluginGlobalSideEffects("msteams", teamsRecord);
    releaseUpdate();

    await expect(reset).rejects.toThrow(
      'Plugin "msteams" channel session runtime is no longer active.',
    );
    const pending = runtime.agent.session.getSessionEntry({ sessionKey, storePath });
    expect(pending).toMatchObject({ initializationPending: true, sessionId: "inflight-old" });
    expect(pending?.lifecycleRevision).toMatch(/^reset:/);
  });

  it("rejects a replaced channel runtime before I/O while the replacement resets the real store", async () => {
    const tempDir = tempDirs.make("openclaw-plugin-replaced-session-reset-");
    const storePath = path.join(tempDir, "sessions.json");
    const sessionKey = "agent:main:msteams:direct:user-aad";
    const runtime = createPluginRuntime();
    await runtime.agent.session.upsertSessionEntry({
      agentId: "main",
      entry: { sessionId: "replacement-old", updatedAt: 10 },
      sessionKey,
      storePath,
    });
    const pluginRegistry = createTestRegistry(runtime);
    const firstRecord = createRecord({ id: "msteams", channelIds: ["msteams"] });
    const firstApi = pluginRegistry.createApi(firstRecord, { config: emptyConfig });
    registerTestChannel(firstApi, "msteams");
    pluginRegistry.registry.plugins.push(firstRecord);
    markPluginRegistryActive(pluginRegistry.registry);
    expect(pluginRegistry.registry.channels[0]?.resolveChannelRuntime?.()).toBeDefined();
    const retainedSessionRuntime = firstApi.runtime.channel.session;

    pluginRegistry.rollbackPluginGlobalSideEffects("msteams", firstRecord);
    pluginRegistry.registry.plugins.splice(0, 1);
    const replacementRecord = createRecord({ id: "msteams", channelIds: ["msteams"] });
    const replacementApi = pluginRegistry.createApi(replacementRecord, { config: emptyConfig });
    registerTestChannel(replacementApi, "msteams");
    pluginRegistry.registry.plugins.push(replacementRecord);
    expect(pluginRegistry.registry.channels[0]?.resolveChannelRuntime?.()).toBeDefined();
    const replacementSessionRuntime = replacementApi.runtime.channel.session;
    const request = {
      channelId: "msteams",
      expectedSessionId: "replacement-old",
      expectedUpdatedAt: 10,
      sessionKey,
      storePath,
      update: () => ({ updatedAt: 0 }),
    };

    await expect(retainedSessionRuntime.resetSessionEntryLifecycle(request)).rejects.toThrow(
      'Plugin "msteams" channel session runtime is no longer active.',
    );
    expect(runtime.agent.session.getSessionEntry({ sessionKey, storePath })).toMatchObject({
      sessionId: "replacement-old",
      updatedAt: 10,
    });
    const replacement = await replacementSessionRuntime.resetSessionEntryLifecycle(request);
    expect(replacement).toMatchObject({ updatedAt: 0 });
    expect(replacement?.sessionId).not.toBe("replacement-old");
    expect(runtime.agent.session.getSessionEntry({ sessionKey, storePath })?.sessionId).toBe(
      replacement?.sessionId,
    );
  });

  it("leaves a fresh ownerless row when release changes the reservation through the full owner path", async () => {
    const tempDir = tempDirs.make("openclaw-plugin-released-owner-reset-");
    const storePath = path.join(tempDir, "sessions.json");
    const sessionKey = "agent:main:msteams:direct:user-aad";
    const runtime = createPluginRuntime();
    await runtime.agent.session.upsertSessionEntry({
      agentId: "main",
      entry: {
        agentHarnessId: "codex",
        modelSelectionLocked: true,
        sessionId: "released-old",
        updatedAt: 10,
      },
      sessionKey,
      storePath,
    });

    const pluginRegistry = createTestRegistry(runtime);
    const ownerRecord = createRecord({ id: "codex-owner" });
    const teamsRecord = createRecord({ id: "msteams", channelIds: ["msteams"] });
    const ownerApi = pluginRegistry.createApi(ownerRecord, { config: emptyConfig });
    const teamsApi = pluginRegistry.createApi(teamsRecord, { config: emptyConfig });
    registerTestChannel(teamsApi, "msteams");
    const harnessReset = vi.fn(async () => {
      const reserved = runtime.agent.session.getSessionEntry({ sessionKey, storePath });
      if (!reserved) {
        throw new Error("expected reserved session entry");
      }
      await runtime.agent.session.upsertSessionEntry({
        agentId: "main",
        entry: { ...reserved, updatedAt: 11 },
        sessionKey,
        storePath,
      });
    });
    ownerApi.registerAgentHarness({
      id: "codex",
      label: "Codex",
      reset: harnessReset,
      supports: () => ({ supported: true }),
      runAttempt: async () => {
        throw new Error("unused");
      },
    });
    pluginRegistry.registry.plugins.push(ownerRecord, teamsRecord);
    markPluginRegistryActive(pluginRegistry.registry);
    expect(pluginRegistry.registry.channels[0]?.resolveChannelRuntime?.()).toBeDefined();

    await expect(
      teamsApi.runtime.channel.session.resetSessionEntryLifecycle({
        channelId: "msteams",
        expectedSessionId: "released-old",
        expectedUpdatedAt: 10,
        sessionKey,
        storePath,
        update: () => ({ updatedAt: 0 }),
      }),
    ).rejects.toThrow("skipped after physical owner release");

    expect(harnessReset).toHaveBeenCalledOnce();
    const replacement = runtime.agent.session.getSessionEntry({ sessionKey, storePath });
    expect(replacement?.sessionId).toBeTruthy();
    expect(replacement?.sessionId).not.toBe("released-old");
    expect(replacement?.agentHarnessId).toBeUndefined();
    expect(replacement?.modelSelectionLocked).toBeUndefined();
    expect(replacement?.lifecycleRevision).toBeUndefined();
  });

  it("rejects final channel persistence when revocation occurs during physical-owner reset", async () => {
    const tempDir = tempDirs.make("openclaw-plugin-owner-reset-revoked-");
    const storePath = path.join(tempDir, "sessions.json");
    const sessionKey = "agent:main:msteams:direct:user-aad";
    const runtime = createPluginRuntime();
    await runtime.agent.session.upsertSessionEntry({
      agentId: "main",
      entry: {
        agentHarnessId: "codex",
        label: "old-label",
        modelSelectionLocked: true,
        sessionId: "released-old",
        updatedAt: 10,
      },
      sessionKey,
      storePath,
    });

    const pluginRegistry = createTestRegistry(runtime);
    const ownerRecord = createRecord({ id: "codex-owner" });
    const teamsRecord = createRecord({ id: "msteams", channelIds: ["msteams"] });
    const ownerApi = pluginRegistry.createApi(ownerRecord, { config: emptyConfig });
    const teamsApi = pluginRegistry.createApi(teamsRecord, { config: emptyConfig });
    registerTestChannel(teamsApi, "msteams");
    const harnessReset = vi.fn(async () => {
      pluginRegistry.rollbackPluginGlobalSideEffects("msteams", teamsRecord);
    });
    ownerApi.registerAgentHarness({
      id: "codex",
      label: "Codex",
      reset: harnessReset,
      supports: () => ({ supported: true }),
      runAttempt: async () => {
        throw new Error("unused");
      },
    });
    pluginRegistry.registry.plugins.push(ownerRecord, teamsRecord);
    markPluginRegistryActive(pluginRegistry.registry);
    expect(pluginRegistry.registry.channels[0]?.resolveChannelRuntime?.()).toBeDefined();

    await expect(
      teamsApi.runtime.channel.session.resetSessionEntryLifecycle({
        channelId: "msteams",
        expectedSessionId: "released-old",
        expectedUpdatedAt: 10,
        sessionKey,
        storePath,
        update: () => ({ label: "must-not-persist", updatedAt: 0 }),
      }),
    ).rejects.toThrow('Plugin "msteams" channel session runtime is no longer active.');

    expect(harnessReset).toHaveBeenCalledOnce();
    const replacement = runtime.agent.session.getSessionEntry({ sessionKey, storePath });
    expect(replacement?.sessionId).toBeTruthy();
    expect(replacement?.sessionId).not.toBe("released-old");
    expect(replacement?.label).toBeUndefined();
    expect(replacement?.agentHarnessId).toBeUndefined();
    expect(replacement?.modelSelectionLocked).toBeUndefined();
    expect(replacement?.initializationPending).toBeUndefined();
    expect(replacement?.lifecycleRevision).toBeUndefined();
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
