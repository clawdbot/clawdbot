import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  readActiveTranscriptEntryAnchor,
  replaceSessionEntrySync,
} from "../../config/sessions/session-accessor.js";
import {
  resolveSqliteTranscriptScope,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import { SQLITE_SESSION_WRITER_QUEUES } from "../../config/sessions/store-writer-state.js";
import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";
import { onAgentEvent } from "../../infra/agent-events.js";
import {
  resetAgentRunRegistryForTest,
  rotateAgentRunRegistryLifecycleGeneration,
  validateAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { withInstallationTarget } from "../../infra/installation-target-context.js";
import { takeMcpToolApprovalBinding } from "../../infra/mcp-tool-approval-binding.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../../plugins/hooks.test-fixtures.js";
import {
  bindGatewayContextResolver,
  withPluginRuntimeGatewayRequestScope,
} from "../../plugins/runtime/gateway-request-scope.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import {
  closeOpenClawAgentDatabaseByPath,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import {
  closeAdmittedRunDelegatedAuthority,
  createOperationalRunInstanceRef,
  getAdmittedRunDelegatedAuthority,
  prepareAgentRunAdmission,
  type PreparedAgentRunAdmission,
} from "../admitted-run-context.js";
import { runAgentToolSourceExecutionGuard } from "../agent-tool-source-execution-guard.js";
import {
  rewrapToolWithBeforeToolCallHook,
  runBeforeToolCallHook,
} from "../agent-tools.before-tool-call.js";
import {
  bindCodeModeTranscriptAuthority,
  CodeModeTranscriptAuthority,
  type TranscriptPrefixEntry,
} from "../code-mode-transcript-authority.js";
import { createAgentRunRestartAbortError } from "../run-termination.js";
import {
  attachInternalToolExecutionPreparer,
  getInternalToolExecutionPreparer,
  type InternalToolExecutionPreparer,
} from "../runtime/internal-hooks.js";
import { SessionManager } from "../sessions/session-manager.js";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import type { AnyAgentTool } from "../tools/common.js";
import { getGatewayToolCallerIdentity } from "../tools/gateway-caller-context.js";
import { callGatewayTool } from "../tools/gateway.js";
import { getInProcessGatewayToolContext } from "../tools/in-process-gateway.js";
import { createAgentHarnessHostCapabilities } from "./host-capability.js";
import { retainBeforeToolCallForNativeHookRelay } from "./host-private-capabilities.js";

vi.mock("../agent-tools.before-tool-call.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agent-tools.before-tool-call.js")>()),
  rewrapToolWithBeforeToolCallHook: vi.fn((tool) => tool),
  runBeforeToolCallHook: vi.fn(async ({ params }) => ({ blocked: false, params })),
}));
vi.mock("../tools/gateway.js", () => ({ callGatewayTool: vi.fn() }));

const mockRewrap = vi.mocked(rewrapToolWithBeforeToolCallHook);
const mockRunBefore = vi.mocked(runBeforeToolCallHook);
const mockCallGatewayTool = vi.mocked(callGatewayTool);
type HostAttempt = Parameters<typeof createAgentHarnessHostCapabilities>[0]["attempt"];
const PROVIDER_TRANSCRIPT_COMMIT = Symbol.for("openclaw.agentHarness.providerTranscriptCommit.v1");

type HostRevocationContext = {
  host: ReturnType<typeof createAgentHarnessHostCapabilities>;
  attempt: HostAttempt;
  admission: PreparedAgentRunAdmission;
};

const policyRevocations = [
  {
    name: "lexical host closure",
    revoke: async ({ host }: HostRevocationContext) => {
      host.close();
    },
  },
  {
    name: "exact authority release",
    revoke: async ({ attempt }: HostRevocationContext) => {
      expect(closeAdmittedRunDelegatedAuthority(attempt.admittedRunContext)).toBe(true);
    },
  },
  {
    name: "replacement owner",
    revoke: async ({ attempt }: HostRevocationContext) => {
      await admittedAttempt(attempt.runId);
    },
  },
];

const admissions: PreparedAgentRunAdmission[] = [];

async function admittedAttempt(
  runId = "run-1",
  overrides: Omit<Partial<HostAttempt>, "admittedRunContext" | "runId"> = {},
): Promise<{ attempt: HostAttempt; admission: PreparedAgentRunAdmission }> {
  const admission = prepareAgentRunAdmission({
    cfg: {},
    facts: {
      runId,
      agentId: "main",
      ingress: { kind: "system", boundary: "host-capability-test", state: "present" },
    },
    operationalRunInstance: createOperationalRunInstanceRef(runId),
  });
  admissions.push(admission);
  const admittedRunContext = await admission.admit("plugin-harness", `harness-${runId}`);
  return {
    admission,
    attempt: {
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      runId,
      cwd: "/attempt/worktree",
      workspaceDir: "/workspace",
      currentChannelId: "chat-1",
      messageChannel: "telegram",
      ...overrides,
      admittedRunContext,
    },
  };
}

function testTool(execute = vi.fn(async () => ({ content: [], details: {} }))): {
  tool: AnyAgentTool;
  execute: typeof execute;
} {
  return {
    execute,
    tool: {
      name: "read",
      label: "Read",
      description: "read",
      parameters: Type.Object({}),
      execute,
    },
  };
}

function bindTool(
  attempt: HostAttempt,
  tool: AnyAgentTool,
): {
  host: ReturnType<typeof createAgentHarnessHostCapabilities>;
  bound: AnyAgentTool;
} {
  const host = createAgentHarnessHostCapabilities({ attempt, pluginId: "codex" });
  const [bound] = host.capabilities.bindToolSurface([tool]);
  if (!bound) {
    throw new Error("expected bound tool");
  }
  return { host, bound };
}

async function withProviderMetadataCommit(
  run: (fixture: Awaited<ReturnType<typeof prepareProviderMetadataCommit>>) => Promise<void>,
) {
  await withOpenClawTestState({ label: "provider-metadata" }, async (state) => {
    const fixture = await prepareProviderMetadataCommit(state);
    try {
      await run(fixture);
    } finally {
      fixture.host.close();
      fixture.admission.close();
      resetGlobalHookRunner();
    }
  });
}

