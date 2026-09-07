import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  loadSessionEntry,
  persistSessionTranscriptTurn,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { drainSessionStoreWriterQueuesForTest } from "../../config/sessions/store-writer-state.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildGatewaySessionRow } from "../../gateway/session-utils-row.js";
import { disposeOpenClawAgentDatabaseByPath } from "../../state/openclaw-agent-db.js";
import { accountAgentTurn } from "./agent-runner-result-accounting.js";
import { createMockFollowupRun } from "./test-helpers.js";

const diagnostic = { provider: "primary-fixture", model: "thinking" };
let root: string;
let storePath: string;
let sequence = 0;
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-fallback-projection-"));
  storePath = path.join(root, "openclaw-agent.sqlite");
});
afterAll(async () => {
  await drainSessionStoreWriterQueuesForTest();
  disposeOpenClawAgentDatabaseByPath(storePath);
  fs.rmSync(root, { recursive: true, force: true });
});

async function createFixture() {
  const id = ++sequence;
  const sessionKey = `agent:main:fallback-${id}`;
  const entry: InternalSessionEntry = {
    sessionId: `fallback-session-${id}`,
    lifecycleRevision: "generation-1",
    updatedAt: 1,
    modelProvider: diagnostic.provider,
    model: diagnostic.model,
  };
  const cfg: OpenClawConfig = { session: { store: storePath } };
  await replaceSessionEntry({ storePath, sessionKey }, entry);
  const context: Parameters<typeof accountAgentTurn>[0] = {
    activeSessionEntry: entry,
    activeSessionStore: { [sessionKey]: entry },
    blockReplyPipeline: null,
    cfg,
    defaultModel: diagnostic.model,
    followupRun: createMockFollowupRun({
      run: {
        sessionId: entry.sessionId,
        sessionKey,
        agentDir: root,
        workspaceDir: root,
        config: cfg,
        provider: diagnostic.provider,
        model: diagnostic.model,
      },
    }),
    isHeartbeat: false,
    pendingToolTasks: new Set(),
    preflightCompactionApplied: false,
    resolvedVerboseLevel: "off",
    execution: {
      kind: "settled",
      status: "ok",
      result: { payloads: [{ text: "done" }], meta: { durationMs: 1 } },
      resolved: { provider: diagnostic.provider, model: diagnostic.model },
      fallback: { exhausted: false, attempts: [] },
      autoCompactionCount: 0,
      didLogHeartbeatStrip: false,
    },
    runId: `fallback-run-${id}`,
    runStartedAt: Date.now(),
    sessionCtx: {},
    sessionKey,
    shouldInjectGroupIntro: false,
    storePath,
  };
  return {
    context,
    read: () => loadSessionEntry({ storePath, sessionKey, readConsistency: "latest" }),
    replace: (next: InternalSessionEntry) => replaceSessionEntry({ storePath, sessionKey }, next),
    account: async (route: { provider: string; model: string }) => {
      context.execution.result.meta.agentMeta = {
        sessionId: entry.sessionId,
        contextTokens: 1_000,
        ...route,
      };
      return accountAgentTurn(context);
    },
  };
}

it.each([false, true])(
  "projects a completed fallback with stored primary=%s",
  async (storedPrimary) => {
    const fixture = await createFixture();
    const { context } = fixture;
    const entry = context.activeSessionEntry!;
    if (!storedPrimary) {
      delete entry.model;
      delete entry.modelProvider;
    }
    await fixture.replace(entry);
    context.cfg.agents = {
      defaults: { model: { primary: `${diagnostic.provider}/${diagnostic.model}` } },
    };
    context.execution.resolved = { provider: "fallback-fixture", model: "plain" };
    context.execution.fallback.attempts = [
      {
        provider: diagnostic.provider,
        model: diagnostic.model,
        error: "model not found",
        reason: "model_not_found",
      },
    ];

    await fixture.account({ provider: "fallback-fixture", model: "plain" });
    await persistSessionTranscriptTurn(
      { agentId: "main", storePath, sessionKey: context.sessionKey!, sessionId: entry.sessionId },
      {
        config: context.cfg,
        expectedSessionId: entry.sessionId,
        runId: context.runId,
        messages: [
          {
            message: {
              role: "assistant",
              content: [{ type: "text", text: "done" }],
              provider: "fallback-fixture",
              model: "plain",
              stopReason: "stop",
            },
          },
        ],
        sessionLifecyclePatch: { status: "done", lastRunId: context.runId },
      },
    );

    const stored = fixture.read()!;
    expect(stored.fallbackNotice).toMatchObject({
      selectedModel: `${diagnostic.provider}/${diagnostic.model}`,
      activeModel: "fallback-fixture/plain",
    });
    const project = (rowEntry: InternalSessionEntry) =>
      buildGatewaySessionRow({
        cfg: context.cfg,
        agentId: "main",
        skipTranscriptUsageFallback: true,
        lightweightListRow: true,
        storePath,
        store: { [context.sessionKey!]: rowEntry },
        key: context.sessionKey!,
        entry: rowEntry,
      });
    expect(project(stored)).toMatchObject({
      modelProvider: diagnostic.provider,
      model: diagnostic.model,
      activeModelProvider: "fallback-fixture",
      activeModel: "plain",
    });
    for (const changed of [
      { status: "running" as const },
      { lastRunId: "another-run" },
      { sessionId: "another-session" },
      { providerOverride: "another-provider", modelOverride: "another-model" },
    ]) {
      const row = project({ ...stored, ...changed });
      expect(row.activeModel, JSON.stringify(changed)).toBeUndefined();
      expect(row.activeModelProvider, JSON.stringify(changed)).toBeUndefined();
    }

    const recoveryRunId = `${context.runId}-recovery`;
    await persistSessionTranscriptTurn(
      { agentId: "main", storePath, sessionKey: context.sessionKey!, sessionId: entry.sessionId },
      {
        config: context.cfg,
        expectedSessionId: entry.sessionId,
        runId: context.runId,
        messages: [
          {
            message: {
              role: "assistant",
              content: [{ type: "text", text: "hidden answer" }],
              display: false,
              provider: "fallback-fixture",
              model: "plain",
              stopReason: "stop",
            },
          },
        ],
      },
    );
    expect(project(fixture.read()!).activeModel).toBeUndefined();
    await persistSessionTranscriptTurn(
      { agentId: "main", storePath, sessionKey: context.sessionKey!, sessionId: entry.sessionId },
      {
        config: context.cfg,
        expectedSessionId: entry.sessionId,
        runId: recoveryRunId,
        messages: [
          {
            message: {
              role: "assistant",
              content: [{ type: "text", text: "recovered" }],
              provider: diagnostic.provider,
              model: diagnostic.model,
              stopReason: "length",
            },
          },
        ],
        sessionLifecyclePatch: { status: "done", lastRunId: recoveryRunId },
      },
    );
    // The newer completed primary answer rejects the old notice even before accounting clears it.
    const recovered = fixture.read()!;
    expect(recovered.fallbackNotice).toEqual(stored.fallbackNotice);
    expect(project(recovered)).toMatchObject({
      modelProvider: diagnostic.provider,
      model: diagnostic.model,
      activeModelProvider: undefined,
      activeModel: undefined,
    });
    context.execution.resolved = { provider: diagnostic.provider, model: diagnostic.model };
    context.execution.fallback.attempts = [];
    await fixture.account({ provider: diagnostic.provider, model: diagnostic.model });
    expect(fixture.read()?.fallbackNotice).toBeUndefined();
  },
);
