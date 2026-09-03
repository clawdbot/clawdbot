import {
  createCapturedPluginRegistration,
  createEmptyPluginRegistry,
  createPluginRecord,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { vi } from "vitest";
import { createCodexAppServerAgentHarness } from "../../harness.js";
import type {
  CodexSessionCatalogControl,
  CodexSessionCatalogControlFactory,
} from "../session-catalog-types.js";
import type { CodexThreadForkParams, CodexTurn } from "./protocol.js";
import { createCodexTestBindingStore } from "./session-binding.test-helpers.js";

export function codexForkTurn(id: string, text: string): CodexTurn {
  return {
    id,
    status: "completed",
    items: [
      {
        aggregatedOutput: null,
        changes: [],
        command: null,
        cwd: null,
        id: `${id}-user`,
        name: null,
        query: null,
        server: null,
        status: null,
        text: "",
        title: null,
        tool: null,
        content: [{ type: "text", text, text_elements: [] }],
        type: "userMessage",
      },
    ],
  };
}

export function forkResponse(threadId = "thread-forked") {
  return {
    approvalPolicy: "never",
    approvalsReviewer: "user",
    cwd: "/tmp",
    model: "gpt-5.6-luna",
    modelProvider: "openai",
    sandbox: { type: "dangerFullAccess" },
    thread: {
      id: threadId,
      sessionId: "session-forked",
      projectId: null,
      cliVersion: "0.150.1",
      createdAt: 1715299200,
      updatedAt: 1715299200,
      cwd: "/tmp",
      ephemeral: false,
      modelProvider: "openai",
      preview: "forked thread",
      source: "appServer" as const,
      status: { type: "notLoaded" as const },
      turns: [],
    },
  };
}

export function forkParams() {
  return {
    targetKey: "agent:main:dashboard:forked",
    source: {
      agentId: "main",
      sessionId: "session-source",
      sessionKey: "agent:main:source",
      storePath: "/tmp/sessions.db",
      entryId: "entry-2",
    },
    upstream: {
      catalogId: "codex",
      hostId: "gateway:local",
      kind: "codex-app-server" as const,
      threadId: "thread-source",
      ref: { connectionFingerprint: "fingerprint", threadId: "thread-source" },
    },
  };
}

type ForkThreadStub = (params: CodexThreadForkParams) => Promise<unknown>;

function factoryForControl(control: CodexSessionCatalogControl): CodexSessionCatalogControlFactory {
  return {
    forRequest: () => control,
    homesForAgent: () => [],
    forUpstream: (_agentId, fingerprint) =>
      fingerprint === control.connectionFingerprint ? control : undefined,
  };
}

export function forkControl(
  forkThread: ForkThreadStub = vi.fn(async () => forkResponse()),
  connectionFingerprint = "fingerprint",
) {
  const archiveThread = vi.fn(async () => undefined);
  const control = {
    archiveThread,
    clientId: "client-pinned",
    connectionFingerprint,
    forkThread,
  } as unknown as CodexSessionCatalogControl;
  control.withPinnedConnection = async (run) => await run(control);
  return { archiveThread, control, controlFactory: factoryForControl(control), forkThread };
}

export function createForkTestRuntime(
  storePath?: string,
  bindingStore = createCodexTestBindingStore(),
  id = "codex",
) {
  const { api } = createCapturedPluginRegistration({
    id: "codex",
    config: storePath ? { session: { store: storePath } } : {},
  });
  const registry = createEmptyPluginRegistry();
  registry.plugins.push(createPluginRecord({ id: "codex" }));
  registry.agentHarnesses.push({
    pluginId: "codex",
    source: "runtime",
    harness: createCodexAppServerAgentHarness({ id, bindingStore, runtime: api.runtime }),
  });
  setActivePluginRegistry(registry);
  vi.spyOn(api.runtime.agent.session, "createSessionEntry");
  return api.runtime;
}
