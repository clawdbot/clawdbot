import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { listSessionEntries, upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { vi } from "vitest";
import type {
  CodexSessionCatalogControl,
  CodexSessionCatalogControlFactory,
} from "../session-catalog-types.js";
import type { CodexThreadForkParams, CodexTurn } from "./protocol.js";

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

export function createForkTestRuntime(storePath: string) {
  const runtime = createPluginRuntimeMock();
  const createSession = vi.mocked(runtime.agent.session.createSessionEntry);
  const initialize = createSession.getMockImplementation()!;
  createSession.mockImplementation(async (params) => {
    if (params.recoverMatchingInitialEntry) {
      throw new Error("Message forks must initialize a fresh child, not recover an existing one");
    }
    // The generic runtime mock omits the Gateway's per-agent label uniqueness contract.
    const label = params.label?.trim();
    if (
      label &&
      listSessionEntries({ storePath, agentId: params.agentId }).some(
        (stored) => stored.sessionKey !== params.key && stored.entry.label === label,
      )
    ) {
      throw new Error(`label already in use: ${label}`);
    }
    return await initialize({
      ...params,
      afterCreate: async (entry) => {
        await upsertSessionEntry({
          sessionKey: entry.key,
          storePath,
          entry: entry.entry,
        });
        return await params.afterCreate?.(entry);
      },
    });
  });
  return runtime;
}
