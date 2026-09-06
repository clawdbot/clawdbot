// Shared isolated ownership fixtures and real preparation adapters for native authority tests.
import { promises as fs } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, vi } from "vitest";
import {
  clearConfigCache,
  clearRuntimeConfigSnapshot,
  getRuntimeConfig,
} from "../../../config/config.js";
import { registerChatAbortController } from "../../../gateway/chat-abort.js";
import { createChatAbortContext } from "../../../gateway/server-methods/chat.abort.test-helpers.js";
import type { GatewayRequestContext } from "../../../gateway/server-methods/types.js";
import {
  registerSessionBindingAdapter,
  unregisterSessionBindingAdapter,
  type SessionBindingAdapter,
  type SessionBindingRecord,
} from "../../../infra/outbound/session-binding-service.js";
import * as privateStores from "../../../infra/private-file-store.js";
import { flushLogger, resetLogger } from "../../../logging/logger.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../../plugins/runtime.js";
import { bindGatewayContextResolver } from "../../../plugins/runtime/gateway-request-scope.js";
import { resetTaskFlowRegistryForTests } from "../../../tasks/task-flow-registry.test-support.js";
import * as taskControlRuntime from "../../../tasks/task-registry-control.runtime.js";
import {
  resetTaskRegistryForTests,
  setTaskRegistryControlRuntimeForTests,
  resetTaskRegistryControlRuntimeForTests,
} from "../../../tasks/task-registry.test-support.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../../test-utils/channel-plugins.js";
import { captureEnv, setTestEnvValue } from "../../../test-utils/env.js";
import { cleanupSessionStateForTest } from "../../../test-utils/session-state-cleanup.js";
import {
  createOperationalRunInstanceRef,
  getAdmittedRunDelegatedAuthority,
  prepareAgentRunAdmission,
} from "../../admitted-run-context.js";
import {
  settleSubagentRegistryPersistenceWork,
  writeSubagentSessionEntry,
} from "../registry/subagent-registry.persistence.test-support.js";
import {
  resetSubagentRegistryForTests,
  testing as registryTesting,
} from "../registry/subagent-registry.test-helpers.js";
import { testing as schedulerTesting } from "../swarm/swarm-scheduler.test-support.js";
import { testing as spawnTesting } from "./subagent-spawn.test-support.js";

export function installSpawnThreadBindingFixture(
  onBound?: (binding: SessionBindingRecord) => Promise<void>,
) {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "matrix",
        source: "test",
        plugin: {
          ...createChannelTestPluginBase({ id: "matrix" }),
          conversationBindings: { defaultTopLevelPlacement: "child" },
        },
      },
    ]),
  );
  const bindings: SessionBindingRecord[] = [];
  const bind = vi.fn<NonNullable<SessionBindingAdapter["bind"]>>(async (input) => {
    const binding: SessionBindingRecord = {
      bindingId: "synthetic-thread",
      targetSessionKey: input.targetSessionKey,
      targetKind: input.targetKind,
      status: "active",
      boundAt: Date.now(),
      conversation: {
        ...input.conversation,
        conversationId: "child-thread",
        parentConversationId: "parent",
      },
    };
    bindings.push(binding);
    await onBound?.(binding);
    return binding;
  });
  const adapter: SessionBindingAdapter = {
    channel: "matrix",
    accountId: "default",
    bind,
    capabilities: { placements: ["child"] },
    listBySession: (key) => bindings.filter((binding) => binding.targetSessionKey === key),
    resolveByConversation: (ref) =>
      bindings.find((binding) => binding.conversation.conversationId === ref.conversationId) ??
      null,
    unbind: async (input) => {
      const removed = bindings.filter(
        (binding) =>
          input.targetSessionKey === binding.targetSessionKey ||
          input.bindingId === binding.bindingId,
      );
      for (const binding of removed) {
        bindings.splice(bindings.indexOf(binding), 1);
      }
      return removed;
    },
  };
  registerSessionBindingAdapter(adapter);
  return {
    bind,
    bindings,
    unregister: () =>
      unregisterSessionBindingAdapter({
        channel: adapter.channel,
        accountId: adapter.accountId,
        adapter,
      }),
  };
}

export function installSpawnAttachmentFixture(params: {
  stateDir: string;
  admitted: Parameters<typeof getAdmittedRunDelegatedAuthority>[0];
  pauseAt?: "directory" | "files";
  entered: () => void;
  release: Promise<void>;
}) {
  const root = path.join(params.stateDir, ".openclaw", "attachments");
  const lateWrites: string[] = [];
  const attachmentDirs: string[] = [];
  const mkdir = fs.mkdir;
  const mkdirSpy = vi.spyOn(fs, "mkdir").mockImplementation(async (...args) => {
    const result = await mkdir(...args);
    if (typeof args[0] === "string" && path.dirname(args[0]) === root) {
      attachmentDirs.push(args[0]);
      if (!getAdmittedRunDelegatedAuthority(params.admitted)) {
        lateWrites.push("directory");
      }
      if (params.pauseAt === "directory") {
        params.entered();
        await params.release;
      }
    }
    return result;
  });
  const createStore = privateStores.privateFileStore;
  const storeSpy = vi.spyOn(privateStores, "privateFileStore").mockImplementation((rootDir) => {
    const store = createStore(rootDir);
    if (path.dirname(rootDir) !== root) {
      return store;
    }
    return {
      ...store,
      writeText: async (...args) => {
        if (!getAdmittedRunDelegatedAuthority(params.admitted)) {
          lateWrites.push("content");
        }
        const result = await store.writeText(...args);
        expect(await fs.readFile(path.join(rootDir, args[0]), "utf8")).toBe("synthetic attachment");
        if (params.pauseAt === "files") {
          params.entered();
          await params.release;
        }
        return result;
      },
      writeJson: async (...args) => {
        if (!getAdmittedRunDelegatedAuthority(params.admitted)) {
          lateWrites.push("manifest");
        }
        return await store.writeJson(...args);
      },
    };
  });
  return {
    lateWrites,
    attachmentDirs,
    restore: () => {
      mkdirSpy.mockRestore();
      storeSpy.mockRestore();
    },
  };
}

