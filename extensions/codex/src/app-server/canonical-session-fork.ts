import { isDeepStrictEqual } from "node:util";
import type { AgentHarnessSessionForkParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { appendSessionTranscriptMessagesByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { readCodexSessionMeta } from "../session-catalog-provenance.js";
import type { CodexSessionCatalogControl } from "../session-catalog-types.js";
import { readCodexRolloutSelection } from "../session-rollout-selection.js";
import { codexUpstreamBaseline } from "../session-upstream-marker.js";
import { prepareCanonicalCodexFork } from "./canonical-fork-preparation.js";
import {
  claimCodexAppServerLiveThread,
  hasCodexAppServerLiveThread,
  type CodexAppServerLiveThreadOwnership,
} from "./client-runtime.js";
import { parseCodexNativeToolCatalog } from "./native-tool-catalog.js";
import { attestCodexPluginThreadApps } from "./plugin-thread-attestation.js";
import { assertCodexThreadForkResponse } from "./protocol-validators.js";
import { flattenCodexDynamicToolFunctions } from "./protocol.js";
import { CodexAppServerScopedRequestRejectedError } from "./request.js";
import {
  sessionBindingIdentity,
  type CodexAppServerBindingStore,
  type CodexAppServerThreadBinding,
} from "./session-binding.js";
import { prepareCodexSessionInitialization } from "./session-initialization.js";
import { codexDynamicToolsFingerprint } from "./thread-fingerprints.js";
import { withCodexAppServerThreadMutation } from "./thread-ownership.js";
import { CodexThreadPolicyHandoffError, refreshCodexThreadPolicy } from "./thread-policy.js";
import {
  listCodexUpstreamTurns,
  type CodexUpstreamForkBoundaryResult,
} from "./upstream-fork-boundary.js";

type Boundary = Extract<CodexUpstreamForkBoundaryResult, { ok: true }> & {
  canonical: NonNullable<Extract<CodexUpstreamForkBoundaryResult, { ok: true }>["canonical"]>;
};

/** Native history stays native; only the verified local display prefix is copied. */
export async function forkCanonicalCodexSession(params: {
  fork: AgentHarnessSessionForkParams;
  resolved: Boundary;
  sourceBinding: CodexAppServerThreadBinding;
  control: CodexSessionCatalogControl;
  bindingStore: CodexAppServerBindingStore;
  runtime: PluginRuntime;
  harnessRuntimeId: string;
  config: OpenClawConfig;
}) {
  const { fork, resolved, control, bindingStore, sourceBinding, config } = params;
  const context = control.forkContext;
  if (!context?.localSessionsRoot || !resolved.canonical.thread.path) {
    throw new Error(
      "Canonical Codex forks require the verified local rollout on its selected connection. Fork an original imported message instead.",
    );
  }
  const sourceIdentity = sessionBindingIdentity({ ...fork.source, config });
  return bindingStore.withLease(sourceIdentity, async () => {
    if (!isDeepStrictEqual(await bindingStore.read(sourceIdentity), sourceBinding)) {
      throw new Error("Codex canonical source binding changed before initialization");
    }
    let freshThreadId: string | undefined;
    let ownership: CodexAppServerLiveThreadOwnership | undefined;
    let subscriptionReleased = false;
    let policyWriteUncertain = false;
    const result = await params.runtime.agent.session
      .createSessionEntry({
        cfg: config,
        key: fork.targetKey,
        agentId: fork.source.agentId,
        spawnedCwd: resolved.canonical.thread.cwd ?? sourceBinding.cwd,
        initialEntry: { agentHarnessId: params.harnessRuntimeId, modelSelectionLocked: true },
        afterCreate: async (created) => {
          if (!created.initialization) {
            throw new Error("Canonical Codex forks require host creation authority");
          }
          const host = created.initialization;
          const initialization = prepareCodexSessionInitialization({
            initialization: host,
            bindingStore,
            identity: sessionBindingIdentity({
              agentId: created.agentId,
              sessionId: created.sessionId,
              sessionKey: created.key,
              config,
            }),
            assertCleanupAllowed: () => {
              // Unsubscribe/archive ACK cannot prove an in-flight injection stopped.
              // Keep the host's existing non-ready cleanup outcome for inspection.
              if (policyWriteUncertain) {
                throw new Error(
                  "Fresh Codex policy delivery is uncertain; cleanup could not be verified. Inspect the retained thread before retrying.",
                );
              }
            },
            prepareCleanup: () => async (assertCurrent) => {
              if (!freshThreadId) {
                return;
              }
              const threadId = freshThreadId;
              await withCodexAppServerThreadMutation(threadId, async () => {
                assertCurrent();
                if (!subscriptionReleased) {
                  if (!ownership) {
                    throw new Error(
                      "The fresh Codex fork has no verified subscription owner; inspect it before retrying.",
                    );
                  }
                  ownership.assertCurrent();
                }
                if (await bindingStore.hasOtherThreadOwner(threadId)) {
                  throw new Error("Codex fork cleanup refused: a successor owns the native thread");
                }
                assertCurrent();
                try {
                  await control.archiveThread(threadId, assertCurrent);
                } catch (cause) {
                  control.retireConnection?.();
                  throw new Error(
                    "Fresh Codex fork cleanup could not be verified; inspect the retained thread before retrying.",
                    { cause },
                  );
                }
                // Archive completed; its later notification owns local claim removal.
                subscriptionReleased = true;
                assertCurrent();
              });
            },
          });
          const assertCurrent = () => {
            initialization.assertCurrent();
            if (ownership && !subscriptionReleased) {
              ownership.assertCurrent();
            }
          };
          const selection = await readCodexRolloutSelection({
            sessionsRoot: context.localSessionsRoot!,
            rolloutPath: resolved.canonical.thread.path!,
            threadId: sourceBinding.threadId,
            assertCurrent,
          });
          assertCurrent();
          if (!sourceBinding.dynamicToolsFingerprint) {
            throw new Error("The canonical source has no verified native catalog binding");
          }
          const sourceCatalog = parseCodexNativeToolCatalog(
            selection.metadata,
            sourceBinding.threadId,
            sourceBinding.dynamicToolsFingerprint,
          );
          const prepared = await prepareCanonicalCodexFork({
            created,
            initialization: host,
            config,
            context,
            model: selection.model,
            modelProvider: selection.modelProvider,
            sandbox: fork.sandbox,
            dynamicTools: sourceCatalog,
          });
          assertCurrent();
          await selection.assertUnchanged();
          assertCurrent();
          await resolved.canonical.assertUnchanged();
          assertCurrent();
          if (!isDeepStrictEqual(await bindingStore.read(sourceIdentity), sourceBinding)) {
            throw new Error("Codex canonical source binding changed during preparation");
          }
          assertCurrent();
          let raw: unknown;
          try {
            raw = await control.forkThread(
              {
                ...prepared.request,
                threadId: sourceBinding.threadId,
                beforeTurnId: resolved.boundary.beforeTurnId,
                model: selection.model,
                modelProvider: selection.modelProvider,
                threadSource: "appServer",
                excludeTurns: true,
              },
              assertCurrent,
            );
          } catch (error) {
            // Rejected ownership never entered the wire; an unknown native outcome must retire it.
            if (!(error instanceof CodexAppServerScopedRequestRejectedError)) {
              control.retireConnection?.();
            }
            throw error;
          }
          let response;
          try {
            response = assertCodexThreadForkResponse(raw);
          } catch (error) {
            control.retireConnection?.();
            throw error;
          }
          if (
            !response.thread.id.trim() ||
            response.thread.id === sourceBinding.threadId ||
            response.thread.id === fork.upstream.threadId ||
            response.thread.forkedFromId !== sourceBinding.threadId ||
            (await bindingStore.hasOtherThreadOwner(response.thread.id))
          ) {
            control.retireConnection?.();
            throw new Error("Codex fork returned an unsafe native thread identity");
          }
          freshThreadId = response.thread.id;
          ownership = await claimCodexAppServerLiveThread(context.client, freshThreadId);
          if (!ownership) {
            control.retireConnection?.();
            throw new Error("Codex fork subscription ownership could not be acquired");
          }
          assertCurrent();
          if (
            response.model !== selection.model ||
            response.modelProvider !== selection.modelProvider ||
            response.thread.modelProvider !== selection.modelProvider
          ) {
            throw new Error(
              "Codex fork did not preserve the exact canonical source and selected native model",
            );
          }
          const turns = await listCodexUpstreamTurns(control, freshThreadId);
          assertCurrent();
          const cut = resolved.canonical.turns.findIndex(
            (turn) => turn.id === resolved.boundary.beforeTurnId,
          );
          if (cut < 0 || !isDeepStrictEqual(turns, resolved.canonical.turns.slice(0, cut))) {
            throw new Error(
              "Codex did not apply the exact beforeTurnId cut. Reconnect to a compatible server and retry.",
            );
          }
          const metadata = response.thread.path
            ? await readCodexSessionMeta(
                context.localSessionsRoot!,
                response.thread.path,
                freshThreadId,
              )
            : undefined;
          assertCurrent();
          if (!metadata || metadata.model_provider !== selection.modelProvider) {
            throw new Error("The fresh Codex fork metadata could not be verified");
          }
          const childCatalog = parseCodexNativeToolCatalog(metadata, freshThreadId);
          if (!isDeepStrictEqual(sourceCatalog, childCatalog)) {
            throw new Error("Codex fork did not preserve the actual native tool catalog");
          }
          await selection.assertUnchanged();
          assertCurrent();
          await attestCodexPluginThreadApps({
            client: context.client,
            threadId: freshThreadId,
            appIds: prepared.provisionalAppIds,
          });
          assertCurrent();
          await resolved.canonical.assertUnchanged();
          assertCurrent();
          try {
            await refreshCodexThreadPolicy({
              client: context.client,
              threadId: freshThreadId,
              developerInstructions: prepared.request.developerInstructions,
              timeoutMs: context.appServer.requestTimeoutMs,
              assertCurrent,
            });
          } catch (error) {
            if (error instanceof CodexThreadPolicyHandoffError && error.outcome === "unknown") {
              policyWriteUncertain = true;
              control.retireConnection?.();
            }
            throw error;
          }
          const appended = await appendSessionTranscriptMessagesByIdentity({
            config,
            storePath: resolveStorePath(config.session?.store, { agentId: created.agentId }),
            agentId: created.agentId,
            sessionKey: created.key,
            sessionId: created.sessionId,
            messages: resolved.canonical.prefix.map((entry) => ({
              message: structuredClone(entry.message),
              idempotencyLookup: "scan" as const,
            })),
          });
          assertCurrent();
          if (
            appended.length !== resolved.canonical.prefix.length ||
            appended.some(
              (item, index) =>
                !item.appended ||
                !isDeepStrictEqual(item.message, resolved.canonical.prefix[index]?.message) ||
                (index > 0 && item.effectiveParentId !== appended[index - 1]?.messageId),
            )
          ) {
            throw new Error("The canonical Codex display prefix could not be copied completely");
          }
          initialization.link({
            sessionKey: created.key,
            agentId: created.agentId,
            catalogId: fork.upstream.catalogId,
            hostId: fork.upstream.hostId,
            threadId: fork.upstream.threadId,
            upstreamKind: fork.upstream.kind,
            upstreamRef: fork.upstream.ref,
            marker: codexUpstreamBaseline({ ...response.thread, turns }, normalizeOptionalString),
          });
          await initialization.bind({
            threadId: freshThreadId,
            connectionScope: "supervision",
            supervisionSourceThreadId: fork.upstream.threadId,
            preserveNativeModel: true,
            conversationSourceTransferComplete: true,
            cwd: prepared.request.cwd ?? "",
            rolloutPath: response.thread.path ?? undefined,
            model: selection.model,
            modelProvider: selection.modelProvider,
            appServerRuntimeFingerprint: control.connectionFingerprint,
            dynamicToolsFingerprint: codexDynamicToolsFingerprint(childCatalog),
            dynamicToolsContainDeferred: flattenCodexDynamicToolFunctions(childCatalog).some(
              (tool) => tool.deferLoading === true,
            ),
            ...prepared.bindingPolicy,
            historyCoveredThrough: new Date().toISOString(),
          });
          assertCurrent();
          await ownership.release(freshThreadId, assertCurrent);
          subscriptionReleased = true;
          initialization.assertCurrent();
          await resolved.canonical.assertUnchanged();
          initialization.assertCurrent();
          if (!isDeepStrictEqual(await bindingStore.read(sourceIdentity), sourceBinding)) {
            throw new Error("Codex source binding changed before fork readiness");
          }
          initialization.assertCurrent();
          return { pluginExtensions: created.entry.pluginExtensions };
        },
      })
      .finally(() => {
        // Host rollback may lose archive authority. Retire the captured subscription separately;
        // archive notifications already clear ordinary cleanup, and sibling leases still drain.
        if (
          freshThreadId &&
          !subscriptionReleased &&
          hasCodexAppServerLiveThread(context.client, freshThreadId)
        ) {
          control.retireConnection?.();
        }
      });
    return {
      status: "created" as const,
      key: result.key,
      ...(resolved.editorText !== undefined ? { editorText: resolved.editorText } : {}),
    };
  });
}