async function prepareProviderMetadataCommit(state: OpenClawTestState) {
  const runId = "provider-metadata";
  const scope = {
    agentId: "main",
    env: state.env,
    expectedLifecycleRevision: "provider-lifecycle",
    expectedWriterRunId: runId,
    sessionId: "provider-metadata",
    sessionKey: "agent:main:provider-metadata",
    storePath: path.join(state.sessionsDir(), "sessions.json"),
  };
  replaceSessionEntrySync(scope, {
    activeWriterRunId: runId,
    lifecycleRevision: scope.expectedLifecycleRevision,
    sessionId: scope.sessionId,
    updatedAt: 1,
  });
  const manager = SessionManager.open(scope, state.workspaceDir);
  const userId = manager.appendMessage({ role: "user", content: "read both", timestamp: 1 });
  const baseAnchor = readActiveTranscriptEntryAnchor({ ...scope, entryId: userId });
  if (!baseAnchor) {
    throw new Error("user lacks its authoritative transcript anchor");
  }
  const { attempt, admission } = await admittedAttempt(runId, {
    sessionId: scope.sessionId,
    sessionKey: scope.sessionKey,
    config: { logging: { redactPatterns: ["producer-private-note"] } },
    trigger: "memory",
    cwd: state.workspaceDir,
    workspaceDir: state.workspaceDir,
  });
  bindCodeModeTranscriptAuthority(attempt, new CodeModeTranscriptAuthority(scope));
  const host = createAgentHarnessHostCapabilities({ attempt, pluginId: "copilot" });
  type ProviderCommit = (
    params: Parameters<CodeModeTranscriptAuthority["commitPrefix"]>[0] & {
      assertCurrent: () => void;
    },
  ) => ReturnType<CodeModeTranscriptAuthority["commitPrefix"]>;
  const commit = Reflect.get(host.capabilities, PROVIDER_TRANSCRIPT_COMMIT) as
    | ProviderCommit
    | undefined;
  if (!commit) {
    throw new Error("host did not bind its private transcript commit");
  }
  const entries: TranscriptPrefixEntry[] = [
    {
      eventId: "provider-assistant",
      identity: "copilot:assistant",
      message: makeAgentAssistantMessage({
        content: [
          { type: "text", text: "reading" },
          { type: "toolCall", id: "call-first", name: "read", arguments: {} },
          { type: "toolCall", id: "call-second", name: "read", arguments: {} },
        ],
        stopReason: "toolUse",
      }),
    },
    ...["first", "second"].map((name): TranscriptPrefixEntry => ({
      eventId: `provider-${name}`,
      identity: `copilot:${name}`,
      message: {
        role: "toolResult",
        toolCallId: `call-${name}`,
        toolName: "read",
        content: [{ type: "text", text: `network ${name}` }],
        isError: false,
        timestamp: 1,
      },
    })),
  ];
  for (const { message } of entries) {
    Reflect.set(message, "__openclaw", {
      ...(message.role === "assistant"
        ? { turnTainted: true }
        : { resultContentSource: "network" }),
      producerOnly: "retained",
      nested: { origin: "network" },
      producerNote: "producer-private-note",
    });
  }
  const databaseOptions = toDatabaseOptions(resolveSqliteTranscriptScope(scope));
  const readState = () => {
    const { db } = openOpenClawAgentDatabase(databaseOptions);
    return {
      events: db
        .prepare("SELECT * FROM transcript_events WHERE session_id = ? ORDER BY seq")
        .all(scope.sessionId),
      identities: db
        .prepare("SELECT * FROM transcript_event_identities WHERE session_id = ? ORDER BY seq")
        .all(scope.sessionId),
      index: db
        .prepare("SELECT * FROM session_transcript_index_state WHERE session_id = ?")
        .get(scope.sessionId),
      node: db.prepare("SELECT * FROM session_nodes WHERE session_key = ?").get(scope.sessionKey),
      leaf: manager.getLeafId(),
      parent: manager.getAppendParentId(),
    };
  };
  return {
    scope,
    host,
    admission,
    entries,
    baseAnchor,
    readState,
    commit: () =>
      commit({ entries, baseAnchor, assertCurrent: () => host.capabilities.assertActive() }),
    reopen: () => {
      closeOpenClawAgentDatabaseByPath(openOpenClawAgentDatabase(databaseOptions).path);
      return SessionManager.open(scope, state.workspaceDir);
    },
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const admission of admissions.splice(0)) {
    admission.close();
  }
  resetAgentRunRegistryForTest();
});