export function installSpawnAuthorityFixture() {
  const parentSessionKey = "agent:main:main";
  const parentRunId = "pending-spawn-parent";
  const groupId = "pending-spawn";
  const env = captureEnv(["OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH"]);
  let stateDir = "";
  let pluginSnapshot: ReturnType<typeof captureActivePluginRegistrySnapshot>;

  beforeEach(async () => {
    pluginSnapshot = captureActivePluginRegistrySnapshot();
    stateDir = await realpath(await mkdtemp(path.join(os.tmpdir(), "openclaw-spawn-authority-")));
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    setTestEnvValue("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
    await writeFile(
      path.join(stateDir, "openclaw.json"),
      JSON.stringify({
        logging: { audit: { enabled: false } },
        tools: {
          swarm: { enabled: true, maxConcurrent: 1 },
          sessions_spawn: { attachments: { enabled: true } },
        },
        agents: {
          defaults: { workspace: stateDir, model: { primary: "openai/gpt-5.4" } },
          entries: { main: { workspace: stateDir } },
        },
      }),
    );
    clearConfigCache();
    clearRuntimeConfigSnapshot();
    resetSubagentRegistryForTests({ persist: false });
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
    // The source test supplies the real ESM owner through the existing CJS runtime seam.
    setTaskRegistryControlRuntimeForTests(taskControlRuntime);
    registryTesting.setDepsForTest({
      loadAgentRuntimePluginRegistryHandle: () => undefined,
      callGateway: async (request) => {
        if (request.method !== "agent.wait") {
          throw new Error(`Unexpected registry RPC ${request.method}`);
        }
        return await new Promise<never>(() => {});
      },
    });
  });

  afterEach(async () => {
    await settleSubagentRegistryPersistenceWork();
    resetSubagentRegistryForTests({ persist: false });
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
    schedulerTesting.reset();
    resetTaskRegistryControlRuntimeForTests();
    await cleanupSessionStateForTest({ stateDir });
    registryTesting.setDepsForTest();
    spawnTesting.setDepsForTest();
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    await flushLogger();
    resetLogger();
    await rm(stateDir, { recursive: true, force: true });
    restoreActivePluginRegistrySnapshot(pluginSnapshot);
    env.restore();
  });

  async function createBoundParent(runtime: "embedded" | "plugin-harness" = "embedded") {
    const cfg = getRuntimeConfig();
    const storePath = await writeSubagentSessionEntry({
      stateDir,
      agentId: "main",
      sessionKey: parentSessionKey,
      defaultSessionId: "parent-session",
    });
    const context = createChatAbortContext({
      getRuntimeConfig: () => cfg,
      getSessionEventSubscriberConnIds: () => new Set(),
      broadcastToConnIds: vi.fn(),
    });
    const admission = prepareAgentRunAdmission({
      cfg,
      operationalRunInstance: createOperationalRunInstanceRef(parentRunId),
      facts: {
        runId: parentRunId,
        agentId: "main",
        ingress: { kind: "system", boundary: "spawn-authority-test", state: "present" },
      },
    });
    const parent = registerChatAbortController({
      chatAbortControllers: context.chatAbortControllers,
      runId: parentRunId,
      sessionKey: parentSessionKey,
      sessionId: "parent-session",
      agentId: "main",
      ownerConnId: "owner-connection",
      timeoutMs: 60_000,
      operationalRunInstance: admission.operationalRunInstance,
    });
    const admitted = await admission.admit(runtime);
    // Match agent-run-execution-phase: bind the admitted owner before tools run.
    bindGatewayContextResolver(admitted, () => context as unknown as GatewayRequestContext);
    const authority = getAdmittedRunDelegatedAuthority(admitted)!;
    parent.bindAgentRunDelegatedAuthority(authority);
    expect(parent.entry?.operationalRunInstance).toBe(admitted.operationalRunInstance);
    expect(parent.entry?.agentRunDelegatedAuthority).toBe(authority);
    expect(admitted.executionIdentityToken).toBeUndefined();

    return { cfg, storePath, context, admission, parent, admitted, authority };
  }

  return {
    parentSessionKey,
    parentRunId,
    groupId,
    createBoundParent,
    get stateDir() {
      return stateDir;
    },
  };
}
