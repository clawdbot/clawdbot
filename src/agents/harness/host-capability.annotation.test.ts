import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import { convertMessages } from "../../../packages/ai/src/openai-completions-messages.js";
import { resolveOpenAICompletionsCompat } from "../../../packages/ai/src/transports/openai-completions-compat.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  appendTranscriptMessage,
  listSessionPendingInputReceipts,
  listSessionPendingInputs,
  loadSessionEntry,
  loadTranscriptEvents,
  readActiveTranscriptEntryAnchor,
  readClosedTranscriptTurn,
  replaceTranscriptEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { writeSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry-store.js";
import {
  resolveSqliteTranscriptScope,
  runExclusiveSqliteSessionWrite,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import { markSessionTranscriptIndexDirtyInTransaction } from "../../config/sessions/session-transcript-index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ContextEngine } from "../../context-engine/types.js";
import { createWorkerSessionPlacementStore } from "../../gateway/worker-environments/placement-store.js";
import { readCodexSessionTranscriptEventsBeforeAdmission } from "../../plugin-sdk/codex-session-transcript-runtime.js";
import { readSessionTranscriptVisibleMessageDelta } from "../../plugin-sdk/session-transcript-runtime.js";
import { onInternalSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import {
  buildRunUserTurnIdempotencyKey,
  createUserTurnTranscriptRecorder,
} from "../../sessions/user-turn-transcript.js";
import type {
  CreateUserTurnTranscriptRecorderParams,
  UserTurnTranscriptAnnotation,
} from "../../sessions/user-turn-transcript.types.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { normalizeMessagesForLlmBoundary } from "../embedded-agent-runner/run/attempt-llm-boundary.js";
import { convertToLlm } from "../sessions/messages.js";
import { withGatewayToolCallerIdentity } from "../tools/gateway-caller-context.js";
import type { ContextEngineLogicalTurnLease } from "./context-engine-logical-turn.js";
import {
  drainPendingContextEngineTurnsBeforeRun,
  finalizeAcceptedContextEngineTurn,
} from "./context-engine-turn-attempt.js";
import { createAgentHarnessHostCapabilities } from "./host-capability.js";
import { createAdmittedHostCapabilityTestFixture } from "./host-capability.test-support.js";

afterEach(() => vi.restoreAllMocks());

function nativeAnnotation(
  content = "prompt",
  upstreamUserText = "native prompt",
): UserTurnTranscriptAnnotation {
  return {
    mirrorIdentity: "native-turn:prompt",
    mirrorOrigin: "codex-app-server",
    upstreamUserText,
    mirrorSourceFingerprint: createHash("sha256")
      .update(
        JSON.stringify({ role: "user", content, upstreamUserText: upstreamUserText || undefined }),
      )
      .digest("hex")
      .slice(0, 32),
  };
}

async function withAdmission(
  run: (fixture: Awaited<ReturnType<typeof prepareAdmission>>) => Promise<void>,
  options: Partial<
    Pick<
      CreateUserTurnTranscriptRecorderParams,
      "input" | "message" | "resolveInput" | "beforeMessageWrite"
    >
  > & {
    config?: OpenClawConfig;
    persist?: boolean;
    suppress?: boolean;
  } = {},
) {
  await withOpenClawTestState({ label: "admission-annotation" }, async (state) => {
    const fixture = await prepareAdmission(
      path.join(state.sessionsDir(), "sessions.json"),
      options,
    );
    try {
      await run(fixture);
    } finally {
      fixture.closeHost();
      fixture.closeAdmission();
    }
  });
}

async function prepareAdmission(
  storePath: string,
  options: Parameters<typeof withAdmission>[1] = {},
) {
  const runId = randomUUID();
  const target = {
    agentId: "main",
    sessionId: "admitted",
    sessionKey: "agent:main:admitted",
    storePath,
  };
  await upsertSessionEntryCore(target, {
    sessionId: target.sessionId,
    updatedAt: 1,
    lifecycleRevision: "initial",
  });
  const patchSession = (patch: Record<string, unknown>) =>
    runOpenClawAgentWriteTransaction(
      (database) => {
        writeSessionEntry(database, target.sessionKey, {
          ...expectDefined(loadSessionEntry(target), "session"),
          ...patch,
        });
      },
      { agentId: target.agentId },
    );
  patchSession({ activeWriterRunId: runId });
  const prior = expectDefined(
    await appendTranscriptMessage(target, {
      message: { role: "user", content: "prior", timestamp: 1 },
    }),
    "prior",
  );
  const onPersisted = vi.fn();
  const recorder = createUserTurnTranscriptRecorder({
    input: {
      text: "prompt",
      timestamp: 123,
      idempotencyKey: buildRunUserTurnIdempotencyKey(runId),
      senderIsOwner: true,
      sender: { id: "sender" },
      ...options.input,
    },
    message: options.message,
    resolveInput: options.resolveInput,
    target: { ...target, sessionEntry: loadSessionEntry(target), config: options.config },
    beforeMessageWrite: options.beforeMessageWrite,
    onMessagePersisted: onPersisted,
  });
  if (options.persist !== false) {
    await recorder.persistApproved();
  }
  const controller = new AbortController();
  const attempt = {
    ...target,
    sessionTarget: target,
    runId,
    config: options.config ?? {},
    userTurnTranscriptRecorder: recorder,
    abortSignal: controller.signal,
    suppressNextUserMessagePersistence: options.suppress,
  };
  const host = await createAdmittedHostCapabilityTestFixture(attempt);
  return {
    ...host,
    attempt,
    target,
    prior,
    recorder,
    onPersisted,
    controller,
    patchSession,
    annotate: (annotation = nativeAnnotation()) =>
      expectDefined(
        host.hostCapabilities.annotateCurrentUserTurn,
        "annotation capability",
      )(annotation),
    receipt: () => expectDefined(recorder.getAdmissionReceipt(), "admission"),
  };
}

describe("host-owned current admission annotation", () => {
  it.each(["staged", "collected"] as const)(
    "refreshes only the admitted %s input while preserving source custody",
    async (kind) => {
      const hook = vi.fn<NonNullable<CreateUserTurnTranscriptRecorderParams["beforeMessageWrite"]>>(
        ({ message }) => message,
      );
      await withAdmission(
        async (f) => {
          expect(f.hostCapabilities.annotateCurrentUserTurn).toBeUndefined();
          const sources = [f.recorder];
          let host: ReturnType<typeof createAgentHarnessHostCapabilities> | undefined;
          try {
            expect(
              await f.recorder.stageApproved?.({
                runId: f.attempt.runId,
                assertCurrent: f.hostCapabilities.assertActive,
              }),
            ).toBe(true);
            if (kind === "collected") {
              const second = createUserTurnTranscriptRecorder({
                target: { ...f.target, sessionEntry: loadSessionEntry(f.target) },
                input: {
                  text: "second prompt",
                  idempotencyKey: "second-source:user",
                  timestamp: 124,
                },
                beforeMessageWrite: hook,
              });
              sources.push(second);
              expect(
                await second.stageApproved?.({
                  runId: "second-source",
                  assertCurrent: f.hostCapabilities.assertActive,
                }),
              ).toBe(true);
            }
            const accepted = listSessionPendingInputs(f.target);
            const before = await loadTranscriptEvents(f.target);
            const content = kind === "collected" ? "prompt\nsecond prompt" : "prompt";
            const recorder =
              kind === "collected"
                ? createUserTurnTranscriptRecorder({
                    target: { ...f.target, sessionEntry: loadSessionEntry(f.target) },
                    input: { text: content, idempotencyKey: "collected:user", timestamp: 125 },
                    pendingInputSources: sources,
                    beforeMessageWrite: hook,
                  })
                : f.recorder;
            const persisted = expectDefined(await recorder.persistApproved(), "promoted input");
            const original = structuredClone(persisted.admission);
            const consumptions = listSessionPendingInputReceipts(f.target, {
              runIds: accepted.items.map((input) => input.runId),
            });
            expect(consumptions).toEqual(
              kind === "collected"
                ? accepted.items.map((input) => ({
                    runId: input.runId,
                    state: "consumed",
                    consumedByEventId: original.entryId,
                  }))
                : [],
            );
            expect(listSessionPendingInputs(f.target)).toEqual({ items: [], total: 0 });
            host = createAgentHarnessHostCapabilities({
              attempt: {
                ...f.attempt,
                admittedRunContext: f.admittedRunContext,
                userTurnTranscriptRecorder: recorder,
              },
              pluginId: "codex",
            });
            const annotate = expectDefined(host.capabilities.annotateCurrentUserTurn, "annotation");
            await annotate(nativeAnnotation(content));
            const refreshed = expectDefined(recorder.getAdmissionReceipt(), "refreshed admission");
            expect(refreshed).toEqual({ ...original, generation: expect.any(String) });
            expect(refreshed.generation).not.toBe(original.generation);
            await expect(recorder.persistApproved()).resolves.toMatchObject({
              admission: refreshed,
              message: recorder.getPersistedMessage?.(),
              messageId: original.entryId,
            });
            await annotate(nativeAnnotation(content));
            expect(recorder.getAdmissionReceipt()).toEqual(refreshed);
            const after = await loadTranscriptEvents(f.target);
            expect(after).toHaveLength(before.length + 1);
            expect(after.slice(0, -1)).toEqual(before);
            expect(sources.map((source) => source.getPendingInputMessage?.())).toEqual(
              accepted.items.map((input) => input.message),
            );
            expect(
              listSessionPendingInputReceipts(f.target, {
                runIds: accepted.items.map((input) => input.runId),
              }),
            ).toEqual(consumptions);
            expect(hook).toHaveBeenCalledTimes(sources.length);
            host.close();
            await expect(annotate(nativeAnnotation(content))).rejects.toThrow();
            expect(await loadTranscriptEvents(f.target)).toEqual(after);
          } finally {
            host?.close();
            for (const source of sources) {
              source.finishPendingInput?.("interrupted");
            }
          }
        },
        { persist: false, beforeMessageWrite: hook },
      );
    },
  );

  it("refuses retargeting a refreshed recorder through its returned receipt and message", async () => {
    await withAdmission(async (f) => {
      await f.annotate();
      const before = await loadTranscriptEvents(f.target);
      const other = expectDefined(
        readActiveTranscriptEntryAnchor({ ...f.target, entryId: f.prior.messageId }),
        "other active row",
      );
      const receipt = f.receipt();
      const logicalTurnId = receipt.logicalTurnId;
      for (const key of Object.keys(receipt)) {
        Reflect.deleteProperty(receipt, key);
      }
      Object.assign(receipt, other, { logicalTurnId, role: "user" });
      const exposed = expectDefined(f.recorder.getPersistedMessage?.(), "exposed message");
      for (const key of Object.keys(exposed)) {
        Reflect.deleteProperty(exposed, key);
      }
      Object.assign(exposed, f.prior.message);
      await expect(f.annotate(nativeAnnotation("prior"))).rejects.toThrow();
      expect(await loadTranscriptEvents(f.target)).toEqual(before);
    });
  });

  it("refreshes the same event once, resets cursors and advances the actual durable context-engine outbox", async () => {
    await withAdmission(async (f) => {
      const original = structuredClone(f.receipt());
      const before = await loadTranscriptEvents(f.target);
      const originalMessage = structuredClone(
        expectDefined(f.recorder.getPersistedMessage?.(), "persisted message"),
      );
      const page = await readSessionTranscriptVisibleMessageDelta(f.target);
      expect(page.kind).toBe("page");
      if (page.kind !== "page") {
        throw new Error("missing initial cursor");
      }
      const commitTurn = vi.fn<NonNullable<ContextEngine["commitTurn"]>>(async () => ({
        status: "committed",
      }));
      const engine: ContextEngine = {
        info: {
          id: "annotation",
          name: "Annotation",
          transcriptSemantics: {
            currentTurnFence: "before-current-turn-entry-v1",
            turnAdvancementIdempotency: "atomic-idempotent-v1",
          },
        },
        ingest: async () => ({ ingested: true }),
        assemble: async ({ messages }) => ({ messages, estimatedTokens: 0 }),
        compact: async () => ({ ok: true, compacted: false }),
        commitTurn,
      };
      const lease: ContextEngineLogicalTurnLease = {
        engine,
        effectiveEngine: engine,
        effectiveEngineId: "annotation",
        degraded: false,
        selectForHost: vi.fn(),
        degradeBeforeStart: vi.fn(),
        begin: vi.fn(),
        deferDisposalUntil: vi.fn(),
        dispose: async () => {},
      };
      const warn = vi.fn();
      await drainPendingContextEngineTurnsBeforeRun({
        admission: original,
        recorder: f.recorder,
        lease,
        warn,
      });
      const updates = vi.fn();
      const unsubscribe = onInternalSessionTranscriptUpdate(updates);
      try {
        await f.annotate();
        const refreshed = f.receipt();
        expect(refreshed).toEqual({ ...original, generation: expect.any(String) });
        expect(refreshed.generation).not.toBe(original.generation);
        expect(
          await readSessionTranscriptVisibleMessageDelta({ ...f.target, cursor: page.cursor }),
        ).toMatchObject({ kind: "reset" });
        expect(await readCodexSessionTranscriptEventsBeforeAdmission(f.target, refreshed)).toEqual(
          before.slice(0, -1),
        );
        expect(
          readClosedTranscriptTurn({
            boundary: { admission: original, terminal: refreshed },
            maxEvents: 20,
            maxBytes: 10000,
          }),
        ).toMatchObject({ kind: "session-rebound" });
        const after = await loadTranscriptEvents(f.target);
        const model = {
          api: "openai-completions",
          provider: "openai",
          id: "gpt-5.5",
          name: "GPT-5.5",
          baseUrl: "https://api.openai.com/v1",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 100000,
          maxTokens: 4096,
        } satisfies Parameters<typeof convertMessages>[0];
        const modelBytes = (message: typeof originalMessage) =>
          JSON.stringify(
            convertMessages(
              model,
              {
                messages: convertToLlm(
                  normalizeMessagesForLlmBoundary([message], { timezone: "UTC" }),
                ),
              },
              resolveOpenAICompletionsCompat(model),
            ),
          );
        expect(
          modelBytes(expectDefined(f.recorder.getPersistedMessage?.(), "annotated message")),
        ).toBe(modelBytes(originalMessage));
        await f.annotate();
        expect(await loadTranscriptEvents(f.target)).toEqual(after);
        expect(f.receipt()).toEqual(refreshed);
        expect(updates).toHaveBeenCalledOnce();
        expect(updates).toHaveBeenCalledWith(
          expect.objectContaining({
            messageId: original.entryId,
            messageSeq: original.activeMessagePosition + 1,
          }),
        );
        expect(f.onPersisted).toHaveBeenCalledOnce();
        const terminal = expectDefined(
          await appendTranscriptMessage(f.target, {
            message: { role: "assistant", content: "answer", timestamp: 456 },
          }),
          "terminal",
        );
        const facts = {
          boundary: {
            admission: refreshed,
            terminal: expectDefined(terminal.anchor, "terminal anchor"),
          },
          sessionIdUsed: f.target.sessionId,
          sessionKey: f.target.sessionKey,
          sessionTarget: f.target,
          sessionFile: f.target.sessionKey,
          promptError: false,
          aborted: false,
          yieldAborted: false,
        };
        await finalizeAcceptedContextEngineTurn({ facts, lease, warn });
        expect(warn).not.toHaveBeenCalled();
        expect(commitTurn).toHaveBeenCalledOnce();
        expect(commitTurn).toHaveBeenCalledWith(
          expect.objectContaining({
            messages: [f.recorder.getPersistedMessage?.(), terminal.message],
          }),
        );
      } finally {
        unsubscribe();
      }
    });
  });

  it("retains the original admission when runtime reports a later media event", async () => {
    await withAdmission(async (f) => {
      const pending = f.annotate();
      f.recorder.markRuntimePersistencePending(pending);
      await pending;
      const receipt = structuredClone(f.receipt());
      const prompt = structuredClone(f.recorder.getPersistedMessage?.());
      const media = {
        role: "user" as const,
        content: "",
        timestamp: 456,
        idempotencyKey: `${f.attempt.runId}:user:late-media`,
        __openclaw: {
          lateMedia: true,
          media: [{ kind: "image", path: "/tmp/fixture-image.png", contentType: "image/png" }],
        },
      };
      const appended = expectDefined(
        await appendTranscriptMessage(f.target, { message: media }),
        "late media",
      );
      f.recorder.markRuntimePersisted(media, appended.anchor);
      await f.recorder.waitForRuntimePersistence();
      expect(f.receipt()).toEqual(receipt);
      expect(f.recorder.getPersistedMessage?.()).toEqual(prompt);
      expect(f.onPersisted).toHaveBeenCalledOnce();
    });
  });

  it("preserves existing media and hook metadata without replaying the hook", async () => {
    const hook = vi.fn<NonNullable<CreateUserTurnTranscriptRecorderParams["beforeMessageWrite"]>>(
      ({ message }) => ({ ...message, __openclaw: { ...message["__openclaw"], hookOwned: true } }),
    );
    await withAdmission(
      async (f) => {
        const before = structuredClone(f.recorder.getPersistedMessage?.());
        await f.annotate();
        expect(f.recorder.getPersistedMessage?.()).toEqual({
          ...before,
          __openclaw: { ...before?.["__openclaw"], ...nativeAnnotation(), runId: f.attempt.runId },
        });
        expect(hook).toHaveBeenCalledOnce();
        expect(f.recorder.getPersistedMessage?.()?.["__openclaw"]?.runTerminal).toBeUndefined();
      },
      {
        input: {
          text: "prompt",
          media: [{ path: "/tmp/fixture-image.png", contentType: "image/png" }],
          replyToId: "prior",
          replyToPreview: { text: "prior prompt" },
        },
        beforeMessageWrite: hook,
      },
    );
  });

  it("retains the existing empty-upstream-text fingerprint contract", async () => {
    await withAdmission(async (f) => {
      await f.annotate(nativeAnnotation("prompt", ""));
      expect(f.recorder.getPersistedMessage?.()?.["__openclaw"]?.upstreamUserText).toBe("");
    });
  });

  it.each(["expectedLifecycleRevision", "expectedWriterRunId"] as const)(
    "does not replace an inherited %s with a fresh session snapshot",
    async (field) => {
      await withAdmission(async (f) => {
        const host = createAgentHarnessHostCapabilities({
          attempt: {
            ...f.attempt,
            admittedRunContext: f.admittedRunContext,
            sessionTarget: { ...f.target, [field]: "stale" },
          },
          pluginId: "codex",
        });
        const before = await loadTranscriptEvents(f.target);
        try {
          await expect(
            expectDefined(
              host.capabilities.annotateCurrentUserTurn,
              "bound annotation",
            )(nativeAnnotation()),
          ).rejects.toThrow();
          expect(await loadTranscriptEvents(f.target)).toEqual(before);
        } finally {
          host.close();
        }
      });
    },
  );

  it("does not transfer a retained operation to a replaced recorder or session target", async () => {
    await withAdmission(async (f) => {
      const attempt = { ...f.attempt, admittedRunContext: f.admittedRunContext };
      const host = createAgentHarnessHostCapabilities({ attempt, pluginId: "codex" });
      const annotate = expectDefined(
        host.capabilities.annotateCurrentUserTurn,
        "retained annotation",
      );
      const before = await loadTranscriptEvents(f.target);
      try {
        attempt.userTurnTranscriptRecorder = { ...f.recorder };
        await expect(annotate(nativeAnnotation())).rejects.toThrow();
        attempt.userTurnTranscriptRecorder = f.recorder;
        attempt.sessionTarget = { ...f.target, sessionId: "successor" };
        await expect(annotate(nativeAnnotation())).rejects.toThrow();
        expect(await loadTranscriptEvents(f.target)).toEqual(before);
      } finally {
        host.close();
      }
    });
  });

  it.each([
    "host-close",
    "admission-close",
    "abort",
    "writer",
    "lifecycle",
    "session",
    "replacement",
    "blocked",
  ] as const)("refuses a queued write after %s revocation", async (reason) => {
    await withAdmission(async (f) => {
      const before = await loadTranscriptEvents(f.target);
      const entered = createDeferred();
      const release = createDeferred();
      const locked = runExclusiveSqliteSessionWrite(
        resolveSqliteTranscriptScope(f.target),
        async () => {
          entered.resolve();
          await release.promise;
        },
      );
      await entered.promise;
      const updates = vi.fn();
      const unsubscribe = onInternalSessionTranscriptUpdate(updates);
      const pending = f.annotate();
      const refused = expect(pending).rejects.toThrow();
      try {
        if (reason === "host-close") {
          f.closeHost();
        }
        if (reason === "admission-close") {
          f.closeAdmission();
        }
        if (reason === "abort") {
          f.controller.abort();
        }
        if (reason === "writer") {
          f.patchSession({ activeWriterRunId: "successor" });
        }
        if (reason === "lifecycle") {
          f.patchSession({ lifecycleRevision: "successor" });
        }
        if (reason === "session") {
          f.patchSession({ sessionId: "successor" });
        }
        if (reason === "blocked") {
          f.recorder.markBlocked();
        }
        if (reason === "replacement") {
          const replacement = await createAdmittedHostCapabilityTestFixture(f.attempt);
          replacement.closeHost();
          replacement.closeAdmission();
        }
      } finally {
        release.resolve();
        await locked;
      }
      try {
        await refused;
        expect(await loadTranscriptEvents(f.target)).toEqual(before);
        expect(updates).not.toHaveBeenCalled();
      } finally {
        unsubscribe();
      }
    });
  });

  it("revalidates the captured host-owned worker claim inside the write transaction", async () => {
    await withAdmission(async (f) => {
      const placements = createWorkerSessionPlacementStore();
      let placement = placements.startDispatch(f.target);
      placement = placements.transition({
        sessionId: f.target.sessionId,
        from: "requested",
        to: "provisioning",
        expectedGeneration: placement.generation,
        patch: { environmentId: "annotation-worker" },
      });
      placement = placements.transition({
        sessionId: f.target.sessionId,
        from: "provisioning",
        to: "syncing",
        expectedGeneration: placement.generation,
        patch: { workerBundleHash: "a".repeat(64) },
      });
      placement = placements.transition({
        sessionId: f.target.sessionId,
        from: "syncing",
        to: "starting",
        expectedGeneration: placement.generation,
        patch: {
          workspaceBaseManifestRef: `sha256:${"b".repeat(64)}`,
          remoteWorkspaceDir: "/workspace/annotation",
        },
      });
      placements.transition({
        sessionId: f.target.sessionId,
        from: "starting",
        to: "active",
        expectedGeneration: placement.generation,
        patch: { activeOwnerEpoch: 7 },
      });
      const claim = placements.claimTurn({
        ...f.target,
        runId: f.attempt.runId,
        claimId: "current-claim",
        owner: { kind: "worker", environmentId: "annotation-worker", ownerEpoch: 7 },
      });
      const host = await withGatewayToolCallerIdentity(
        {
          agentId: f.target.agentId,
          sessionKey: f.target.sessionKey,
          operationalRunInstance: f.admittedRunContext.operationalRunInstance,
          workerTurnClaim: claim,
          receiptAuthority: () => placements.validateTurnClaim(claim),
        },
        () =>
          createAgentHarnessHostCapabilities({
            attempt: { ...f.attempt, admittedRunContext: f.admittedRunContext },
            pluginId: "codex",
          }),
      );
      const before = await loadTranscriptEvents(f.target);
      const entered = createDeferred(),
        release = createDeferred();
      const locked = runExclusiveSqliteSessionWrite(
        resolveSqliteTranscriptScope(f.target),
        async () => {
          entered.resolve();
          await release.promise;
        },
      );
      await entered.promise;
      const refused = expect(
        expectDefined(
          host.capabilities.annotateCurrentUserTurn,
          "worker annotation",
        )(nativeAnnotation()),
      ).rejects.toThrow("claim");
      placements.releaseTurn(claim);
      release.resolve();
      await locked;
      try {
        await refused;
        expect(() => host.capabilities.assertActive()).toThrow("claim");
        expect(await loadTranscriptEvents(f.target)).toEqual(before);
      } finally {
        host.close();
      }
    });
  });

  it("refuses a stale active projection even when the old anchor still matches", async () => {
    await withAdmission(async (f) => {
      const before = await loadTranscriptEvents(f.target);
      runOpenClawAgentWriteTransaction(
        (database) => markSessionTranscriptIndexDirtyInTransaction(database.db, f.target.sessionId),
        { agentId: "main" },
      );
      await expect(f.annotate()).rejects.toThrow();
      expect(await loadTranscriptEvents(f.target)).toEqual(before);
    });
  });

  it.each(["edit", "branch"] as const)("does not annotate after an external %s", async (change) => {
    await withAdmission(async (f) => {
      const events = await loadTranscriptEvents(f.target);
      if (change === "edit") {
        const event = expectDefined(asOptionalRecord(events.at(-1)), "transcript event");
        event.message = { ...f.recorder.getPersistedMessage?.(), content: "edited" };
      }
      await replaceTranscriptEvents(f.target, change === "branch" ? events.slice(0, -1) : events);
      const before = await loadTranscriptEvents(f.target);
      await expect(f.annotate()).rejects.toThrow();
      expect(await loadTranscriptEvents(f.target)).toEqual(before);
    });
  });

  it("allows an unrelated append without adopting its identity or moving the admission", async () => {
    await withAdmission(async (f) => {
      const receipt = f.receipt();
      await appendTranscriptMessage(f.target, {
        message: { role: "assistant", content: "unrelated", timestamp: 234 },
      });
      const before = await loadTranscriptEvents(f.target);
      await f.annotate();
      const after = await loadTranscriptEvents(f.target);
      expect(after.at(-1)).toEqual(before.at(-1));
      expect(f.receipt().entryId).toBe(receipt.entryId);
      expect(f.receipt().rawSeq).toBe(receipt.rawSeq);
    });
  });

  it.each([
    "mirrorIdentity",
    "upstreamUserText",
    "mirrorSourceFingerprint",
    "mirrorOrigin",
  ] as const)("refuses conflicting %s without rewriting again", async (field) => {
    await withAdmission(async (f) => {
      await f.annotate();
      const before = await loadTranscriptEvents(f.target);
      await expect(f.annotate({ ...nativeAnnotation(), [field]: "conflict" })).rejects.toThrow();
      expect(await loadTranscriptEvents(f.target)).toEqual(before);
    });
  });

  it("does not rerun admission hooks or bless their content edits", async () => {
    const hook = vi.fn<NonNullable<CreateUserTurnTranscriptRecorderParams["beforeMessageWrite"]>>(
      ({ message }) => ({ ...message, content: "hook changed" }),
    );
    await withAdmission(
      async (f) => {
        const before = await loadTranscriptEvents(f.target);
        await expect(f.annotate()).rejects.toThrow("admitted content");
        expect(await loadTranscriptEvents(f.target)).toEqual(before);
        expect(hook).toHaveBeenCalledOnce();
      },
      { beforeMessageWrite: hook },
    );
  });

  it("never restores upstream text removed by storage redaction", async () => {
    await withAdmission(
      async (f) => {
        const before = await loadTranscriptEvents(f.target);
        await expect(f.annotate(nativeAnnotation("prompt", "private-value"))).rejects.toThrow(
          "redacted",
        );
        expect(await loadTranscriptEvents(f.target)).toEqual(before);
      },
      { config: { logging: { redactPatterns: ["private-value"] } } },
    );
  });

  it.each(["unpersisted", "suppressed", "internal", "copied"] as const)(
    "does not issue current-row authority for %s recorders",
    async (kind) => {
      await withAdmission(
        async (f) => {
          if (kind !== "copied") {
            expect(f.hostCapabilities.annotateCurrentUserTurn).toBeUndefined();
          } else {
            const host = createAgentHarnessHostCapabilities({
              attempt: {
                ...f.attempt,
                admittedRunContext: f.admittedRunContext,
                userTurnTranscriptRecorder: { ...f.recorder },
              },
              pluginId: "codex",
            });
            try {
              expect(host.capabilities.annotateCurrentUserTurn).toBeUndefined();
            } finally {
              host.close();
            }
          }
        },
        {
          persist: kind !== "unpersisted",
          suppress: kind === "suppressed",
          input: kind === "internal" ? { display: false, text: "prompt" } : undefined,
        },
      );
    },
  );

  it("revokes annotation when steering is confirmed without waiting on its own runtime promise", async () => {
    await withAdmission(async (f) => {
      await f.recorder.confirmSteerTargetRunIdForPersistence?.("steered-run");
      const before = await loadTranscriptEvents(f.target);
      const pending = f.annotate();
      f.recorder.markRuntimePersistencePending(pending);
      await expect(pending).rejects.toThrow();
      expect(await loadTranscriptEvents(f.target)).toEqual(before);
    });
  });
});
