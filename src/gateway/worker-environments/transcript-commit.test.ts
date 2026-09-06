import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  WorkerTranscriptCommitParams,
  WorkerTranscriptMessage,
} from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { createNoisyPngBuffer } from "../../../test/helpers/image-fixtures.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/io.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  resolveSessionTranscriptRuntimeTarget,
  updateSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { onSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { prepareAgentRunUserTurn } from "../agent-turn/agent-run-user-turn.js";
import type { AgentTurnContext } from "../agent-turn/types.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";
import {
  createWorkerTranscriptCommitStore,
  type WorkerTranscriptCommitStore,
} from "./transcript-commit-store.js";
import { createWorkerTranscriptCommitter } from "./transcript-commit.js";

type WorkerTranscriptCommitter = ReturnType<typeof createWorkerTranscriptCommitter>;

const SESSION_ID = "session-worker-transcript";
const SESSION_KEY = "agent:main:worker-transcript";
const RUN_EPOCH = 7;

const IDENTITY: WorkerConnectionIdentity = {
  environmentId: "environment-a",
  credentialHash: ["credential", "hash", "a"].join("-"),
  bundleHash: "b".repeat(64),
  sessionId: SESSION_ID,
  runId: "run-worker-transcript",
  turnClaim: {
    sessionId: SESSION_ID,
    claimId: "claim-worker-transcript",
    runId: "run-worker-transcript",
    placementGeneration: 4,
    owner: { kind: "worker", environmentId: "environment-a", ownerEpoch: RUN_EPOCH },
  },
  ownerEpoch: RUN_EPOCH,
  rpcSetVersion: 1,
  protocolFeatures: ["worker-transcript-commit-v1"],
  credentialExpiresAtMs: 10_000,
};

const ADMITTED_OWNER = { identity: IDENTITY, assertCurrent: () => undefined };

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};
const PROVIDER_REPLAY = {
  v: 1 as const,
  type: "openai-responses-compaction",
  id: "cmp_worker_commit",
  data: "opaque-worker-commit",
  replayIndex: 1,
  provider: "openai",
  api: "openai-responses",
  model: "gpt-5.5",
  baseUrlHash: "ozhevd1smnk8s",
  sessionHash: "171dzdv17gum5g",
  authProfileHash: "oe8bkr3r8947",
};

function createTurnMessages(userText = "Inspect the workspace"): WorkerTranscriptMessage[] {
  return [
    {
      role: "user",
      content: [{ type: "text", text: userText }],
      timestamp: 100,
    },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "I will inspect it." },
        {
          type: "toolCall",
          id: "call-read-1",
          name: "read",
          arguments: { path: "README.md" },
        },
      ],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.5",
      providerReplay: structuredClone(PROVIDER_REPLAY),
      diagnostics: [
        {
          type: "provider-warning",
          timestamp: 201,
          error: { name: "", message: "diagnostic", stack: "", code: 0 },
          details: { empty: "", enabled: false },
        },
      ],
      usage: ZERO_USAGE,
      stopReason: "toolUse",
      timestamp: 200,
    },
    {
      role: "toolResult",
      toolCallId: "call-read-1",
      toolName: "read",
      content: [{ type: "text", text: "Workspace ready." }],
      isError: false,
      timestamp: 300,
    },
  ];
}

function createRequest(
  params: {
    baseLeafId?: string | null;
    messages?: WorkerTranscriptMessage[];
    seq?: number;
  } = {},
): WorkerTranscriptCommitParams {
  return {
    runEpoch: RUN_EPOCH,
    seq: params.seq ?? 1,
    baseLeafId: params.baseLeafId ?? null,
    messages: params.messages ?? createTurnMessages(),
  };
}

function messageIdempotencyKey(seq: number, index: number): string {
  const digest = createHash("sha256")
    .update([SESSION_ID, RUN_EPOCH, seq, index].join("\0"))
    .digest("base64url");
  return `worker-commit-${digest}`;
}