describe("agent harness host capability", () => {
  it.each([
    "replacement deletion",
    "replacement falsification",
    "in-place nested mutation",
    "array metadata",
    "null metadata",
    "string metadata",
    "numeric metadata",
  ])("preserves provider-owned metadata through %s and cold replay", async (mode) => {
    await withProviderMetadataCommit(async (fixture) => {
      const source = structuredClone(fixture.entries);
      const hook = vi.fn((event: unknown) => {
        const message = (event as { message: TranscriptPrefixEntry["message"] }).message;
        const metadata = asOptionalRecord(Reflect.get(message, "__openclaw"))!;
        const content = Reflect.get(message, "content") as Array<Record<string, unknown>>;
        for (const block of content) {
          if (block.type === "text") {
            block.text = "hook content";
          }
        }
        if (mode === "in-place nested mutation") {
          metadata.turnTainted = false;
          metadata.resultContentSource = "local";
          asOptionalRecord(metadata.nested)!.origin = "local";
          metadata.hookOnly = "added";
          return undefined;
        }
        const replacement = { ...message };
        if (mode === "replacement deletion") {
          Reflect.deleteProperty(replacement, "__openclaw");
        } else {
          const hookMetadata =
            mode === "replacement falsification"
              ? {
                  turnTainted: false,
                  resultContentSource: "local",
                  nested: { origin: "local" },
                  hookOnly: "added",
                }
              : mode === "array metadata"
                ? ["forged"]
                : mode === "null metadata"
                  ? null
                  : mode === "string metadata"
                    ? "forged"
                    : 7;
          Reflect.set(replacement, "__openclaw", hookMetadata);
        }
        return { message: replacement };
      });
      initializeGlobalHookRunner(
        createMockPluginRegistry([{ hookName: "before_message_write", handler: hook }]),
      );
      const before = fixture.readState();
      const receipt = await fixture.commit();
      expect(receipt.kind).toBe("committed");
      if (receipt.kind !== "committed") {
        throw new Error("expected a committed provider group");
      }
      expect(hook).toHaveBeenCalledTimes(3);
      expect(receipt.results.map((entry) => entry.identity)).toEqual(
        source.map((entry) => entry.identity),
      );
      expect(receipt.results.map((entry) => entry.anchor.entryId)).toEqual(
        source.map((entry) => entry.eventId),
      );
      expect(receipt.results.map((entry) => entry.anchor.effectiveParentId)).toEqual([
        fixture.baseAnchor.entryId,
        "provider-assistant",
        "provider-first",
      ]);
      for (const [index, result] of receipt.results.entries()) {
        expect(result.anchor.activeMessagePosition).toBe(
          fixture.baseAnchor.activeMessagePosition + index + 1,
        );
        expect(result.anchor).toEqual(
          readActiveTranscriptEntryAnchor({ ...fixture.scope, entryId: result.anchor.entryId }),
        );
        expect(result.message).toMatchObject({
          idempotencyKey: result.identity,
          display: false,
          __openclaw: {
            ...(index === 0 ? { turnTainted: true } : { resultContentSource: "network" }),
            nested: { origin: "network" },
            producerOnly: "retained",
            providerSourceFingerprint: expect.stringMatching(/^[a-f0-9]{32}$/),
          },
        });
        expect(JSON.stringify(result.message)).not.toContain("producer-private-note");
        expect(result.message).toHaveProperty("__openclaw.producerNote", expect.any(String));
        expect(result.message).toHaveProperty("content.0.text", "hook content");
        if (mode === "replacement falsification" || mode === "in-place nested mutation") {
          expect(result.message).toHaveProperty("__openclaw.hookOnly", "added");
        } else {
          expect(result.message).not.toHaveProperty("__openclaw.hookOnly");
          expect(result.message).not.toHaveProperty("__openclaw.0");
        }
      }
      expect(fixture.readState().events.slice(0, before.events.length)).toEqual(before.events);
      expect(fixture.readState().events).toHaveLength(before.events.length + 3);
      expect(fixture.readState().identities).toHaveLength(before.identities.length + 3);
      expect(fixture.readState().leaf).toBe(before.leaf);
      expect(fixture.readState().parent).toBe(before.parent);
      const persisted = fixture.readState();
      const reopened = fixture.reopen();
      for (const result of receipt.results) {
        expect(reopened.getEntry(result.anchor.entryId)).toMatchObject({ message: result.message });
      }
      expect(reopened.getLeafId()).toBe("provider-second");
      expect(reopened.getAppendParentId()).toBe("provider-second");
      expect(await fixture.commit()).toEqual({ ...receipt, kind: "replayed" });
      expect(fixture.readState()).toEqual(persisted);
      expect(hook).toHaveBeenCalledTimes(3);
      expect(fixture.entries).toEqual(source);
    });
  });

  it.each([
    { label: "missing", metadata: undefined },
    { label: "null", metadata: null },
    { label: "array", metadata: ["invalid"] },
    { label: "string", metadata: "invalid" },
  ])(
    "retains hook-only metadata when producer metadata is not a record: $label",
    async ({ metadata }) => {
      await withProviderMetadataCommit(async (fixture) => {
        for (const entry of fixture.entries) {
          Reflect.set(entry.message, "__openclaw", metadata);
        }
        const source = structuredClone(fixture.entries);
        initializeGlobalHookRunner(
          createMockPluginRegistry([
            {
              hookName: "before_message_write",
              handler: (event) => ({
                message: {
                  ...(event as { message: TranscriptPrefixEntry["message"] }).message,
                  __openclaw: { hookOnly: "added" },
                },
              }),
            },
          ]),
        );
        const receipt = await fixture.commit();
        expect(receipt.kind).toBe("committed");
        if (receipt.kind !== "committed") {
          throw new Error("expected a committed provider group");
        }
        for (const { message } of receipt.results) {
          expect(Reflect.get(message, "__openclaw")).toEqual({
            hookOnly: "added",
            providerSourceFingerprint: expect.stringMatching(/^[a-f0-9]{32}$/),
          });
        }
        expect(fixture.entries).toEqual(source);
      });
    },
  );

  it("suppresses the entire provider group when one message is blocked", async () => {
    await withProviderMetadataCommit(async (fixture) => {
      const source = structuredClone(fixture.entries);
      const hook = vi.fn((event: unknown) => {
        const message = (event as { message: TranscriptPrefixEntry["message"] }).message;
        asOptionalRecord(asOptionalRecord(Reflect.get(message, "__openclaw"))?.nested)!.origin =
          "local";
        return message.role === "toolResult" && message.toolCallId === "call-first"
          ? { block: true }
          : undefined;
      });
      initializeGlobalHookRunner(
        createMockPluginRegistry([{ hookName: "before_message_write", handler: hook }]),
      );
      const before = fixture.readState();
      expect(await fixture.commit()).toEqual({ kind: "suppressed" });
      expect(hook).toHaveBeenCalledTimes(3);
      expect(fixture.readState()).toEqual(before);
      expect(fixture.entries).toEqual(source);
      expect(fixture.reopen().getEntries()).toHaveLength(1);
      for (const entry of fixture.entries) {
        expect(
          readActiveTranscriptEntryAnchor({ ...fixture.scope, entryId: entry.eventId }),
        ).toBeUndefined();
      }
    });
  });

  it("rejects a provider transcript commit before its retained host owner can reach SQLite", async () => {
    const { attempt } = await admittedAttempt("run-provider-assertion");
    const authority = new CodeModeTranscriptAuthority({
      expectedWriterRunId: "writer",
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      storePath: "/not-reached/sessions.json",
    });
    const commitPrefix = vi.spyOn(authority, "commitPrefix");
    bindCodeModeTranscriptAuthority(attempt, authority);
    const host = createAgentHarnessHostCapabilities({ attempt, pluginId: "codex" });
    const commit = Reflect.get(host.capabilities, PROVIDER_TRANSCRIPT_COMMIT) as
      | ((params: { assertCurrent: () => void; entries: [] }) => Promise<unknown>)
      | undefined;
    expect(commit).toEqual(expect.any(Function));

    await expect(
      commit?.({
        assertCurrent: () => {
          throw new Error("provider checkpoint replaced");
        },
        entries: [],
      }),
    ).rejects.toThrow("provider checkpoint replaced");
    expect(commitPrefix).not.toHaveBeenCalled();
    host.close();
  });

  it.each(policyRevocations)(
    "rejects a retained provider transcript commit before SQLite after $name",
    async ({ revoke }) => {
      const { attempt, admission } = await admittedAttempt("run-provider-retained");
      const authority = new CodeModeTranscriptAuthority({
        expectedWriterRunId: "writer",
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        storePath: "/not-reached/sessions.json",
      });
      const commitPrefix = vi.spyOn(authority, "commitPrefix");
      bindCodeModeTranscriptAuthority(attempt, authority);
      const host = createAgentHarnessHostCapabilities({ attempt, pluginId: "codex" });
      const commit = Reflect.get(host.capabilities, PROVIDER_TRANSCRIPT_COMMIT) as
        | ((params: { assertCurrent: () => void; entries: [] }) => Promise<unknown>)
        | undefined;
      if (!commit) {
        throw new Error("host did not bind its private transcript commit");
      }
      try {
        await revoke({ host, attempt, admission });
        await expect(commit({ assertCurrent: () => undefined, entries: [] })).rejects.toThrow();
        expect(commitPrefix).not.toHaveBeenCalled();
      } finally {
        host.close();
      }
    },
  );

  it.each([
    { mode: "allowed", error: undefined },
    { mode: "host closed", error: "code mode transcript authority is closed" },
    { mode: "authority released", error: "agent harness host capability is no longer active" },
    { mode: "owner replaced", error: "agent harness host capability is no longer active" },
  ] as const)(
    "settles a queued provider transcript commit only with current host authority ($mode)",
    async ({ mode, error }) => {
      await withOpenClawTestState({ label: "host-provider-commit" }, async (state) => {
        const runId = "run-provider-queued";
        const scope = {
          agentId: "main",
          env: state.env,
          expectedLifecycleRevision: "provider-lifecycle",
          expectedWriterRunId: runId,
          sessionId: "provider-session",
          sessionKey: "agent:main:provider-session",
          storePath: path.join(state.sessionsDir(), "sessions.json"),
        };
        replaceSessionEntrySync(scope, {
          activeWriterRunId: scope.expectedWriterRunId,
          lifecycleRevision: scope.expectedLifecycleRevision,
          sessionId: scope.sessionId,
          updatedAt: 1,
        });
        const manager = SessionManager.open(scope, state.workspaceDir);
        const assistantId = manager.appendMessage(
          makeAgentAssistantMessage({
            content: [{ type: "toolCall", id: "provider-call", name: "read", arguments: {} }],
            stopReason: "toolUse",
          }),
        );
        const baseAnchor = readActiveTranscriptEntryAnchor({ ...scope, entryId: assistantId });
        if (!baseAnchor) {
          throw new Error("assistant lacks its authoritative transcript anchor");
        }
        const resolved = resolveSqliteTranscriptScope(scope);
        const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
        const readState = () => ({
          events: database.db
            .prepare("SELECT * FROM transcript_events WHERE session_id = ? ORDER BY seq")
            .all(scope.sessionId),
          identities: database.db
            .prepare("SELECT * FROM transcript_event_identities WHERE session_id = ? ORDER BY seq")
            .all(scope.sessionId),
          index: database.db
            .prepare("SELECT * FROM session_transcript_index_state WHERE session_id = ?")
            .get(scope.sessionId),
          node: database.db
            .prepare("SELECT * FROM session_nodes WHERE session_key = ?")
            .get(scope.sessionKey),
          cursors: { leaf: manager.getLeafId(), parent: manager.getAppendParentId() },
        });
        const before = readState();
        const { attempt, admission } = await admittedAttempt(runId, {
          sessionId: scope.sessionId,
          sessionKey: scope.sessionKey,
          cwd: state.workspaceDir,
          workspaceDir: state.workspaceDir,
        });
        const authority = new CodeModeTranscriptAuthority(scope);
        bindCodeModeTranscriptAuthority(attempt, authority);
        const host = createAgentHarnessHostCapabilities({ attempt, pluginId: "copilot" });
        type CommitParams = Parameters<CodeModeTranscriptAuthority["commitPrefix"]>[0] & {
          assertCurrent: () => void;
        };
        const commit = Reflect.get(host.capabilities, PROVIDER_TRANSCRIPT_COMMIT) as
          | ((params: CommitParams) => ReturnType<CodeModeTranscriptAuthority["commitPrefix"]>)
          | undefined;
        const entered = createDeferred();
        const release = createDeferred();
        let blocker: Promise<void> | undefined;
        let pending: ReturnType<NonNullable<typeof commit>> | undefined;
        let replacement: PreparedAgentRunAdmission | undefined;
        try {
          if (!commit) {
            throw new Error("host did not bind its private transcript commit");
          }
          blocker = runExclusiveSqliteSessionWrite(resolved, async () => {
            entered.resolve();
            await release.promise;
          });
          await entered.promise;
          pending = commit({
            assertCurrent: () => {
              if (manager.getAppendParentId() !== assistantId) {
                throw new Error("provider checkpoint replaced");
              }
            },
            baseAnchor,
            entries: [
              {
                eventId: "provider-result",
                identity: "copilot:provider-result",
                message: {
                  role: "toolResult",
                  toolCallId: "provider-call",
                  toolName: "read",
                  content: [{ type: "text", text: "read result" }],
                  isError: false,
                  timestamp: 1,
                },
              },
            ],
          });
          // Observe actual queue admission before revocation; otherwise an entry
          // guard failure could masquerade as the final SQLite authority fence.
          expect(SQLITE_SESSION_WRITER_QUEUES.get(database.path)?.pending).toHaveLength(1);
          expect(readState()).toEqual(before);
          if (mode === "host closed") {
            host.close();
          } else if (mode === "authority released") {
            expect(closeAdmittedRunDelegatedAuthority(attempt.admittedRunContext)).toBe(true);
          } else if (mode === "owner replaced") {
            replacement = (await admittedAttempt(runId)).admission;
          }
          // Releasing or replacing admission must not change the SQLite writer
          // or lifecycle: the queued commit must fail on host authority itself.
          expect(readState()).toEqual(before);
          release.resolve();
          await blocker;
          if (error) {
            await expect(pending).rejects.toEqual(new Error(error));
            expect(readState()).toEqual(before);
            expect(
              readActiveTranscriptEntryAnchor({ ...scope, entryId: "provider-result" }),
            ).toBeUndefined();
          } else {
            const result = await pending;
            if (result.kind !== "committed") {
              throw new Error(`provider transcript was not committed: ${result.kind}`);
            }
            expect(result).toMatchObject({
              kind: "committed",
              results: [
                {
                  identity: "copilot:provider-result",
                  anchor: {
                    ...baseAnchor,
                    entryId: "provider-result",
                    effectiveParentId: assistantId,
                    rawSeq: baseAnchor.rawSeq + 1,
                    activeMessagePosition: baseAnchor.activeMessagePosition + 1,
                    idempotencyKey: "copilot:provider-result",
                  },
                  message: {
                    role: "toolResult",
                    toolCallId: "provider-call",
                    toolName: "read",
                    content: [{ type: "text", text: "read result" }],
                  },
                },
              ],
            });
            const after = readState();
            expect(after.events).toHaveLength(before.events.length + 1);
            expect(after.events.slice(0, -1)).toEqual(before.events);
            expect(after.identities).toHaveLength(before.identities.length + 1);
            expect(after.identities.slice(0, -1)).toEqual(before.identities);
            expect(after.cursors).toEqual(before.cursors);
            expect(result.results).toHaveLength(1);
            expect(result.results[0]?.anchor).toEqual(
              readActiveTranscriptEntryAnchor({ ...scope, entryId: "provider-result" }),
            );
          }
          manager.reloadPersistedTranscript();
          expect(manager.getLeafId()).toBe(error ? assistantId : "provider-result");
          expect(manager.getAppendParentId()).toBe(error ? assistantId : "provider-result");
        } finally {
          release.resolve();
          try {
            await Promise.allSettled([blocker, pending]);
            await SQLITE_SESSION_WRITER_QUEUES.get(database.path)?.drainPromise;
            expect(SQLITE_SESSION_WRITER_QUEUES.has(database.path)).toBe(false);
          } finally {
            host.close();
            replacement?.close();
            admission.close();
          }
        }
      });
    },
  );

  it.each(["restart", "unrelated scope", "user abort", "timeout"] as const)(
    "preserves the original cancellation when a startup capability closes: %s",
    async (reason) => {
      const work = new AsyncWorkScope();
      const otherWork = new AsyncWorkScope();
      const controller = new AbortController();
      const { attempt } = await admittedAttempt("run-startup-close", {
        abortSignal: controller.signal,
      });
      const context = {} as GatewayRequestContext;
      let current: GatewayRequestContext | undefined = context;
      bindGatewayContextResolver(attempt.admittedRunContext, () => current);
      const host = await work.track(() =>
        createAgentHarnessHostCapabilities({ attempt, pluginId: "codex" }),
      );
      const restart = createAgentRunRestartAbortError();
      try {
        expect(host.capabilities.preparedEnvironment?.()).toBeDefined();
        if (reason === "user abort") {
          controller.abort();
        } else if (reason === "timeout") {
          controller.abort(new DOMException("deadline elapsed", "TimeoutError"));
        }
        current = undefined;
        (reason === "unrelated scope" ? otherWork : work).beginClose(restart);
        await otherWork.track(() => {
          expect(() => host.capabilities.preparedEnvironment?.()).toThrow(
            reason === "restart" ? restart : "host capability is no longer active",
          );
        });
      } finally {
        host.close();
        await Promise.all([work.drain(), otherWork.drain()]);
      }
    },
  );

  beforeEach(() => {
    mockRewrap.mockClear();
    mockRunBefore.mockClear();
    mockCallGatewayTool.mockReset();
  });

  it.each(["host closure", "authority release", "gateway restart"])(
    "binds output usage to its original run and rejects reporting after %s",
    async (revocation) => {
      const onUsage = vi.fn();
      const forgedCallback = vi.fn();
      const { attempt } = await admittedAttempt("run-usage", {
        onAgentEvent: onUsage,
      });
      let host = createAgentHarnessHostCapabilities({ attempt, pluginId: "codex" });
      const events: Array<{ runId: string; sessionKey?: string; outputTokens: unknown }> = [];
      const stop = onAgentEvent((event) => {
        if (event.stream === "usage") {
          events.push({
            runId: event.runId,
            sessionKey: event.sessionKey,
            outputTokens: event.data.outputTokens,
          });
        }
      });
      try {
        host.capabilities.reportOutputTokens?.(12);
        host.close();
        host = createAgentHarnessHostCapabilities({ attempt, pluginId: "codex" });
        attempt.runId = "forged-run";
        attempt.lifecycleGeneration = "forged-generation";
        attempt.sessionKey = "forged-session";
        attempt.onAgentEvent = forgedCallback;
        host.capabilities.reportOutputTokens?.(8);
        if (revocation === "host closure") {
          host.close();
        } else if (revocation === "authority release") {
          closeAdmittedRunDelegatedAuthority(attempt.admittedRunContext);
        } else {
          rotateAgentRunRegistryLifecycleGeneration();
        }
        expect(() => host.capabilities.reportOutputTokens?.(100)).toThrow("no longer active");
        expect(events).toEqual([
          { runId: "run-usage", sessionKey: "agent:main:session-1", outputTokens: 12 },
          { runId: "run-usage", sessionKey: "agent:main:session-1", outputTokens: 20 },
        ]);
        expect(onUsage.mock.calls.map(([event]) => event.data.outputTokens)).toEqual([12, 20]);
        expect(forgedCallback).not.toHaveBeenCalled();
      } finally {
        stop();
        host.close();
      }
    },
  );

  it("overwrites plugin policy fields with the host snapshot and revokes lexically", async () => {
    const { attempt, admission } = await admittedAttempt();
    const authority = getAdmittedRunDelegatedAuthority(attempt.admittedRunContext);
    const { tool, execute } = testTool();
    const { host, bound } = bindTool(attempt, tool);
    expect(mockRewrap).toHaveBeenCalledWith(
      tool,
      expect.objectContaining({
        agentId: "main",
        runId: "run-1",
        sessionKey: "agent:main:session-1",
        channelId: "chat-1",
      }),
    );

    const forgedRequest = {
      toolName: "exec",
      params: { command: "true" },
      approvalMode: "deny" as const,
      ctx: { agentId: "forged" },
    };
    // Plain-JavaScript plugins can still supply removed policy fields at runtime.
    await host.capabilities.runBeforeToolCall(
      forgedRequest as unknown as Parameters<typeof host.capabilities.runBeforeToolCall>[0],
    );
    expect(mockRunBefore).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalMode: "request",
        ctx: expect.objectContaining({ agentId: "main", runId: "run-1" }),
      }),
    );

    await host.capabilities.runBeforeToolCall({
      toolName: "exec",
      params: { command: "true" },
      approvalMode: "defer",
    });
    expect(mockRunBefore).toHaveBeenLastCalledWith(
      expect.objectContaining({ approvalMode: "defer" }),
    );
    expect(() => host.capabilities.assertActive()).not.toThrow();

    host.close();
    expect(getAdmittedRunDelegatedAuthority(attempt.admittedRunContext)).toBe(authority);
    expect(() => host.capabilities.bindToolSurface([tool])).toThrow("no longer active");
    expect(() => host.capabilities.createToolSurface?.({} as never)).toThrow("no longer active");
    expect(() => host.capabilities.assertActive()).toThrow("no longer active");
    await expect(bound.execute("call-1", {})).rejects.toThrow("no longer active");
    expect(execute).not.toHaveBeenCalled();

    admission.close();
    expect(getAdmittedRunDelegatedAuthority(attempt.admittedRunContext)).toBeUndefined();
  });

  it("keeps policy snapshots independent from later attempt mutation", async () => {
    const config = { tools: { loopDetection: { enabled: true } } };
    const skillsSnapshot = { prompt: "safe", version: 1, skills: [{ name: "safe" }] };
    const { attempt } = await admittedAttempt("run-snapshot", { config, skillsSnapshot });
    const host = createAgentHarnessHostCapabilities({ attempt, pluginId: "codex" });

    config.tools.loopDetection.enabled = false;
    skillsSnapshot.skills[0]!.name = "forged";
    await host.capabilities.runBeforeToolCall({ toolName: "read", params: {} });

    expect(mockRunBefore).toHaveBeenLastCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({
          config: { tools: { loopDetection: { enabled: true } } },
          skillsSnapshot: expect.objectContaining({ skills: [{ name: "safe" }] }),
        }),
      }),
    );
  });

  it("closes prepared mutable-file approval revalidators with the admitted run", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-host-binding-"));
    try {
      fs.writeFileSync(path.join(cwd, "script.sh"), "#!/bin/sh\necho approved\n");
      const { attempt } = await admittedAttempt("run-file-binding", { cwd });
      const host = createAgentHarnessHostCapabilities({ attempt, pluginId: "codex" });
      const prepared = await host.capabilities.prepareMutableFileApproval?.({
        command: "sh script.sh",
        cwd,
      });
      expect(prepared?.ok).toBe(true);
      if (!prepared?.ok) {
        throw new Error("expected mutable file approval binding");
      }

      host.close();

      await expect(prepared.revalidate()).rejects.toThrow("no longer active");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("keeps prepared environment access closure-bound", async () => {
    vi.stubEnv("GH_TOKEN", "");
    vi.stubEnv("GITHUB_TOKEN", "");
    const config = { tools: { github: { profileId: "ghp_11111111111111111111111111111111" } } };
    const { attempt } = await admittedAttempt("run-local-env", { config });
    const target = { stateDir: "/state", configPath: "/config", defaultWorkspaceDir: "/workspace" };
    const host = withInstallationTarget(target, () =>
      createAgentHarnessHostCapabilities({ attempt, pluginId: "codex" }),
    );

    expect(host.capabilities.preparedEnvironment?.()).toMatchObject({
      credentialScrubEnv: { GH_TOKEN: "", GITHUB_TOKEN: "" },
      localIdentityEnv: expect.objectContaining({ GH_CONFIG_DIR: expect.any(String) }),
      managedLocalIdentity: true,
      localProcessEnv: {
        OPENCLAW_STATE_DIR: "/state",
        OPENCLAW_CONFIG_PATH: "/config",
        OPENCLAW_WORKSPACE_DIR: "/workspace",
      },
    });
    expect(Object.isFrozen(host.capabilities.preparedEnvironment?.().localProcessEnv)).toBe(true);
    host.close();
    expect(() => host.capabilities.preparedEnvironment?.()).toThrow("no longer active");
  });

  it("rejects retained preparation after the admitted Gateway is replaced", async () => {
    const { attempt } = await admittedAttempt("run-prepared-gateway");
    const admitted = {} as GatewayRequestContext;
    const replacement = {} as GatewayRequestContext;
    let current = admitted;
    bindGatewayContextResolver(attempt.admittedRunContext, () => current);
    const preparedExecute = vi.fn(async () => ({ content: [], details: {} }));
    const tool = attachInternalToolExecutionPreparer(testTool().tool, async () => {
      expect(getInProcessGatewayToolContext()).toBe(admitted);
      return {
        kind: "ready",
        args: {},
        execute: preparedExecute,
        dispose: vi.fn(),
      };
    });
    const host = createAgentHarnessHostCapabilities({ attempt, pluginId: "codex" });
    const [bound] = host.capabilities.bindToolSurface([tool]);
    const preparer = bound ? getInternalToolExecutionPreparer(bound) : undefined;
    if (!preparer) {
      throw new Error("expected bound preparer");
    }

    await withPluginRuntimeGatewayRequestScope(
      { context: replacement, isWebchatConnect: () => false },
      async () => {
        const prepared = await preparer({ toolCallId: "prepare", args: {} });
        expect(prepared.kind).toBe("ready");
        current = replacement;
        if (prepared.kind === "ready") {
          await expect(prepared.execute()).rejects.toThrow("no longer active");
        }
      },
    );

    expect(preparedExecute).not.toHaveBeenCalled();
  });

  it("delegates trajectory events and rejects a flush that outlives the capability", async () => {
    const flushStarted = createDeferred();
    const flushResult = createDeferred();
    const recordEvent = vi.fn();
    const flush = vi.fn(async () => {
      flushStarted.resolve();
      await flushResult.promise;
    });
    const { attempt } = await admittedAttempt("run-trajectory", {
      trajectoryRecorder: {
        recordEvent,
        flush,
      },
    });
    const host = createAgentHarnessHostCapabilities({ attempt, pluginId: "codex" });
    const trajectory = host.capabilities.trajectory;
    if (!trajectory) {
      throw new Error("expected trajectory capability");
    }

    trajectory.recordEvent("plugin.event", { ok: true });
    expect(recordEvent).toHaveBeenCalledWith("plugin.event", { ok: true });
    const pending = trajectory.flush();
    await flushStarted.promise;
    host.close();
    flushResult.resolve();

    await expect(pending).rejects.toThrow("no longer active");
    expect(() => trajectory.recordEvent("late.event")).toThrow("no longer active");
  });

  it("preserves ambient GitHub service tokens for a native local identity", async () => {
    vi.stubEnv("GH_TOKEN", "ambient-service-token");
    vi.stubEnv("GITHUB_TOKEN", "ambient-fallback-token");
    const { attempt } = await admittedAttempt("run-native-local-env", { config: {} });
    const host = createAgentHarnessHostCapabilities({ attempt, pluginId: "codex" });

    expect(host.capabilities.preparedEnvironment?.()).toEqual({
      credentialScrubEnv: {},
      localIdentityEnv: {},
      managedLocalIdentity: false,
    });
  });

  it.each([
    { identity: "native", managed: false, source: "env" as const },
    { identity: "managed", managed: true, source: "env" as const },
    { identity: "native", managed: false, source: "store" as const },
    { identity: "managed", managed: true, source: "store" as const },
  ])(
    "prepares the $source preview scrub for a $identity local Codex host",
    async ({ managed, source }) => {
      const { attempt } = await admittedAttempt(`run-${source}-${managed ? "managed" : "native"}`, {
        config: {
          ...(managed
            ? { tools: { github: { profileId: "ghp_66666666666666666666666666666666" } } }
            : {}),
          gateway: {
            controlUi: {
              github: {
                token: { source, provider: "default", id: "PREVIEW_SERVICE_TOKEN" },
              },
            },
          },
        },
      });
      const host = createAgentHarnessHostCapabilities({ attempt, pluginId: "codex" });
      const environment = host.capabilities.preparedEnvironment?.();

      if (managed) {
        expect(environment?.credentialScrubEnv).toMatchObject({
          GH_TOKEN: "",
          GITHUB_TOKEN: "",
        });
      } else {
        expect(environment?.credentialScrubEnv).not.toHaveProperty("GH_TOKEN");
        expect(environment?.credentialScrubEnv).not.toHaveProperty("GITHUB_TOKEN");
      }
      expect(environment?.credentialScrubEnv).toHaveProperty("PREVIEW_SERVICE_TOKEN", "");
      expect(environment?.managedLocalIdentity).toBe(managed);
      expect(environment?.localIdentityEnv).not.toHaveProperty("PREVIEW_SERVICE_TOKEN");
    },
  );

  it("binds hooks to the native harness cwd instead of the agent workspace", async () => {
    const { attempt } = await admittedAttempt("run-native-cwd", {
      cwd: "/tmp/agent-workspace",
    });
    const { tool } = testTool();
    const host = createAgentHarnessHostCapabilities({ attempt, pluginId: "codex" });

    host.capabilities.bindToolSurface([tool], { cwd: "/tmp/codex-binding" });

    expect(mockRewrap).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ cwd: "/tmp/codex-binding" }),
    );
  });

  it("derives a bounded native action cwd without accepting forged host authority", async () => {
    const { attempt } = await admittedAttempt("run-native");
    const host = createAgentHarnessHostCapabilities({ attempt, pluginId: "codex" });

    const forgedRequest = {
      toolName: "exec",
      params: { command: "pwd" },
      nativeOperation: { cwd: " ./native/../action " },
      ctx: { agentId: "forged", cwd: "/forged" },
    };
    await host.capabilities.runBeforeToolCall(forgedRequest);

    expect(mockRunBefore).toHaveBeenLastCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({
          agentId: "main",
          runId: "run-native",
          sessionKey: "agent:main:session-1",
          cwd: "/attempt/worktree/action",
        }),
      }),
    );

    await expect(
      host.capabilities.runBeforeToolCall({
        toolName: "exec",
        params: { command: "pwd" },
        nativeOperation: { cwd: `/${"x".repeat(4096)}` },
      }),
    ).rejects.toThrow("must not exceed 4096 bytes");
    expect(mockRunBefore).toHaveBeenCalledTimes(1);
  });

  it.each(
    policyRevocations.flatMap((entry) =>
      (["resolve", "reject"] as const).map((settlement) => Object.assign({ settlement }, entry)),
    ),
  )("rejects a deferred policy $settlement after $name", async ({ revoke, settlement }) => {
    const { attempt, admission } = await admittedAttempt("run-policy-race");
    const host = createAgentHarnessHostCapabilities({ attempt, pluginId: "codex" });
    const hookStarted = createDeferred<(() => boolean | void) | undefined>();
    const hookResult = createDeferred<{ blocked: false; params: { command: string } }>();
    mockRunBefore.mockImplementationOnce(async () => {
      hookStarted.resolve(getGatewayToolCallerIdentity()?.receiptAuthority);
      return await hookResult.promise;
    });

    const pending = host.capabilities.runBeforeToolCall({
      toolName: "exec",
      params: { command: "true" },
    });
    const receiptAuthority = await hookStarted.promise;
    expect(receiptAuthority).toEqual(expect.any(Function));
    await revoke({ attempt, admission, host });
    expect(receiptAuthority?.()).toBe(false);
    if (settlement === "resolve") {
      hookResult.resolve({ blocked: false, params: { command: "true" } });
    } else {
      hookResult.reject(new Error("deferred policy rejected"));
    }

    await expect(pending).rejects.toThrow(
      settlement === "resolve" ? "no longer active" : "deferred policy rejected",
    );
  });

  it("keeps a private native policy lease after foreground close but fences replacement", async () => {
    const { attempt } = await admittedAttempt("run-retained-policy");
    const host = createAgentHarnessHostCapabilities({ attempt, pluginId: "codex" });
    const delegatedAuthority = getAdmittedRunDelegatedAuthority(attempt.admittedRunContext);
    const retained = retainBeforeToolCallForNativeHookRelay(host.capabilities.runBeforeToolCall);
    mockRunBefore.mockImplementationOnce(async ({ params }) => {
      expect(getGatewayToolCallerIdentity()).toBeUndefined();
      return { blocked: false, params };
    });
    expect(delegatedAuthority).toBeDefined();
    expect(retained).toBeDefined();
    if (!retained) {
      throw new Error("expected retained native policy lease");
    }

    expect(closeAdmittedRunDelegatedAuthority(attempt.admittedRunContext)).toBe(true);
    expect(validateAgentRunDelegatedAuthority(delegatedAuthority!)).toBe(false);
    await expect(
      host.capabilities.runBeforeToolCall({ toolName: "exec", params: { command: "true" } }),
    ).rejects.toThrow("no longer active");
    await expect(
      retained.runBeforeToolCall({ toolName: "exec", params: { command: "true" } }),
    ).resolves.toMatchObject({ blocked: false });

    await admittedAttempt("run-retained-policy");
    await expect(
      retained.runBeforeToolCall({ toolName: "exec", params: { command: "true" } }),
    ).rejects.toThrow("no longer active");
    retained.release();
  });

  it("fences a retained native policy lease after lifecycle rotation", async () => {
    const { attempt } = await admittedAttempt("run-retained-policy-lifecycle");
    const host = createAgentHarnessHostCapabilities({ attempt, pluginId: "codex" });
    const retained = retainBeforeToolCallForNativeHookRelay(host.capabilities.runBeforeToolCall);
    if (!retained) {
      throw new Error("expected retained native policy lease");
    }
    expect(closeAdmittedRunDelegatedAuthority(attempt.admittedRunContext)).toBe(true);

    rotateAgentRunRegistryLifecycleGeneration();

    await expect(
      retained.runBeforeToolCall({ toolName: "exec", params: { command: "true" } }),
    ).rejects.toThrow("no longer active");
    retained.release();
  });

  it.each([
    ...policyRevocations,
    {
      name: "outer admission abort",
      revoke: async ({ admission }: HostRevocationContext) => {
        admission.close();
      },
    },
  ])("rejects late approval results after $name", async ({ name, revoke }) => {
    const operations = [
      {
        name: "request",
        result: { id: "approval-1", decision: null },
        start: (host: ReturnType<typeof createAgentHarnessHostCapabilities>) =>
          host.capabilities.requestApproval({
            title: "Run command",
            description: "Execute a native command",
            severity: "warning",
            toolName: "exec",
            timeoutMs: 1_000,
          }),
      },
      {
        name: "wait",
        result: { id: "approval-1", decision: "allow-once" as const },
        start: (host: ReturnType<typeof createAgentHarnessHostCapabilities>) =>
          host.capabilities.waitForApproval({ approvalId: "approval-1", timeoutMs: 1_000 }),
      },
    ] as const;

    for (const operation of operations) {
      const runId = `run-approval-race-${name.replaceAll(" ", "-")}-${operation.name}`;
      const { attempt, admission } = await admittedAttempt(runId);
      const host = createAgentHarnessHostCapabilities({ attempt, pluginId: "codex" });
      const gatewayStarted = createDeferred();
      const gatewayResult = createDeferred<typeof operation.result>();
      mockCallGatewayTool.mockImplementationOnce(async () => {
        gatewayStarted.resolve();
        return await gatewayResult.promise;
      });

      const pending = operation.start(host);
      await gatewayStarted.promise;
      await revoke({ admission, attempt, host });
      gatewayResult.resolve(operation.result);

      await expect(pending).rejects.toThrow("no longer active");
    }
  });

  it("preserves the gateway decision and terminal reason at the host boundary", async () => {
    const { attempt } = await admittedAttempt("run-approval-timeout-result");
    const host = createAgentHarnessHostCapabilities({ attempt, pluginId: "codex" });
    mockCallGatewayTool.mockResolvedValueOnce({
      id: "approval-1",
      decision: "deny",
      terminalReason: "timeout",
    });

    await expect(
      host.capabilities.waitForApproval({ approvalId: "approval-1", timeoutMs: 1_000 }),
    ).resolves.toEqual({ decision: "deny", terminalReason: "timeout" });
  });

  it("carries native-turn closure through policy, approval registration, and decision waits", async () => {
    const { attempt } = await admittedAttempt("run-native-approval-scope");
    const host = createAgentHarnessHostCapabilities({ attempt, pluginId: "codex" });
    const turn = new AbortController();
    const scopes: AbortSignal[] = [];
    const captureScope = () => {
      scopes.push(AbortSignal.any([...(getGatewayToolCallerIdentity()?.approvalSignals ?? [])]));
    };
    mockRunBefore.mockImplementationOnce(async ({ params }) => {
      captureScope();
      return { blocked: false, params };
    });
    mockCallGatewayTool.mockImplementation(async () => {
      captureScope();
      return { id: "approval", decision: "allow-once" };
    });
    await host.capabilities.runBeforeToolCall({
      toolName: "exec",
      params: {},
      signal: turn.signal,
    });
    await host.capabilities.requestApproval({
      title: "Run command",
      description: "Native command",
      severity: "warning",
      toolName: "exec",
      timeoutMs: 1_000,
      signal: turn.signal,
    });
    await host.capabilities.waitForApproval({
      approvalId: "approval",
      timeoutMs: 1_000,
      signal: turn.signal,
    });
    expect(scopes).toHaveLength(3);
    turn.abort();
    expect(scopes.every((signal) => signal.aborted)).toBe(true);
    expect(() => host.capabilities.assertActive()).not.toThrow();
    host.close();
  });

  it("hands off MCP persistence proof once without serializing the callback", async () => {
    const { attempt } = await admittedAttempt("mcp-persistence-proof");
    const host = createAgentHarnessHostCapabilities({ attempt, pluginId: "codex" });
    const authority = getAdmittedRunDelegatedAuthority(attempt.admittedRunContext)!;
    const scope = {
      authority,
      agentId: "main",
      toolCallId: "item-1",
      server: "docs",
      tool: "write_note",
    };
    let active = true;
    let proof: (() => boolean) | undefined;
    mockCallGatewayTool.mockImplementationOnce(async (_method, _opts, payload) => {
      expect(payload).toMatchObject({
        mcpTool: { server: "docs", tool: "write_note" },
        toolCallId: "item-1",
      });
      expect(payload).not.toHaveProperty("isMcpToolApprovalActive");
      expect(takeMcpToolApprovalBinding({ ...scope, agentId: "other" })).toBeUndefined();
      proof = takeMcpToolApprovalBinding(scope);
      expect(takeMcpToolApprovalBinding(scope)).toBeUndefined();
      return { id: "approval-1" };
    });
    await host.capabilities.requestApproval({
      title: "MCP approval",
      description: "Write a note",
      severity: "warning",
      toolName: "codex_mcp_tool_approval",
      toolCallId: "item-1",
      timeoutMs: 1_000,
      mcpTool: { server: "docs", tool: "write_note" },
      isMcpToolApprovalActive: () => active,
    });
    expect(proof?.()).toBe(true);
    active = false;
    expect(proof?.()).toBe(false);
    active = true;
    host.close();
    expect(proof?.()).toBe(false);
  });

  it("revokes a retained bound tool when the same run id gets a replacement owner", async () => {
    const first = await admittedAttempt("run-replaced");
    const { tool, execute } = testTool();
    const { bound } = bindTool(first.attempt, tool);

    await admittedAttempt("run-replaced");

    await expect(bound.execute("call-1", {})).rejects.toThrow("no longer active");
    expect(execute).not.toHaveBeenCalled();
  });

  it("revalidates the source boundary after awaited bound-tool policy", async () => {
    const { attempt, admission } = await admittedAttempt("run-bound-policy-race");
    const policyStarted = createDeferred();
    const policyResult = createDeferred();
    mockRewrap.mockImplementationOnce((tool) => ({
      ...tool,
      execute: async (...args: Parameters<NonNullable<AnyAgentTool["execute"]>>) => {
        policyStarted.resolve();
        await policyResult.promise;
        runAgentToolSourceExecutionGuard(tool);
        return await tool.execute?.(...args);
      },
    }));
    const { tool, execute } = testTool();
    const { bound } = bindTool(attempt, tool);

    const pending = bound.execute("call-policy-race", {});
    await policyStarted.promise;
    admission.close();
    policyResult.resolve();

    await expect(pending).rejects.toThrow("no longer active");
    expect(execute).not.toHaveBeenCalled();
  });

  it("aborts an in-flight bound tool when its host capability closes", async () => {
    const { attempt } = await admittedAttempt("run-bound-close-race");
    const sourceStarted = createDeferred();
    const sourceResult = createDeferred<{ content: []; details: Record<string, never> }>();
    const { tool } = testTool(
      vi.fn(async () => {
        sourceStarted.resolve();
        return await sourceResult.promise;
      }),
    );
    const { host, bound } = bindTool(attempt, tool);

    const pending = bound.execute("call-close-race", {});
    await sourceStarted.promise;
    host.close();

    await expect(pending).rejects.toThrow("Aborted");
    sourceResult.resolve({ content: [], details: {} });
  });

  it("rejects a bound tool result after exact authority closes during execution", async () => {
    const { attempt } = await admittedAttempt("run-bound-release-race");
    const sourceStarted = createDeferred();
    const sourceResult = createDeferred<{ content: []; details: Record<string, never> }>();
    const { tool } = testTool(
      vi.fn(async () => {
        sourceStarted.resolve();
        return await sourceResult.promise;
      }),
    );
    const { bound } = bindTool(attempt, tool);

    const pending = bound.execute("call-release-race", {});
    await sourceStarted.promise;
    expect(closeAdmittedRunDelegatedAuthority(attempt.admittedRunContext)).toBe(true);
    sourceResult.resolve({ content: [], details: {} });

    await expect(pending).rejects.toThrow("no longer active");
  });

  it("disposes a prepared handle that resolves after host capability closure", async () => {
    const { attempt } = await admittedAttempt("run-preparation-close-race");
    const preparationStarted = createDeferred();
    const preparationResult = createDeferred<Awaited<ReturnType<InternalToolExecutionPreparer>>>();
    const dispose = vi.fn();
    const { tool } = testTool();
    attachInternalToolExecutionPreparer(tool, async () => {
      preparationStarted.resolve();
      return await preparationResult.promise;
    });
    const { host, bound } = bindTool(attempt, tool);
    const boundPreparer = getInternalToolExecutionPreparer(bound);
    if (!boundPreparer) {
      throw new Error("expected retained bound execution preparer");
    }

    const pending = boundPreparer({ toolCallId: "call-prepare-close-race", args: {} });
    await preparationStarted.promise;
    host.close();

    await expect(pending).rejects.toThrow("Aborted");
    preparationResult.resolve({
      kind: "immediate",
      outcome: { kind: "error", error: new Error("late preparation") },
      dispose,
    });
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
  });

  it("aborts prepared execution when its host capability closes", async () => {
    const { attempt } = await admittedAttempt("run-prepared-close-race");
    const executionStarted = createDeferred();
    const executionResult = createDeferred<{ content: []; details: Record<string, never> }>();
    const { tool } = testTool();
    attachInternalToolExecutionPreparer(tool, async () => ({
      kind: "ready",
      args: {},
      execute: async () => {
        executionStarted.resolve();
        return await executionResult.promise;
      },
      dispose() {},
    }));
    const { host, bound } = bindTool(attempt, tool);
    const boundPreparer = getInternalToolExecutionPreparer(bound);
    if (!boundPreparer) {
      throw new Error("expected retained bound execution preparer");
    }
    const prepared = await boundPreparer({ toolCallId: "call-ready-close-race", args: {} });
    if (prepared.kind !== "ready") {
      throw new Error("expected ready execution preparation");
    }

    const pending = prepared.execute();
    await executionStarted.promise;
    host.close();

    await expect(pending).rejects.toThrow("Aborted");
    executionResult.resolve({ content: [], details: {} });
  });

  it("restores the attempt abort race around a rebound tool", async () => {
    const abortController = new AbortController();
    const { attempt } = await admittedAttempt("run-bound-abort", {
      abortSignal: abortController.signal,
    });
    const sourceStarted = createDeferred();
    const sourceResult = createDeferred<{ content: []; details: Record<string, never> }>();
    const { tool } = testTool(
      vi.fn(async () => {
        sourceStarted.resolve();
        return await sourceResult.promise;
      }),
    );
    const { bound } = bindTool(attempt, tool);

    const pending = bound.execute("call-abort", {});
    await sourceStarted.promise;
    abortController.abort();

    await expect(pending).rejects.toThrow("Aborted");
    sourceResult.resolve({ content: [], details: {} });
  });

  it("revokes a retained bound tool after lifecycle rotation", async () => {
    const { attempt } = await admittedAttempt("run-rotated");
    const { tool, execute } = testTool();
    const { bound } = bindTool(attempt, tool);

    rotateAgentRunRegistryLifecycleGeneration();

    await expect(bound.execute("call-1", {})).rejects.toThrow("no longer active");
    expect(execute).not.toHaveBeenCalled();
  });

  it("revokes retained tools on exact release and outer abort", async () => {
    const released = await admittedAttempt("run-released");
    const releasedTool = testTool();
    const releasedBound = bindTool(released.attempt, releasedTool.tool).bound;
    expect(closeAdmittedRunDelegatedAuthority(released.attempt.admittedRunContext)).toBe(true);
    await expect(releasedBound.execute("call-release", {})).rejects.toThrow("no longer active");
    expect(releasedTool.execute).not.toHaveBeenCalled();

    const aborted = await admittedAttempt("run-aborted");
    const abortedTool = testTool();
    const abortedBound = bindTool(aborted.attempt, abortedTool.tool).bound;
    aborted.admission.close();
    await expect(abortedBound.execute("call-abort", {})).rejects.toThrow("no longer active");
    expect(abortedTool.execute).not.toHaveBeenCalled();
  });

  it("fails closed when constructing a host after admission authority closes", async () => {
    const { attempt, admission } = await admittedAttempt("run-closed-before-host");
    admission.close();

    expect(() => createAgentHarnessHostCapabilities({ attempt, pluginId: "codex" })).toThrow(
      "requires active admitted run authority",
    );
  });

  it("rejects a retained execution preparer before preparation after revocation", async () => {
    const { attempt, admission } = await admittedAttempt("run-prepare-revoked");
    const { tool } = testTool();
    const prepare = vi.fn<InternalToolExecutionPreparer>(async () => ({
      kind: "immediate",
      outcome: { kind: "error", error: new Error("not reached") },
      dispose() {},
    }));
    attachInternalToolExecutionPreparer(tool, prepare);
    const { bound } = bindTool(attempt, tool);
    const boundPreparer = getInternalToolExecutionPreparer(bound);
    admission.close();

    await expect(boundPreparer?.({ toolCallId: "call-prepare", args: {} })).rejects.toThrow(
      "no longer active",
    );
    expect(prepare).not.toHaveBeenCalled();
  });

  it("rejects ready execution when authority closes after preparation", async () => {
    const { attempt, admission } = await admittedAttempt("run-ready-revoked");
    const { tool } = testTool();
    const executePrepared = vi.fn(async () => ({ content: [], details: {} }));
    const prepare = vi.fn<InternalToolExecutionPreparer>(async () => ({
      kind: "ready",
      args: {},
      execute: executePrepared,
      dispose() {},
    }));
    attachInternalToolExecutionPreparer(tool, prepare);
    const { bound } = bindTool(attempt, tool);
    const boundPreparer = getInternalToolExecutionPreparer(bound);
    if (!boundPreparer) {
      throw new Error("expected retained bound execution preparer");
    }
    const prepared = await boundPreparer({ toolCallId: "call-ready", args: {} });
    expect(prepared.kind).toBe("ready");
    admission.close();

    if (prepared.kind !== "ready") {
      throw new Error("expected ready execution preparation");
    }
    await expect(prepared.execute()).rejects.toThrow("no longer active");
    expect(executePrepared).not.toHaveBeenCalled();
  });
});
