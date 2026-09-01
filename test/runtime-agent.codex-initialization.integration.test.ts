import { expectDefined } from "@openclaw/normalization-core";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodexSessionInitializationFixtureForTest } from "../extensions/codex/test-api.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  rollbackAgentHarnessSessionEntryLifecycle,
} from "../src/config/sessions/session-accessor.js";
import { writeSessionEntry } from "../src/config/sessions/session-accessor.sqlite-entry-store.js";
import { sessionRewindHandlers } from "../src/gateway/server-methods/sessions-rewind.js";
import type { GatewayRequestContext } from "../src/gateway/server-methods/types.js";
import {
  createPluginStateSyncKeyedStore,
  type OpenKeyedStoreOptions,
} from "../src/plugin-state/plugin-state-store.js";
import { createEmptyPluginRegistry } from "../src/plugins/registry-empty.js";
import {
  markPluginRegistryActive,
  markPluginRegistryRetired,
} from "../src/plugins/registry-lifecycle.js";
import { withPluginRuntimeRegistryScope } from "../src/plugins/runtime/gateway-request-scope.js";
import { createRuntimeAgent } from "../src/plugins/runtime/runtime-agent.js";
import { createPluginRecord } from "../src/plugins/status.test-helpers.js";
import {
  readSessionUpstreamLink,
  upsertSessionUpstreamLink,
} from "../src/sessions/session-upstream-links.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
  deferOpenClawAgentPostCommitPublication,
} from "../src/state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../src/state/openclaw-state-db.js";
import { withOpenClawTestState } from "../src/test-utils/openclaw-test-state.js";

afterEach(() => vi.restoreAllMocks());

