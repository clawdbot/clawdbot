import type {
  AgentHarnessSessionForkParams,
  AgentHarnessSessionForkResult,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import {
  deleteSessionUpstreamLink,
  upsertSessionUpstreamLink,
} from "openclaw/plugin-sdk/session-catalog";
import { isRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { CodexSessionCatalogControlFactory } from "../session-catalog-types.js";
import { codexLastTerminalTurnId, codexUpstreamBaseline } from "../session-upstream-marker.js";
import { assertCodexThreadForkResponse } from "./protocol-validators.js";
import type { CodexThread, CodexThreadForkResponse } from "./protocol.js";
import {
  sessionBindingIdentity,
  type CodexAppServerBindingStore,
  type CodexAppServerPendingSupervisionBranch,
} from "./session-binding.js";
import { createImportedCodexSession } from "./session-history-import.js";
import {
  listCodexUpstreamTurns,
  precheckCodexUpstreamForkBoundary,
  resolveCodexUpstreamForkBoundary,
} from "./upstream-fork-boundary.js";

function readConnectionFingerprint(ref: unknown): string | undefined {
  if (!isRecord(ref)) {
    return undefined;
  }
  return typeof ref.connectionFingerprint === "string" && ref.connectionFingerprint.trim()
    ? ref.connectionFingerprint
    : undefined;
}

export async function forkCodexUpstreamSession(
  params: AgentHarnessSessionForkParams,
  options: {
    bindingStore: CodexAppServerBindingStore;
    controlFactory: CodexSessionCatalogControlFactory;
    harnessRuntimeId: string;
    resolveConfig?: () => OpenClawConfig | undefined;
    runtime: PluginRuntime;
  },
): Promise<AgentHarnessSessionForkResult> {
  try {
    const sourceFingerprint =
      params.upstream.kind === "codex-app-server"
        ? readConnectionFingerprint(params.upstream.ref)
        : undefined;
    const requestControl = sourceFingerprint
      ? options.controlFactory.forUpstream(params.source.agentId, sourceFingerprint)
      : undefined;
    if (!sourceFingerprint || !requestControl) {
      return {
        status: "failed",
        code: "upstream-unavailable",
        message:
          "This Codex thread is not available on the current connection. Reconnect to its host and try again.",
      };
    }
    return await requestControl.withPinnedConnection(async (control) => {
      const sourceBinding = await options.bindingStore.read(
        sessionBindingIdentity({ ...params.source, config: options.resolveConfig?.() }),
      );
      // Inherited mirror identities belong to the original source even after
      // materialization. New canonical turns have no supported child lifecycle yet.
      const supervised = sourceBinding?.connectionScope === "supervision";
      const sourceThreadId = params.upstream.threadId;
      let linked = false;
      let createdBinding:
        | {
            identity: ReturnType<typeof sessionBindingIdentity>;
            pending: CodexAppServerPendingSupervisionBranch;
          }
        | undefined;
      const compensateFork = async (forkedThreadId: string) => {
        if (createdBinding) {
          const cleared = await options.bindingStore
            .mutate(createdBinding.identity, {
              kind: "clear",
              threadId: forkedThreadId,
              expectedPendingSupervisionBranch: createdBinding.pending,
            })
            .catch(() => false);
          // A changed pending or materialized owner now owns the link and native
          // artifact. Never reread that successor to authorize failed-creation cleanup.
          if (!cleared) {
            return;
          }
        }
        if (linked) {
          deleteSessionUpstreamLink(params.targetKey, params.source.agentId);
        }
        await control.archiveThread(forkedThreadId).catch(() => undefined);
      };
      if (
        sourceFingerprint !== control.connectionFingerprint ||
        (supervised &&
          (sourceBinding.supervisionSourceThreadId !== params.upstream.threadId ||
            (sourceBinding.pendingSupervisionBranch?.connectionFingerprint ??
              sourceBinding.appServerRuntimeFingerprint) !== sourceFingerprint))
      ) {
        return {
          status: "failed",
          code: "upstream-unavailable",
          message:
            "This Codex thread is not available on the current connection. Reconnect to its host and try again.",
        };
      }
      const resolved = await resolveCodexUpstreamForkBoundary({
        ...params.source,
        threadId: sourceThreadId,
        control,
      });
      if (!resolved.ok) {
        return { status: "failed", code: resolved.code, message: resolved.message };
      }
      const liveTurns = await listCodexUpstreamTurns(control, sourceThreadId);
      const precheck = precheckCodexUpstreamForkBoundary({
        boundary: resolved.boundary,
        turns: liveTurns,
      });
      if (!precheck.ok) {
        return { status: "failed", code: precheck.code, message: precheck.message };
      }
      // beforeTurnId is experimental; the initialized shared client explicitly negotiates it.
      const rawResponse = await control.forkThread({
        threadId: sourceThreadId,
        beforeTurnId: resolved.boundary.beforeTurnId,
        ...(params.sandbox === "required" ? { sandbox: "workspace-write" as const } : {}),
        excludeTurns: true,
      });
      let response: CodexThreadForkResponse;
      try {
        response = assertCodexThreadForkResponse(rawResponse);
      } catch (error) {
        const orphanThreadId =
          isRecord(rawResponse.thread) && typeof rawResponse.thread.id === "string"
            ? rawResponse.thread.id.trim()
            : "";
        // A malformed response cannot be trusted to name a NEW thread; never archive an
        // id that matches the source conversation.
        if (
          orphanThreadId &&
          orphanThreadId !== sourceThreadId &&
          orphanThreadId !== sourceBinding?.threadId
        ) {
          await control.archiveThread(orphanThreadId).catch(() => undefined);
        }
        throw error;
      }
      const threadId = response.thread.id.trim();
      if (!threadId) {
        throw new Error("Codex thread/fork response did not include a thread id");
      }
      // A contract-violating response reusing the source id would bind (and later
      // archive) the original conversation; reject identity reuse outright.
      if (threadId === sourceThreadId || threadId === sourceBinding?.threadId) {
        throw new Error("Codex thread/fork response reused the source thread id");
      }
      const forkedThreadId = threadId;
      try {
        const connectionFingerprint = normalizeOptionalString(control.connectionFingerprint);
        if (!connectionFingerprint) {
          throw new Error("Codex fork connection did not include a fingerprint");
        }
        const forkedTurns = await listCodexUpstreamTurns(control, threadId);
        const expectedLastTurnId = resolved.boundary.retainedMarker.turnId;
        const actualLastTurnId = forkedTurns.at(-1)?.id ?? null;
        // Boundary resolution already verified the source prefix; this read-back tail identity
        // detects app-server versions that ignored the exclusive beforeTurnId cut.
        if (actualLastTurnId !== expectedLastTurnId) {
          await compensateFork(forkedThreadId);
          return {
            status: "failed",
            code: "upstream-unavailable",
            message:
              "This Codex version does not support message-level forks. Update Codex, reconnect, and try again.",
          };
        }
        const forkedThread: CodexThread = { ...response.thread, turns: forkedTurns };
        const throughTurnId =
          codexLastTerminalTurnId(forkedThread, normalizeOptionalString) ?? null;
        const marker = codexUpstreamBaseline(forkedThread, normalizeOptionalString);
        const config = options.resolveConfig?.() ?? {};
        const created = await createImportedCodexSession({
          runtime: options.runtime,
          config,
          key: params.targetKey,
          agentId: params.source.agentId,
          thread: forkedThread,
          throughTurnId,
          initialEntry: {
            agentHarnessId: options.harnessRuntimeId,
            modelSelectionLocked: true,
          },
          afterImport: async (entry) => {
            const bindingIdentity = sessionBindingIdentity({
              agentId: entry.agentId,
              sessionId: entry.sessionId,
              sessionKey: entry.key,
              config,
            });
            // Link BEFORE bind: a crash cannot expose a bound session to local-only
            // rewind/switch while its canonical upstream ownership is missing.
            linked = upsertSessionUpstreamLink({
              sessionKey: entry.key,
              agentId: entry.agentId,
              catalogId: params.upstream.catalogId,
              hostId: params.upstream.hostId,
              threadId,
              upstreamKind: params.upstream.kind,
              upstreamRef: { connectionFingerprint, threadId },
              marker,
            });
            if (!linked) {
              throw new Error("Codex fork link could not be persisted");
            }
            // Capture before set: persistence may succeed before its caller throws.
            createdBinding = {
              identity: bindingIdentity,
              pending: {
                sourceThreadId: threadId,
                connectionFingerprint,
                ...(throughTurnId ? { lastTurnId: throughTurnId } : {}),
              },
            };
            const attached = await options.bindingStore.mutate(bindingIdentity, {
              kind: "set",
              if: { kind: "absent" },
              binding: {
                threadId,
                connectionScope: "supervision",
                supervisionSourceThreadId: threadId,
                preserveNativeModel: true,
                conversationSourceTransferComplete: true,
                // The full harness applies tools/instructions and injects this verified
                // stored snapshot before committing its canonical native thread.
                pendingSupervisionBranch: createdBinding.pending,
                cwd: forkedThread.cwd ?? "",
                model: response.model,
                modelProvider: response.modelProvider ?? undefined,
                historyCoveredThrough: new Date().toISOString(),
              },
            });
            if (!attached) {
              createdBinding = undefined;
              throw new Error("Codex session binding changed before the fork could be attached");
            }
            return { pluginExtensions: entry.entry.pluginExtensions };
          },
        });
        return {
          status: "created",
          key: created.key,
          ...(resolved.editorText !== undefined ? { editorText: resolved.editorText } : {}),
        };
      } catch {
        // thread/fork commits before local materialization. The guarded session initializer
        // rolls back its row/transcript; this capability clears link/binding and archives the orphan.
        await compensateFork(forkedThreadId);
        return {
          status: "failed",
          code: "upstream-unavailable",
          message:
            "The Codex fork could not be verified or imported into a new session. Refresh sessions and try again.",
        };
      }
    });
  } catch {
    return {
      status: "failed",
      code: "upstream-unavailable",
      message:
        "The Codex thread could not be forked. Check that Codex is available, then try again.",
    };
  }
}
