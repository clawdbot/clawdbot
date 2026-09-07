import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { HookRunner } from "../../plugins/hooks.js";
import {
  getActiveGatewayRootWorkCount,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../../process/gateway-work-admission.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { PreparedAgentRunAdmission } from "../admitted-run-context.js";
import type {
  AcceptedCompactionSuccessor,
  acceptCompactionSuccessor,
} from "./compaction-successor.js";

type AcceptanceInput = Parameters<typeof acceptCompactionSuccessor>[0];

const hooks = vi.hoisted(() => ({
  hasHooks: vi.fn<HookRunner["hasHooks"]>(),
  runSessionEnd: vi.fn<HookRunner["runSessionEnd"]>(),
  runSessionStart: vi.fn<HookRunner["runSessionStart"]>(),
}));
vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => hooks,
}));

async function withAcceptanceFixture(
  options: { claimWriter?: boolean },
  body: (fixture: {
    target: AcceptanceInput["currentTarget"];
    entry: InternalSessionEntry;
    successorId: string;
    callerError: Error;
    assertActive: () => void;
    stop: () => void;
    accept: (overrides?: Partial<AcceptanceInput>) => Promise<AcceptedCompactionSuccessor>;
    facts: AcceptedCompactionSuccessor[];
    loadEntry: () => InternalSessionEntry | undefined;
    replaceWriter: () => Promise<void>;
    replaceEntry: (patch: Partial<InternalSessionEntry>) => Promise<unknown>;
    deleteEntry: () => Promise<unknown>;
    observeIdentity: (observer: () => void) => void;
    writeLegacyArtifact: () => Promise<string>;
  }) => Promise<void>,
) {
  await withOpenClawTestState(
    { label: "compaction-successor", scenario: "minimal" },
    async (state) => {
      const {
        appendTranscriptMessage,
        applySessionEntryLifecycleMutation,
        loadSessionEntry,
        loadTranscriptEvents,
        replaceSessionEntry,
      } = await import("../../config/sessions/session-accessor.js");
      const { waitForSessionTranscriptIndexReconcile } =
        await import("../../config/sessions/session-transcript-reconcile.js");
      const { prepareSystemAgentRunAdmission, resolveAdmittedRunActiveAssertion } =
        await import("../admitted-run-context.js");
      const { claimAgentSessionWriter } = await import("./run/session-bootstrap.js");
      const { onSessionIdentityMutation } =
        await import("../../sessions/session-lifecycle-events.js");
      const { forgetActiveSessionForShutdown } =
        await import("../../gateway/active-sessions-shutdown-tracker.js");
      const { acceptCompactionSuccessor } = await import("./compaction-successor.js");
      const target = {
        agentId: "main",
        sessionId: randomUUID(),
        sessionKey: `agent:main:${randomUUID()}`,
        storePath: path.join(state.agentDir(), "openclaw-agent.sqlite"),
      };
      await replaceSessionEntry(target, {
        sessionId: target.sessionId,
        lifecycleRevision: randomUUID(),
        updatedAt: 1,
        compactionCount: 7,
      });
      await appendTranscriptMessage(target, {
        cwd: state.workspaceDir,
        message: { role: "user", content: "Preserved predecessor history", timestamp: 1 },
      });
      const runId = randomUUID();
      const admission = prepareSystemAgentRunAdmission({}, runId, target.agentId, "successor-test");
      const admissions: PreparedAgentRunAdmission[] = [admission];
      const unsubscriptions: Array<() => void> = [];
      const facts: AcceptedCompactionSuccessor[] = [];
      const controller = new AbortController();
      const callerError = new Error("caller stopped successor acceptance");
      try {
        const admittedRunContext = await admission.admit("embedded");
        const runParams = {
          ...target,
          sessionFile: target.sessionKey,
          sessionTarget: target,
          runId,
          admittedRunContext,
          workspaceDir: state.workspaceDir,
          prompt: "continue",
          timeoutMs: 30_000,
        };
        if (options.claimWriter !== false) {
          await claimAgentSessionWriter(runParams);
        }
        const entry: InternalSessionEntry | undefined = loadSessionEntry(target);
        if (!entry) {
          throw new Error("fixture must own an existing durable session");
        }
        const live = resolveAdmittedRunActiveAssertion(admittedRunContext);
        if (!live) {
          throw new Error("fixture must own a live admission");
        }
        const assertActive = () => {
          controller.signal.throwIfAborted();
          live();
        };
        const stop = () => {
          admission.close();
          controller.abort(callerError);
        };
        const successorId = randomUUID();
        const input: AcceptanceInput = {
          currentTarget: target,
          expectedEntry: {
            sessionId: entry.sessionId,
            lifecycleRevision: entry.lifecycleRevision,
            activeWriterRunId: entry.activeWriterRunId,
          },
          assertActive,
          config: {},
          result: {
            ok: true,
            compacted: true,
            result: {
              summary: "Engine-owned successor context",
              tokensBefore: 4_097,
              tokensAfter: 3_000,
              sessionTarget: { sessionId: successorId, threadId: "thread-hint" },
            },
          },
        };
        await body({
          target,
          entry,
          successorId,
          callerError,
          assertActive,
          stop,
          facts,
          accept: (overrides = {}) =>
            acceptCompactionSuccessor({
              ...input,
              ...overrides,
              onCommitted: (accepted) => {
                facts.push(accepted);
                overrides.onCommitted?.(accepted);
              },
            }),
          loadEntry: () => loadSessionEntry(target),
          replaceWriter: async () => {
            const nextRunId = randomUUID();
            const next = prepareSystemAgentRunAdmission(
              {},
              nextRunId,
              target.agentId,
              "replacement-successor-test",
            );
            admissions.push(next);
            const nextContext = await next.admit("embedded");
            await claimAgentSessionWriter({
              ...runParams,
              runId: nextRunId,
              admittedRunContext: nextContext,
            });
          },
          replaceEntry: (patch) => replaceSessionEntry(target, { ...entry, ...patch }),
          deleteEntry: () =>
            applySessionEntryLifecycleMutation({
              agentId: target.agentId,
              storePath: target.storePath,
              removals: [{ sessionKey: target.sessionKey }],
              skipMaintenance: true,
            }),
          observeIdentity: (observer) => {
            unsubscriptions.push(
              onSessionIdentityMutation((mutation) => {
                if (
                  mutation.kind === "replace" &&
                  mutation.previous.sessionId === target.sessionId
                ) {
                  observer();
                }
              }),
            );
          },
          writeLegacyArtifact: async () => {
            // Named tagged-upgrade artifact contract: session_end may identify a
            // still-existing legacy export, while live state remains canonical SQLite.
            const artifact = path.join(state.agentDir(), `${target.sessionId}.jsonl`);
            const events = await loadTranscriptEvents(target);
            await fs.writeFile(
              artifact,
              `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
            );
            return await fs.realpath(artifact);
          },
        });
      } finally {
        for (const unsubscribe of unsubscriptions) {
          unsubscribe();
        }
        for (const owned of admissions) {
          owned.close();
        }
        await waitForSessionTranscriptIndexReconcile({
          agentId: target.agentId,
          path: target.storePath,
          env: state.env,
        });
        forgetActiveSessionForShutdown(target.sessionId);
        for (const accepted of facts) {
          forgetActiveSessionForShutdown(accepted.sessionId);
        }
      }
    },
  );
}

beforeEach(() => {
  resetGatewayWorkAdmission();
  hooks.hasHooks.mockReset().mockReturnValue(false);
  hooks.runSessionEnd.mockReset().mockResolvedValue(undefined);
  hooks.runSessionStart.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  resetGatewayWorkAdmission();
  vi.restoreAllMocks();
});

function enableLifecycleHooks() {
  hooks.hasHooks.mockImplementation((name) => name === "session_end" || name === "session_start");
}

describe("acceptCompactionSuccessor", () => {
  it.each(["rotation", "unchanged", "cancel-after-commit"] as const)(
    "owns MCP predecessor cleanup after %s",
    async (kind) => {
      await withAcceptanceFixture({}, async (fixture) => {
        const { getOrCreateSessionMcpRuntime } =
          await import("../agent-bundle-mcp-manager.test-support.js");
        const { getSessionMcpRuntimeManagerForTesting } =
          await import("../agent-bundle-mcp-manager-api.js");
        const manager = getSessionMcpRuntimeManagerForTesting();
        const create = (sessionId: string) =>
          getOrCreateSessionMcpRuntime({
            sessionId,
            sessionKey: fixture.target.sessionKey,
            workspaceDir: path.dirname(fixture.target.storePath),
            cfg: { mcp: { servers: {} } },
            manifestRegistry: { plugins: [] },
          });
        try {
          const original = await create(fixture.target.sessionId);
          const release = original.acquireLease?.();
          const successor = await create(fixture.successorId);
          if (kind === "cancel-after-commit") {
            fixture.observeIdentity(fixture.stop);
          }
          const accepted = await fixture.accept(
            kind === "unchanged" ? { result: { ok: true, compacted: true } } : {},
          );
          if (kind !== "unchanged") {
            await create(original.sessionId);
          }
          release?.();
          await manager.completeDeferredRetirement(original.sessionId, original);
          expect(manager.peekSession({ sessionId: original.sessionId })).toBe(
            kind === "unchanged" ? original : undefined,
          );
          expect(manager.peekSession({ sessionId: successor.sessionId })).toBe(successor);
          if (kind === "rotation") {
            const latest = await create(randomUUID());
            await fixture.accept({
              currentTarget: accepted.sessionTarget,
              expectedEntry: {
                sessionId: accepted.entry.sessionId,
                lifecycleRevision: accepted.entry.lifecycleRevision,
                activeWriterRunId: accepted.entry.activeWriterRunId,
              },
              result: {
                ok: true,
                compacted: true,
                result: { tokensBefore: 1, sessionTarget: { sessionId: latest.sessionId } },
              },
            });
            expect(manager.peekSession({ sessionId: successor.sessionId })).toBeUndefined();
            expect(manager.peekSession({ sessionId: latest.sessionId })).toBe(latest);
          }
        } finally {
          await manager.disposeAll();
        }
      });
    },
  );

  it.each([true, false])(
    "transfers the declared identity without reclaiming its writer (claimed=%s)",
    async (claimWriter) => {
      await withAcceptanceFixture({ claimWriter }, async (fixture) => {
        const accepted = await fixture.accept();
        expect(accepted.sessionTarget).toMatchObject({
          ...fixture.target,
          sessionId: fixture.successorId,
          threadId: "thread-hint",
        });
        expect(accepted.previousSessionId).toBe(fixture.target.sessionId);
        expect(accepted.entry).toMatchObject({
          sessionId: fixture.successorId,
          lifecycleRevision: fixture.entry.lifecycleRevision,
          compactionCount: 7,
          usageFamilyKey: fixture.target.sessionKey,
          usageFamilySessionIds: [fixture.target.sessionId, fixture.successorId],
        });
        expect(accepted.entry.activeWriterRunId).toBe(fixture.entry.activeWriterRunId);
        expect(fixture.loadEntry()).toEqual(accepted.entry);
        expect(fixture.facts).toEqual([accepted]);
        fixture.assertActive();
      });
    },
  );

  it.each([false, true])(
    "does not write or notify when the accepted identity is unchanged (compacted=%s)",
    async (compacted) => {
      await withAcceptanceFixture({}, async (fixture) => {
        const before = fixture.loadEntry();
        const identity = vi.fn();
        fixture.observeIdentity(identity);
        const accepted = await fixture.accept({ result: { ok: true, compacted } });
        expect(accepted.previousSessionId).toBeUndefined();
        expect(accepted.sessionTarget).toEqual(fixture.target);
        expect(fixture.loadEntry()).toEqual(before);
        expect(fixture.facts).toEqual([]);
        expect(identity).not.toHaveBeenCalled();
        expect(hooks.runSessionEnd).not.toHaveBeenCalled();
        expect(hooks.runSessionStart).not.toHaveBeenCalled();
      });
    },
  );

  it.each([
    { ok: false, compacted: true },
    { ok: true, compacted: false },
  ])("does not transfer a failed or declined successor ($ok/$compacted)", async (outcome) => {
    await withAcceptanceFixture({}, async (fixture) => {
      enableLifecycleHooks();
      const before = fixture.loadEntry();
      await expect(
        fixture.accept({
          result: {
            ...outcome,
            result: { tokensBefore: 4_097, sessionId: fixture.successorId },
          },
        }),
      ).rejects.toThrow("without a successful completed compaction");
      expect(fixture.loadEntry()).toEqual(before);
      expect(fixture.facts).toEqual([]);
      expect(hooks.runSessionEnd).not.toHaveBeenCalled();
      expect(hooks.runSessionStart).not.toHaveBeenCalled();
    });
  });

  it.each(["writer", "lifecycle", "session", "deleted"] as const)(
    "rejects a stale predecessor after %s replacement",
    async (change) => {
      await withAcceptanceFixture({}, async (fixture) => {
        if (change === "writer") {
          await fixture.replaceWriter();
        } else if (change === "lifecycle") {
          await fixture.replaceEntry({ lifecycleRevision: randomUUID() });
        } else if (change === "session") {
          await fixture.replaceEntry({ sessionId: randomUUID() });
        } else {
          await fixture.deleteEntry();
        }
        const before = fixture.loadEntry();
        await expect(fixture.accept()).rejects.toThrow("session writer claim changed");
        expect(fixture.loadEntry()).toEqual(before);
        expect(fixture.facts).toEqual([]);
      });
    },
  );

  it("treats a captured absent writer as exact absence rather than a wildcard", async () => {
    await withAcceptanceFixture({ claimWriter: false }, async (fixture) => {
      expect(fixture.entry.activeWriterRunId).toBeUndefined();
      await fixture.replaceWriter();
      const before = fixture.loadEntry();
      await expect(fixture.accept()).rejects.toThrow("session writer claim changed");
      expect(fixture.loadEntry()).toEqual(before);
      expect(fixture.facts).toEqual([]);
    });
  });

  it("preserves the caller error and predecessor when cancellation precedes commit", async () => {
    await withAcceptanceFixture({}, async (fixture) => {
      const before = fixture.loadEntry();
      await expect(
        fixture.accept({
          assertActive: () => {
            fixture.assertActive();
            queueMicrotask(fixture.stop);
          },
        }),
      ).rejects.toBe(fixture.callerError);
      expect(fixture.loadEntry()).toEqual(before);
      expect(fixture.facts).toEqual([]);
    });
  });

  it("captures a real commit before an identity observer cancels the caller", async () => {
    await withAcceptanceFixture({}, async (fixture) => {
      let factAtObserver: AcceptedCompactionSuccessor | undefined;
      fixture.observeIdentity(() => {
        factAtObserver = fixture.facts[0];
        fixture.stop();
      });
      const accepted = await fixture.accept();
      expect(factAtObserver).toBe(accepted);
      expect(accepted.entry.sessionId).toBe(fixture.successorId);
      expect(fixture.loadEntry()).toEqual(accepted.entry);
      expect(fixture.assertActive).toThrow(fixture.callerError);
    });
  });

  it("returns the known commit after a fact observer throws, without repeating notifications", async () => {
    await withAcceptanceFixture({}, async (fixture) => {
      const identity = vi.fn();
      fixture.observeIdentity(identity);
      enableLifecycleHooks();
      const accepted = await fixture.accept({
        onCommitted: () => {
          throw new Error("fact observer failed");
        },
      });
      expect(fixture.facts).toEqual([accepted]);
      expect(fixture.loadEntry()).toEqual(accepted.entry);
      expect(identity).toHaveBeenCalledOnce();
      expect(hooks.runSessionEnd).toHaveBeenCalledOnce();
      expect(hooks.runSessionStart).toHaveBeenCalledOnce();
      await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
    });
  });
});

describe("accepted successor lifecycle notifications", () => {
  it.each([false, true])(
    "publishes predecessor/successor payloads with a stable locator (legacy artifact=%s)",
    async (legacyArtifact) => {
      await withAcceptanceFixture({}, async (fixture) => {
        enableLifecycleHooks();
        const locator = legacyArtifact
          ? await fixture.writeLegacyArtifact()
          : `sqlite:${fixture.target.agentId}:${fixture.target.sessionId}:${fixture.target.storePath}`;
        await fixture.accept();
        expect(hooks.runSessionEnd).toHaveBeenCalledOnce();
        expect(hooks.runSessionStart).toHaveBeenCalledOnce();
        const [end, endContext] = hooks.runSessionEnd.mock.calls[0]!;
        const [start, startContext] = hooks.runSessionStart.mock.calls[0]!;
        expect(end).toMatchObject({
          sessionId: fixture.target.sessionId,
          sessionKey: fixture.target.sessionKey,
          reason: "compaction",
          sessionFile: locator,
          nextSessionId: fixture.successorId,
        });
        expect(end.transcriptArchived).toBe(legacyArtifact ? false : undefined);
        expect(start).toMatchObject({
          sessionId: fixture.successorId,
          sessionKey: fixture.target.sessionKey,
          resumedFrom: fixture.target.sessionId,
        });
        expect(endContext).toEqual({
          sessionId: fixture.target.sessionId,
          sessionKey: fixture.target.sessionKey,
          agentId: "main",
        });
        expect(startContext).toEqual({
          sessionId: fixture.successorId,
          sessionKey: fixture.target.sessionKey,
          agentId: "main",
        });
        await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
      });
    },
  );

  it.each([false, true])(
    "keeps both notification roots alive through settlement (restart draining=%s)",
    async (draining) => {
      await withAcceptanceFixture({}, async (fixture) => {
        enableLifecycleHooks();
        const endGate = createDeferred();
        const startGate = createDeferred();
        hooks.runSessionEnd.mockImplementationOnce(() => endGate.promise);
        hooks.runSessionStart.mockImplementationOnce(() => startGate.promise);
        const admission = draining ? tryBeginGatewayRootWorkAdmission() : null;
        try {
          if (draining) {
            expect(admission).not.toBeNull();
            await admission!.run(async () => {
              markGatewayRestartDraining();
              await fixture.accept();
              await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(3));
            });
            admission!.release();
          } else {
            await fixture.accept();
          }
          await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(2));
          expect(hooks.runSessionEnd).toHaveBeenCalledOnce();
          expect(hooks.runSessionStart).toHaveBeenCalledOnce();
          endGate.resolve();
          await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(1));
          startGate.resolve();
          await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
        } finally {
          admission?.release();
          endGate.resolve();
          startGate.resolve();
          await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
        }
      });
    },
  );
});