describe("Codex initialization through the registered session deletion owner", () => {
  it.each([
    ...[
      "callback",
      "import",
      "before binding",
      "after binding",
      "final readiness",
      "readiness publication",
      "lost response",
      "successor binding",
      "successor link",
      "existing link",
      "source successor",
      "source successor during link write",
      "source successor during link cleanup",
      "registry rotation",
      "rollback commit",
      "native cleanup",
    ].map((failure) => ({ flow: "fork", failure })),
    ...["callback", "before binding", "after binding", "final readiness", "rollback commit"].map(
      (failure) => ({ flow: "adoption", failure }),
    ),
  ])(
    "preserves exactly the committed owner after $flow $failure failure",
    async ({ flow, failure }) => {
      await withOpenClawTestState({ label: "codex-initialization-owner" }, async (state) => {
        const agent = createRuntimeAgent();
        const runtime = createPluginRuntimeMock({
          agent,
          state: {
            openSyncKeyedStore: <T>(options: OpenKeyedStoreOptions) =>
              createPluginStateSyncKeyedStore<T>("codex", options),
          },
        });
        const fixture = await createCodexSessionInitializationFixtureForTest({
          runtime,
          workspaceDir: state.workspaceDir,
        });
        const { params, sourceThread, forkedThread, native, bindingStore, harness } = fixture;
        const sourceBinding = await bindingStore.read(fixture.sourceIdentity);
        const sourceEntry = loadSessionEntry(params.source);
        let expectedSourceEntry = sourceEntry;
        const replaceSource = () => {
          runOpenClawAgentWriteTransaction(
            (database) =>
              writeSessionEntry(database, params.source.sessionKey, {
                ...expectDefined(sourceEntry, "source"),
                sessionId: "source-successor",
                lifecycleRevision: "successor-generation",
              }),
            { agentId: "main" },
          );
          expectedSourceEntry = loadSessionEntry({ ...params.source, readConsistency: "latest" });
        };
        const sourceHistory = await loadTranscriptEvents(params.source);
        const registry = createEmptyPluginRegistry();
        registry.plugins.push(createPluginRecord({ id: "codex" }));
        registry.agentHarnesses.push({ pluginId: "codex", source: "runtime", harness });
        markPluginRegistryActive(registry);
        const invokeFork = async () => {
          expect(
            upsertSessionUpstreamLink({
              sessionKey: params.source.sessionKey,
              agentId: "main",
              catalogId: params.upstream.catalogId,
              hostId: params.upstream.hostId,
              upstreamKind: params.upstream.kind,
              threadId: sourceThread.id,
              upstreamRef: params.upstream.ref,
              marker: null,
            }),
          ).toBe(true);
          let result: { status: string; message?: string } | undefined;
          const request = { sessionKey: params.source.sessionKey, entryId: params.source.entryId };
          await expectDefined(
            sessionRewindHandlers["sessions.fork"],
            "fork handler",
          )({
            req: {
              type: "req",
              id: "initialization-owner",
              method: "sessions.fork",
              params: request,
            },
            params: request,
            client: null,
            isWebchatConnect: () => false,
            context: {
              getRuntimeConfig: () => ({}),
              chatAbortControllers: new Map(),
              getSessionEventSubscriberConnIds: () => new Set(),
              broadcastToConnIds: vi.fn(),
            } as unknown as GatewayRequestContext,
            respond: (ok, _payload, error) => {
              result = {
                status: ok ? "created" : "failed",
                ...(error ? { message: error.message } : {}),
              };
            },
          });
          return expectDefined(result, "fork response");
        };
        const deletion = vi.spyOn(harness, "withSessionDeletion");
        const mutate = bindingStore.mutate.bind(bindingStore);
        let childSessionId: string | undefined;
        let retained:
          | Parameters<
              NonNullable<Parameters<typeof agent.session.createSessionEntry>[0]["afterCreate"]>
            >[0]["initialization"]
          | undefined;
        const create = runtime.agent.session.createSessionEntry;
        vi.spyOn(runtime.agent.session, "createSessionEntry").mockImplementation(async (input) => {
          const created = await create({
            ...input,
            afterCreate: async (context) => {
              childSessionId = context.sessionId;
              params.targetKey = context.key;
              retained = context.initialization;
              if (failure.startsWith("source successor during link")) {
                const database = openOpenClawStateDatabase();
                database.db.function("replace_initialization_source", () => {
                  replaceSource();
                  return 0;
                });
                const operation = failure.endsWith("write") ? "INSERT" : "DELETE";
                database.db.exec(
                  `CREATE TEMP TRIGGER replace_source AFTER ${operation} ON session_upstream_links BEGIN SELECT replace_initialization_source(); END`,
                );
              }
              if (failure === "callback") {
                throw new Error("injected callback failure");
              }
              if (failure === "existing link") {
                expect(
                  upsertSessionUpstreamLink({
                    sessionKey: context.key,
                    agentId: context.agentId,
                    catalogId: "codex",
                    hostId: "gateway:local",
                    upstreamKind: "codex-app-server",
                    threadId: "existing-successor",
                    upstreamRef: { threadId: "existing-successor" },
                    marker: null,
                  }),
                ).toBe(true);
                successorLink = readSessionUpstreamLink(context.key, context.agentId);
              }
              if (failure === "import") {
                openOpenClawAgentDatabase({ agentId: "main" }).db.exec(
                  "CREATE TEMP TRIGGER reject_import BEFORE INSERT ON transcript_events BEGIN SELECT RAISE(ABORT, 'injected import failure'); END",
                );
              }
              const patch = await input.afterCreate!(context);
              if (!patch) {
                throw new Error("Codex initializer did not return its final patch");
              }
              return patch;
            },
          });
          if (failure === "lost response") {
            expect(created.entry.initializationPending).toBeUndefined();
            throw new Error("injected response loss after readiness");
          }
          return created;
        });
        let successorBinding: Awaited<ReturnType<typeof bindingStore.read>>;
        let successorLink: ReturnType<typeof readSessionUpstreamLink>;
        if (failure === "native cleanup") {
          native.archiveThread.mockRejectedValue(new Error("injected archive failure"));
          native.control.retireConnection = vi.fn();
        }
        vi.spyOn(bindingStore, "mutate").mockImplementation(async (identity, mutation, guard) => {
          if (mutation.kind !== "set") {
            return await mutate(identity, mutation, guard);
          }
          if (identity.kind === "session") {
            childSessionId = identity.sessionId;
          }
          if (failure === "before binding") {
            throw new Error("injected binding write failure");
          }
          const attached = await mutate(identity, mutation, guard);
          expect(attached).toBe(true);
          if (failure === "source successor") {
            replaceSource();
          }
          if (failure === "registry rotation") {
            markPluginRegistryRetired(registry);
            markPluginRegistryActive(registry);
          }
          if (failure === "successor binding") {
            await mutate(identity, {
              kind: "patch",
              threadId: forkedThread.id,
              patch: { model: "successor-model" },
            });
            successorBinding = await bindingStore.read(identity);
          }
          if (failure === "successor link") {
            expect(
              upsertSessionUpstreamLink({
                ...expectDefined(readSessionUpstreamLink(params.targetKey, "main"), "created link"),
                marker: { turnId: "successor-turn", userMessageCount: 2 },
                threadId: "successor-thread",
              }),
            ).toBe(true);
            successorLink = readSessionUpstreamLink(params.targetKey, "main");
          }
          if (failure === "rollback commit") {
            openOpenClawAgentDatabase({ agentId: "main" }).db.exec(
              "CREATE TEMP TRIGGER reject_rollback BEFORE DELETE ON session_nodes BEGIN SELECT RAISE(ABORT, 'injected rollback failure'); END",
            );
          }
          if (
            [
              "after binding",
              "successor binding",
              "successor link",
              "rollback commit",
              "native cleanup",
              "source successor during link cleanup",
            ].includes(failure)
          ) {
            throw new Error("injected post-write failure");
          }
          if (failure === "final readiness") {
            openOpenClawAgentDatabase({ agentId: "main" }).db.exec(
              "CREATE TEMP TRIGGER reject_readiness BEFORE UPDATE OF entry_json ON session_nodes WHEN json_extract(OLD.entry_json, '$.initializationPending') = 1 AND json_extract(NEW.entry_json, '$.initializationPending') IS NULL BEGIN SELECT RAISE(ABORT, 'injected readiness failure'); END",
            );
          }
          if (failure === "readiness publication") {
            const database = openOpenClawAgentDatabase({ agentId: "main" });
            database.db.function("inject_publication_failure", () => {
              deferOpenClawAgentPostCommitPublication(database, () => {
                throw new Error("injected readiness publication failure");
              });
              return 0;
            });
            database.db.exec(
              "CREATE TEMP TRIGGER reject_publication AFTER UPDATE OF entry_json ON session_nodes WHEN json_extract(OLD.entry_json, '$.initializationPending') = 1 AND json_extract(NEW.entry_json, '$.initializationPending') IS NULL BEGIN SELECT inject_publication_failure(); END",
            );
          }
          return attached;
        });

        const result = await withPluginRuntimeRegistryScope(
          registry,
          flow === "fork" ? invokeFork : fixture.adopt,
        );

        expect(result).toMatchObject({ status: "failed" });
        const identity = {
          kind: "session" as const,
          agentId: "main",
          sessionKey: params.targetKey,
          sessionId: expectDefined(childSessionId, "created child identity"),
        };
        const child = loadSessionEntry(identity);
        const binding = await bindingStore.read(identity);
        const link = readSessionUpstreamLink(params.targetKey, "main");
        if (failure === "lost response" || failure === "readiness publication") {
          expect(child?.initializationPending).toBeUndefined();
          expect(child?.sessionId).toBe(childSessionId);
          expect(binding?.threadId).toBe(forkedThread.id);
          expect(link?.threadId).toBe(forkedThread.id);
          expect(native.archiveThread).not.toHaveBeenCalled();
          expect(deletion).not.toHaveBeenCalled();
        } else if (failure.startsWith("source successor during link")) {
          if (failure.endsWith("write")) {
            expect(child?.initializationPending).toBe(true);
          } else {
            expect(child).toBeUndefined();
          }
          expect(binding).toBeUndefined();
          expect(link?.threadId).toBe(failure.endsWith("cleanup") ? forkedThread.id : undefined);
          expect(native.archiveThread).not.toHaveBeenCalled();
          expect(result).toMatchObject({
            message: expect.stringContaining("guarded rollback did not complete"),
          });
        } else if (
          [
            "successor binding",
            "rollback commit",
            "source successor",
            "registry rotation",
          ].includes(failure)
        ) {
          expect(child?.initializationPending).toBe(true);
          expect(binding).toEqual(
            successorBinding ??
              expect.objectContaining({
                threadId: flow === "fork" ? forkedThread.id : sourceThread.id,
              }),
          );
          expect(link?.threadId).toBe(flow === "fork" ? forkedThread.id : undefined);
          expect(native.archiveThread).not.toHaveBeenCalled();
          expect(result).toMatchObject({
            message: expect.stringContaining("guarded rollback did not complete"),
          });
        } else {
          expect(deletion).toHaveBeenCalledOnce();
          expect(child).toBeUndefined();
          expect(binding).toBeUndefined();
          expect(link).toEqual(successorLink);
          expect(await loadTranscriptEvents(identity)).toEqual([]);
          if (failure === "successor link" || flow === "adoption") {
            expect(native.archiveThread).not.toHaveBeenCalled();
          } else {
            expect(native.archiveThread).toHaveBeenCalledExactlyOnceWith(
              forkedThread.id,
              failure === "callback"
                ? undefined
                : expectDefined(retained, "initializer handle").assertRollbackCurrent,
            );
          }
          if (failure === "native cleanup") {
            expect(native.control.retireConnection).toHaveBeenCalledOnce();
            expect(result).toMatchObject({
              message: expect.stringContaining("guarded rollback did not complete"),
            });
          }
        }
        expect(() => expectDefined(retained, "initializer handle").assertCurrent()).toThrow(
          "closed",
        );
        expect(() => expectDefined(retained, "initializer handle").assertRollbackCurrent()).toThrow(
          "closed",
        );
        if (failure === "lost response") {
          await expect(
            withPluginRuntimeRegistryScope(registry, () =>
              rollbackAgentHarnessSessionEntryLifecycle({
                agentId: "main",
                storePath: params.source.storePath,
                target: { canonicalKey: params.targetKey, storeKeys: [params.targetKey] },
                expectedEntry: expectDefined(child, "ready child"),
                expectedSessionId: identity.sessionId,
                expectedUpdatedAt: child!.updatedAt,
                archiveTranscript: true,
              }),
            ),
          ).rejects.toThrow("owned by supervision");
          expect(loadSessionEntry(identity)).toEqual(child);
          expect(await bindingStore.read(identity)).toEqual(binding);
        }
        expect(await bindingStore.read(fixture.sourceIdentity)).toEqual(sourceBinding);
        expect(loadSessionEntry(params.source)).toEqual(expectedSourceEntry);
        expect(await loadTranscriptEvents(params.source)).toEqual(sourceHistory);
        expect(native.archiveThread.mock.calls).not.toEqual(
          expect.arrayContaining([expect.arrayContaining([sourceThread.id])]),
        );
      });
    },
  );
});