function requireAppendableWorkerMessage(
  message: unknown,
): Parameters<SessionManager["appendMessage"]>[0] {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    throw new Error("expected committed worker message");
  }
  const role = (message as { role?: unknown }).role;
  if (role !== "assistant" && role !== "toolResult" && role !== "user") {
    throw new Error("expected committed worker message");
  }
  return message as Parameters<SessionManager["appendMessage"]>[0];
}

describe("worker transcript commit application", () => {
  let root: string;
  let sessionsDir: string;
  let storePath: string;
  let sessionTarget: Awaited<ReturnType<typeof resolveSessionTranscriptRuntimeTarget>>;
  let cfg: OpenClawConfig;
  let committer: WorkerTranscriptCommitter;
  let ledgerStore: WorkerTranscriptCommitStore;
  let unsubscribe: (() => void) | undefined;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "openclaw-worker-turn-"));
    sessionsDir = path.join(root, "agents", "main", "sessions");
    storePath = path.join(sessionsDir, "sessions.json");
    cfg = {
      agents: { list: [{ id: "main", default: true }] },
      session: {
        mainKey: "main",
        store: path.join(root, "agents", "{agentId}", "sessions", "sessions.json"),
      },
    };
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: SESSION_KEY, storePath },
      {
        lifecycleRevision: "worker-original-revision",
        sessionId: SESSION_ID,
        updatedAt: 10,
      },
    );
    sessionTarget = await resolveSessionTranscriptRuntimeTarget({
      agentId: "main",
      sessionId: SESSION_ID,
      sessionKey: SESSION_KEY,
      storePath,
    });
    const database = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: path.join(root, "state") },
    });
    ledgerStore = createWorkerTranscriptCommitStore({ database });
    committer = createWorkerTranscriptCommitter({
      getConfig: () => cfg,
      store: ledgerStore,
    });
  });

  afterEach(async () => {
    unsubscribe?.();
    clearRuntimeConfigSnapshot();
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("persists and reopens image-bearing worker results above the control-frame budget", async () => {
    const image = {
      type: "image" as const,
      data: Buffer.alloc(128 * 1024, 42).toString("base64"),
      mimeType: "image/png",
    };
    const messages = createTurnMessages();
    const toolResult = messages[2];
    if (toolResult?.role !== "toolResult") {
      throw new Error("expected tool result fixture");
    }
    toolResult.content.push(image);
    const request = createRequest({ messages });
    const outcome = await committer.commit({ ...ADMITTED_OWNER, request });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      throw new Error(`expected image transcript commit success: ${outcome.reason}`);
    }
    await expect(committer.commit({ ...ADMITTED_OWNER, request })).resolves.toEqual(outcome);
    const reopened = SessionManager.open(sessionTarget);
    const entry = reopened.getEntry(outcome.result.newLeafId);
    expect(entry).toMatchObject({
      type: "message",
      message: { role: "toolResult", content: expect.arrayContaining([image]) },
    });
    expect(reopened.buildSessionContext().messages.at(-1)).toMatchObject({
      role: "toolResult",
      content: expect.arrayContaining([image]),
    });
  });

  it("commits semantic turns as a generated parent-linked transcript and publishes normally", async () => {
    const updates: Parameters<Parameters<typeof onSessionTranscriptUpdate>[0]>[0][] = [];
    unsubscribe = onSessionTranscriptUpdate((update) => updates.push(update));

    const image = {
      type: "image" as const,
      mimeType: "image/png",
      data: createNoisyPngBuffer(256, 256).toString("base64"),
    };
    expect(Buffer.byteLength(image.data)).toBeGreaterThan(64 * 1024);
    const messages = createTurnMessages();
    const toolResult = messages[2]!;
    if (toolResult.role !== "toolResult") {
      throw new Error("missing read result");
    }
    toolResult.content.push(image);
    const outcome = await committer.commit({
      ...ADMITTED_OWNER,
      request: createRequest({ messages }),
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      throw new Error(`expected transcript commit success, received ${outcome.reason}`);
    }
    const { entryIds, newLeafId } = outcome.result;
    expect(entryIds).toHaveLength(3);
    expect(new Set(entryIds).size).toBe(3);
    expect(newLeafId).toBe(entryIds[2]);

    const reopened = SessionManager.open(sessionTarget);
    expect(reopened.getLeafId()).toBe(newLeafId);
    expect(reopened.getEntries()).toEqual([
      expect.objectContaining({
        type: "message",
        id: entryIds[0],
        parentId: null,
        message: expect.objectContaining({
          role: "user",
          content: [{ type: "text", text: "Inspect the workspace" }],
        }),
      }),
      expect.objectContaining({
        type: "message",
        id: entryIds[1],
        parentId: entryIds[0],
        message: expect.objectContaining({
          role: "assistant",
          content: expect.arrayContaining([
            expect.objectContaining({ type: "toolCall", id: "call-read-1" }),
          ]),
          diagnostics: [
            {
              type: "provider-warning",
              timestamp: 201,
              error: { name: "", message: "diagnostic", stack: "", code: 0 },
              details: { empty: "", enabled: false },
            },
          ],
          providerReplay: PROVIDER_REPLAY,
        }),
      }),
      expect.objectContaining({
        type: "message",
        id: entryIds[2],
        parentId: entryIds[1],
        message: expect.objectContaining({
          role: "toolResult",
          toolCallId: "call-read-1",
          content: [{ type: "text", text: "Workspace ready." }, image],
        }),
      }),
    ]);

    const readEvents = await loadTranscriptEvents({
      agentId: "main",
      sessionId: SESSION_ID,
      sessionKey: SESSION_KEY,
      storePath,
    });
    expect(
      readEvents
        .filter((event): event is { type: "message"; id: string } =>
          Boolean(
            event &&
            typeof event === "object" &&
            !Array.isArray(event) &&
            (event as { type?: unknown }).type === "message" &&
            typeof (event as { id?: unknown }).id === "string",
          ),
        )
        .map((event) => event.id),
    ).toEqual(entryIds);
    const persistedEntry = loadSessionEntry({
      agentId: "main",
      sessionKey: SESSION_KEY,
      storePath,
    });
    expect(persistedEntry).toMatchObject({ sessionId: SESSION_ID });
    expect(updates).toEqual(
      entryIds.map((entryId, index) =>
        expect.objectContaining({
          agentId: "main",
          message: expect.objectContaining({ role: createTurnMessages()[index]?.role }),
          messageId: entryId,
          messageSeq: index + 1,
          sessionKey: SESSION_KEY,
          sessionId: SESSION_ID,
          target: expect.objectContaining({
            agentId: "main",
            sessionId: SESSION_ID,
            sessionKey: SESSION_KEY,
          }),
        }),
      ),
    );
    expect(updates[1]?.message).not.toHaveProperty("providerReplay");
  });

  it("durably materializes a user-only commit", async () => {
    const outcome = await committer.commit({
      ...ADMITTED_OWNER,
      request: createRequest({
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Persist before inference" }],
            timestamp: 100,
          },
        ],
      }),
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      throw new Error(`expected user-only transcript commit, received ${outcome.reason}`);
    }
    const reopened = SessionManager.open(sessionTarget);
    expect(reopened.getEntries()).toEqual([
      expect.objectContaining({
        id: outcome.result.newLeafId,
        parentId: null,
        message: expect.objectContaining({ role: "user" }),
      }),
    ]);
    expect(reopened.getLeafId()).toBe(outcome.result.newLeafId);
  });

  it("commits a non-default agent's global session", async () => {
    const updates: Parameters<Parameters<typeof onSessionTranscriptUpdate>[0]>[0][] = [];
    unsubscribe = onSessionTranscriptUpdate((update) => updates.push(update));
    const workStorePath = path.join(root, "agents", "work", "sessions", "sessions.json");
    cfg = {
      agents: {
        list: [{ id: "main", default: true }, { id: "work" }],
      },
      session: {
        scope: "global",
        store: path.join(root, "agents", "{agentId}", "sessions", "sessions.json"),
      },
    };
    await upsertSessionEntryCore(
      { agentId: "work", sessionKey: "global", storePath: workStorePath },
      { sessionId: SESSION_ID, updatedAt: 20 },
    );
    const workTarget = await resolveSessionTranscriptRuntimeTarget({
      agentId: "work",
      sessionId: SESSION_ID,
      sessionKey: "global",
      storePath: workStorePath,
    });
    const outcome = await committer.commit({
      ...ADMITTED_OWNER,
      request: createRequest({
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Persist in the owning agent" }],
            timestamp: 100,
          },
        ],
      }),
    });

    expect(outcome.ok, "WORKER_OWNER_COMMIT_139216").toBe(true);
    if (!outcome.ok) {
      throw new Error(`expected global transcript commit, received ${outcome.reason}`);
    }
    expect(SessionManager.open(workTarget).getEntries()).toEqual([
      expect.objectContaining({
        id: outcome.result.newLeafId,
        message: expect.objectContaining({
          role: "user",
          content: [{ type: "text", text: "Persist in the owning agent" }],
        }),
      }),
    ]);
    expect(SessionManager.open(sessionTarget).getEntries()).toEqual([]);
    expect(updates).toEqual([
      expect.objectContaining({
        agentId: "work",
        sessionId: SESSION_ID,
        sessionKey: "global",
        messageId: outcome.result.newLeafId,
      }),
    ]);
  });

  it("rejects a stale base leaf without appending", async () => {
    const first = await committer.commit({ ...ADMITTED_OWNER, request: createRequest() });
    if (!first.ok) {
      throw new Error(`expected initial transcript commit success, received ${first.reason}`);
    }

    const stale = await committer.commit({
      ...ADMITTED_OWNER,
      request: createRequest({
        baseLeafId: null,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Stale turn" }],
            timestamp: 400,
          },
        ],
        seq: 2,
      }),
    });

    expect(stale).toEqual({ ok: false, reason: "stale-base-leaf" });
    const reopened = SessionManager.open(sessionTarget);
    expect(reopened.getEntries()).toHaveLength(3);
    expect(reopened.getLeafId()).toBe(first.result.newLeafId);
  });

  it("admits an overlapping agent input without invalidating the active worker transcript", async () => {
    setRuntimeConfigSnapshot(cfg);
    const admit = (runId: string, text: string) =>
      prepareAgentRunUserTurn({
        assertCurrent: () => {},
        request: { message: text, idempotencyKey: runId },
        cfg,
        resolvedSessionKey: SESSION_KEY,
        admittedSessionId: SESSION_ID,
        activeSessionAgentId: "main",
        suppressVisibleSessionEffects: false,
        requestedPromptPersistenceSuppression: false,
        canUseInternalRuntimeHandoff: false,
        message: text,
        effectiveTranscriptInputText: text,
        images: [],
        offloadedRefs: [],
        runId,
        client: null,
        context: { logGateway: { warn: vi.fn() } } as unknown as AgentTurnContext,
      });

    const first = await admit(IDENTITY.runId!, "First input");
    const firstUser = await (first.recorder?.withPendingInput
      ? first.recorder.withPendingInput(() => first.recorder!.persistApproved())
      : first.recorder?.persistApproved());
    if (!firstUser) {
      throw new Error("expected the active worker's canonical user input");
    }

    // Admission happens before the next turn can take the session lane. It must
    // not move the active worker's base while that worker is still producing output.
    const second = await admit("next-worker-run", "Second input");
    const completed = await committer.commit({
      ...ADMITTED_OWNER,
      request: createRequest({
        baseLeafId: firstUser.messageId,
        messages: createTurnMessages().slice(1),
      }),
    });
    if (!completed.ok) {
      throw new Error(`active worker commit rejected: ${completed.reason}`);
    }

    const secondUser = await (second.recorder?.withPendingInput
      ? second.recorder.withPendingInput(() => second.recorder!.persistApproved())
      : second.recorder?.persistApproved());
    expect(secondUser).toBeDefined();
    const branch = SessionManager.open(sessionTarget).getBranch();
    expect(branch.map((entry) => [entry.id, entry.parentId])).toEqual([
      [firstUser.messageId, null],
      [completed.result.entryIds[0], firstUser.messageId],
      [completed.result.entryIds[1], completed.result.entryIds[0]],
      [secondUser?.messageId, completed.result.newLeafId],
    ]);
    expect(
      branch.flatMap((entry) =>
        entry.type === "message" && entry.message.role === "user" ? [entry.message.content] : [],
      ),
    ).toEqual(["First input", "Second input"]);
    first.recorder?.finishPendingInput?.("interrupted");
    second.recorder?.finishPendingInput?.("interrupted");
  });

  it("rejects a commit when lifecycle ownership changes in the writer queue", async () => {
    let releaseOwnerChange = () => {};
    const ownerChangeGate = new Promise<void>((resolve) => {
      releaseOwnerChange = resolve;
    });
    let markOwnerChangeStarted = () => {};
    const ownerChangeStarted = new Promise<void>((resolve) => {
      markOwnerChangeStarted = resolve;
    });
    const ownerChange = updateSessionEntry(
      { agentId: "main", sessionKey: SESSION_KEY, storePath },
      async () => {
        markOwnerChangeStarted();
        await ownerChangeGate;
        return { lifecycleRevision: "worker-replacement-revision" };
      },
    );
    await ownerChangeStarted;

    const commit = committer.commit({ ...ADMITTED_OWNER, request: createRequest() });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    releaseOwnerChange();

    await ownerChange;
    await expect(commit).resolves.toEqual({ ok: false, reason: "invalid-batch" });
    expect(loadSessionEntry({ agentId: "main", sessionKey: SESSION_KEY, storePath })).toMatchObject(
      {
        lifecycleRevision: "worker-replacement-revision",
        sessionId: SESSION_ID,
      },
    );
    expect(SessionManager.open(sessionTarget).getEntries()).toEqual([]);
  });

  it("replays the same tuple without duplicates and rejects a changed payload", async () => {
    const request = createRequest();
    const first = await committer.commit({ ...ADMITTED_OWNER, request });
    const replay = await committer.commit({
      ...ADMITTED_OWNER,
      request: structuredClone(request),
    });
    const changed = await committer.commit({
      ...ADMITTED_OWNER,
      request: createRequest({ messages: createTurnMessages("Changed payload") }),
    });

    expect(first.ok).toBe(true);
    expect(replay).toEqual(first);
    expect(changed).toEqual({ ok: false, reason: "invalid-batch" });
    const reopened = SessionManager.open(sessionTarget);
    expect(reopened.getEntries()).toHaveLength(3);
    if (first.ok) {
      expect(reopened.getLeafId()).toBe(first.result.newLeafId);
    }
  });

  it("recovers an interrupted terminal write after later transcript activity", async () => {
    let interruptCompletion = true;
    const interruptedStore: WorkerTranscriptCommitStore = {
      ...ledgerStore,
      complete: (input) => {
        if (interruptCompletion) {
          interruptCompletion = false;
          throw new Error("simulated commit-result interruption");
        }
        return ledgerStore.complete(input);
      },
    };
    const interruptedCommitter = createWorkerTranscriptCommitter({
      getConfig: () => cfg,
      store: interruptedStore,
    });
    const request = createRequest();

    await expect(interruptedCommitter.commit({ ...ADMITTED_OWNER, request })).rejects.toThrow(
      "simulated commit-result interruption",
    );
    const afterInterruption = SessionManager.open(sessionTarget);
    const committedEntryIds = afterInterruption.getEntries().map((entry) => entry.id);
    expect(committedEntryIds).toHaveLength(request.messages.length);
    const laterLeafId = afterInterruption.appendMessage({
      role: "user",
      content: [{ type: "text", text: "Later local activity" }],
      timestamp: 400,
    });

    const replay = await committer.commit({ ...ADMITTED_OWNER, request });

    expect(replay).toEqual({
      ok: true,
      result: {
        entryIds: committedEntryIds,
        newLeafId: committedEntryIds.at(-1),
      },
    });
    const reopened = SessionManager.open(sessionTarget);
    expect(reopened.getEntries()).toHaveLength(request.messages.length + 1);
    expect(reopened.getLeafId()).toBe(laterLeafId);
  });

  it("replays an interrupted terminal write after its branch is abandoned", async () => {
    cfg = { ...cfg };
    const initialManager = SessionManager.open(sessionTarget);
    const baseLeafId = initialManager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "Local base" }],
      timestamp: 50,
    });
    let interruptCompletion = true;
    const interruptedStore: WorkerTranscriptCommitStore = {
      ...ledgerStore,
      complete: (input) => {
        if (interruptCompletion) {
          interruptCompletion = false;
          throw new Error("simulated off-branch terminal interruption");
        }
        return ledgerStore.complete(input);
      },
    };
    const interruptedCommitter = createWorkerTranscriptCommitter({
      getConfig: () => cfg,
      store: interruptedStore,
    });
    const request = createRequest({
      baseLeafId,
      messages: createTurnMessages("my key is sk-abcdef1234567890xyz"),
    });

    await expect(interruptedCommitter.commit({ ...ADMITTED_OWNER, request })).rejects.toThrow(
      "simulated off-branch terminal interruption",
    );
    const afterInterruption = SessionManager.open(sessionTarget);
    const committedEntries = afterInterruption
      .getEntries()
      .filter((entry) => entry.id !== baseLeafId);
    const committedEntryIds = committedEntries.map((entry) => entry.id);
    expect(committedEntryIds).toHaveLength(request.messages.length);
    expect(JSON.stringify(committedEntries)).not.toContain("sk-abcdef1234567890xyz");

    const firstCommitted = committedEntries[0];
    if (firstCommitted?.type !== "message") {
      throw new Error("expected committed worker message");
    }
    afterInterruption.branch(baseLeafId);
    const duplicatePrefixId = afterInterruption.appendMessage(
      requireAppendableWorkerMessage(firstCommitted.message),
      { idempotencyLookup: "caller-checked" },
    );
    afterInterruption.appendMessage({
      role: "user",
      content: [{ type: "text", text: "Incomplete duplicate branch" }],
      timestamp: 350,
    });
    afterInterruption.branch(baseLeafId);
    const localLeafId = afterInterruption.appendMessage({
      role: "user",
      content: [{ type: "text", text: "Local branch wins" }],
      timestamp: 400,
    });
    const updates: Parameters<Parameters<typeof onSessionTranscriptUpdate>[0]>[0][] = [];
    unsubscribe = onSessionTranscriptUpdate((update) => updates.push(update));
    cfg = { ...cfg };

    let authorityChecks = 0;
    await expect(
      committer.commit({
        identity: IDENTITY,
        request,
        assertCurrent: () => {
          if (++authorityChecks === 2) {
            throw new Error("claim closed before pending batch recovery");
          }
        },
      }),
    ).rejects.toThrow("claim closed before pending batch recovery");

    const replay = await committer.commit({ ...ADMITTED_OWNER, request });

    expect(replay).toEqual({
      ok: true,
      result: {
        entryIds: committedEntryIds,
        newLeafId: committedEntryIds.at(-1),
      },
    });
    const reopened = SessionManager.open(sessionTarget);
    expect(reopened.getBranch().map((entry) => entry.id)).toEqual([baseLeafId, localLeafId]);
    if (!replay.ok) {
      throw new Error(`expected interrupted commit replay, received ${replay.reason}`);
    }
    expect(replay.result.entryIds).not.toContain(duplicatePrefixId);
    expect(updates).toEqual([]);
  });

  it("rejects ambiguous persisted recovery without appending or publishing", async () => {
    const initialManager = SessionManager.open(sessionTarget);
    const baseLeafId = initialManager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "Local base" }],
      timestamp: 50,
    });
    let interruptCompletion = true;
    const interruptedCommitter = createWorkerTranscriptCommitter({
      getConfig: () => cfg,
      store: {
        ...ledgerStore,
        complete: (input) => {
          if (interruptCompletion) {
            interruptCompletion = false;
            throw new Error("simulated ambiguous terminal interruption");
          }
          return ledgerStore.complete(input);
        },
      },
    });
    const request = createRequest({ baseLeafId });

    await expect(interruptedCommitter.commit({ ...ADMITTED_OWNER, request })).rejects.toThrow(
      "simulated ambiguous terminal interruption",
    );
    const manager = SessionManager.open(sessionTarget);
    const originalEntries = manager.getEntries().filter((entry) => entry.id !== baseLeafId);
    expect(originalEntries).toHaveLength(request.messages.length);
    manager.branch(baseLeafId);
    for (const entry of originalEntries) {
      if (entry.type !== "message") {
        throw new Error("expected committed worker message");
      }
      manager.appendMessage(requireAppendableWorkerMessage(entry.message), {
        idempotencyLookup: "caller-checked",
      });
    }
    manager.branch(baseLeafId);
    const localLeafId = manager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "Local branch wins" }],
      timestamp: 400,
    });
    const entryCountBeforeRetry = manager.getEntries().length;
    const updates: Parameters<Parameters<typeof onSessionTranscriptUpdate>[0]>[0][] = [];
    unsubscribe = onSessionTranscriptUpdate((update) => updates.push(update));

    const replay = await committer.commit({ ...ADMITTED_OWNER, request });

    expect(replay).toEqual({ ok: false, reason: "invalid-batch" });
    const reopened = SessionManager.open(sessionTarget);
    expect(reopened.getEntries()).toHaveLength(entryCountBeforeRetry);
    expect(reopened.getBranch().map((entry) => entry.id)).toEqual([baseLeafId, localLeafId]);
    expect(updates).toEqual([]);
  });

  it("rolls back every transcript row when a batch append is interrupted", async () => {
    type AppendMessage = (
      this: SessionManager,
      ...args: Parameters<SessionManager["appendMessage"]>
    ) => ReturnType<SessionManager["appendMessage"]>;
    const appendMessage = Object.getOwnPropertyDescriptor(SessionManager.prototype, "appendMessage")
      ?.value as AppendMessage | undefined;
    if (!appendMessage) {
      throw new Error("SessionManager.appendMessage implementation is unavailable");
    }
    let appendCount = 0;
    const appendSpy = vi
      .spyOn(SessionManager.prototype, "appendMessage")
      .mockImplementation(function (this: SessionManager, message, options) {
        const messageId = appendMessage.call(this, message, options);
        appendCount += 1;
        if (appendCount === 2) {
          throw new Error("simulated mid-batch interruption");
        }
        return messageId;
      });
    const request = createRequest();
    const entryBeforeFailure = loadSessionEntry({
      agentId: "main",
      sessionKey: SESSION_KEY,
      storePath,
    });

    try {
      await expect(committer.commit({ ...ADMITTED_OWNER, request })).rejects.toThrow(
        "simulated mid-batch interruption",
      );
    } finally {
      appendSpy.mockRestore();
    }
    expect(SessionManager.open(sessionTarget).getEntries()).toEqual([]);
    const entryAfterFailure = loadSessionEntry({
      agentId: "main",
      sessionKey: SESSION_KEY,
      storePath,
    });
    expect(entryAfterFailure).toEqual(entryBeforeFailure);

    const manager = SessionManager.open(sessionTarget);
    const localLeafId = manager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "Local activity after interruption" }],
      timestamp: 400,
    });
    const retry = await committer.commit({ ...ADMITTED_OWNER, request });

    expect(retry).toEqual({ ok: false, reason: "stale-base-leaf" });
    const reopened = SessionManager.open(sessionTarget);
    expect(reopened.getEntries()).toEqual([
      expect.objectContaining({
        id: localLeafId,
        message: expect.objectContaining({ role: "user" }),
      }),
    ]);
  });

  it("does not reuse an idempotency key from an abandoned transcript branch", async () => {
    const first = await committer.commit({ ...ADMITTED_OWNER, request: createRequest() });
    if (!first.ok) {
      throw new Error(`expected initial transcript commit success, received ${first.reason}`);
    }
    const manager = SessionManager.open(sessionTarget);
    const abandonedMessage: Parameters<SessionManager["appendMessage"]>[0] & {
      idempotencyKey: string;
    } = {
      role: "user",
      content: [{ type: "text", text: "Abandoned worker-shaped row" }],
      timestamp: 400,
      idempotencyKey: messageIdempotencyKey(2, 0),
    };
    const abandonedId = manager.appendMessage(abandonedMessage);
    manager.branch(first.result.newLeafId);
    const activeLeafId = manager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "Active local row" }],
      timestamp: 500,
    });

    const outcome = await committer.commit({
      ...ADMITTED_OWNER,
      request: createRequest({
        baseLeafId: activeLeafId,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Fresh worker row" }],
            timestamp: 600,
          },
        ],
        seq: 2,
      }),
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      throw new Error(`expected branch-safe transcript commit, received ${outcome.reason}`);
    }
    expect(outcome.result.newLeafId).not.toBe(abandonedId);
    const reopened = SessionManager.open(sessionTarget);
    expect(reopened.getLeafId()).toBe(outcome.result.newLeafId);
    expect(reopened.getEntry(outcome.result.newLeafId)).toMatchObject({
      parentId: activeLeafId,
      message: expect.objectContaining({ idempotencyKey: messageIdempotencyKey(2, 0) }),
    });
  });

  it("persists run ownership on worker output while only the terminal envelope completes it", async () => {
    const updates: Parameters<Parameters<typeof onSessionTranscriptUpdate>[0]>[0][] = [];
    unsubscribe = onSessionTranscriptUpdate((update) => updates.push(update));
    const first = await committer.commit({ ...ADMITTED_OWNER, request: createRequest() });
    if (!first.ok) {
      throw new Error(`expected initial transcript commit success, received ${first.reason}`);
    }
    const nextMessage: WorkerTranscriptMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Finished." }],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.5",
      usage: ZERO_USAGE,
      stopReason: "stop",
      timestamp: 400,
    };

    const second = await committer.commit({
      ...ADMITTED_OWNER,
      request: createRequest({
        baseLeafId: first.result.newLeafId,
        messages: [nextMessage],
        seq: 2,
      }),
    });

    expect(second.ok).toBe(true);
    if (!second.ok) {
      throw new Error(`expected sequential transcript commit success, received ${second.reason}`);
    }
    expect(second.result.entryIds).toHaveLength(1);
    expect(second.result.newLeafId).toBe(second.result.entryIds[0]);
    expect(second.result.newLeafId).not.toBe(first.result.newLeafId);
    const reopened = SessionManager.open(sessionTarget);
    expect(
      reopened
        .getEntries()
        .filter((entry) => entry.type === "message")
        .map((entry) => entry.message),
    ).toMatchObject([
      { role: "user" },
      { role: "assistant", __openclaw: { runId: IDENTITY.runId } },
      { role: "toolResult", __openclaw: { runId: IDENTITY.runId } },
      { role: "assistant", __openclaw: { runId: IDENTITY.runId } },
    ]);
    expect(reopened.getEntries().at(-1)).toMatchObject({
      id: second.result.newLeafId,
      parentId: first.result.newLeafId,
      message: expect.objectContaining({ role: "assistant" }),
    });
    expect(reopened.getLeafId()).toBe(second.result.newLeafId);
    expect(updates).toHaveLength(4);
    for (const update of updates.slice(0, 3)) {
      expect(update).not.toHaveProperty("runId");
    }
    expect(updates[3]).toMatchObject({
      message: { role: "assistant" },
      messageId: second.result.newLeafId,
      messageSeq: 4,
      runId: IDENTITY.runId,
    });
  });
});
