import type {
  AgentHarnessSessionForkParams,
  AgentHarnessSessionForkResult,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { isRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { CodexSessionCatalogControlFactory } from "../session-catalog-types.js";
import { codexLastTerminalTurnId, codexUpstreamBaseline } from "../session-upstream-marker.js";
import { forkCanonicalCodexSession } from "./canonical-session-fork.js";
import { assertCodexThreadForkResponse } from "./protocol-validators.js";
import type { CodexThread } from "./protocol.js";
import { sessionBindingIdentity, type CodexAppServerBindingStore } from "./session-binding.js";
import { createImportedCodexSession } from "./session-history-import.js";
import { withCodexAppServerThreadMutation } from "./thread-ownership.js";
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
      // Imported identities remain rooted at S; new canonical turns belong to C.
      const supervised = sourceBinding?.connectionScope === "supervision";
      const sourceThreadId = params.upstream.threadId;
      let initializerOwnsFork = false;
      const archiveFreshFork = async (forkedThreadId: string, assertCurrent?: () => void) =>
        withCodexAppServerThreadMutation(forkedThreadId, async () => {
          assertCurrent?.();
          if (await options.bindingStore.hasOtherThreadOwner(forkedThreadId)) {
            throw new Error("Codex fork cleanup refused: the native thread has another owner");
          }
          assertCurrent?.();
          try {
            await control.archiveThread(forkedThreadId, assertCurrent);
            assertCurrent?.();
          } catch (cause) {
            control.retireConnection?.();
            throw new Error(
              "Codex fork cleanup could not be verified; inspect the retained native thread before retrying.",
              { cause },
            );
          }
        });
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
        canonicalThreadId:
          supervised && !sourceBinding.pendingSupervisionBranch
            ? sourceBinding.threadId
            : undefined,
        control,
      });
      if (!resolved.ok) {
        return { status: "failed", code: resolved.code, message: resolved.message };
      }
      if (resolved.canonical && sourceBinding) {
        return await forkCanonicalCodexSession({
          fork: params,
          resolved: { ...resolved, canonical: resolved.canonical },
          sourceBinding,
          control,
          bindingStore: options.bindingStore,
          runtime: options.runtime,
          harnessRuntimeId: options.harnessRuntimeId,
          config: options.resolveConfig?.() ?? {},
        });
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
      // Malformed responses do not establish ownership of any purported orphan id.
      const response = assertCodexThreadForkResponse(rawResponse);
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
        const expectedLastTurnId = resolved.boundary.lastRetainedTurnId;
        const actualLastTurnId = forkedTurns.at(-1)?.id ?? null;
        // Boundary resolution already verified the source prefix; this read-back tail identity
        // detects app-server versions that ignored the exclusive beforeTurnId cut.
        if (actualLastTurnId !== expectedLastTurnId) {
          throw new Error(
            "This Codex version does not support message-level forks. Update Codex, reconnect, and try again.",
          );
        }
        const forkedThread: CodexThread = { ...response.thread, turns: forkedTurns };
        const throughTurnId =
          codexLastTerminalTurnId(forkedThread, normalizeOptionalString) ?? null;
        const marker = codexUpstreamBaseline(forkedThread, normalizeOptionalString);
        const config = options.resolveConfig?.() ?? {};
        const created = await createImportedCodexSession({
          runtime: options.runtime,
          bindingStore: options.bindingStore,
          prepareCleanup: () => {
            initializerOwnsFork = true;
            return (assertCurrent) => archiveFreshFork(forkedThreadId, assertCurrent);
          },
          config,
          key: params.targetKey,
          agentId: params.source.agentId,
          thread: forkedThread,
          throughTurnId,
          initialEntry: {
            agentHarnessId: options.harnessRuntimeId,
            modelSelectionLocked: true,
          },
          afterImport: async (entry, initialization) => {
            // Link BEFORE bind: a crash cannot expose a bound session to local-only
            // rewind/switch while its canonical upstream ownership is missing.
            initialization.link({
              sessionKey: entry.key,
              agentId: entry.agentId,
              catalogId: params.upstream.catalogId,
              hostId: params.upstream.hostId,
              threadId,
              upstreamKind: params.upstream.kind,
              upstreamRef: { connectionFingerprint, threadId },
              marker,
            });
            await initialization.bind({
              threadId,
              connectionScope: "supervision",
              supervisionSourceThreadId: threadId,
              preserveNativeModel: true,
              conversationSourceTransferComplete: true,
              // The full harness applies tools/instructions and injects this verified
              // stored snapshot before committing its canonical native thread.
              pendingSupervisionBranch: {
                sourceThreadId: threadId,
                connectionFingerprint,
                ...(throughTurnId ? { lastTurnId: throughTurnId } : {}),
              },
              cwd: forkedThread.cwd ?? "",
              model: response.model,
              modelProvider: response.modelProvider ?? undefined,
              historyCoveredThrough: new Date().toISOString(),
            });
            return { pluginExtensions: entry.entry.pluginExtensions };
          },
        });
        return {
          status: "created",
          key: created.key,
          ...(resolved.editorText !== undefined ? { editorText: resolved.editorText } : {}),
        };
      } catch (error) {
        // Once a host initializer captures the artifact, only its guarded rollback may clean it.
        if (!initializerOwnsFork) {
          await options.bindingStore.withThreadArchiveFence(() => archiveFreshFork(forkedThreadId));
        }
        return {
          status: "failed",
          code: "upstream-unavailable",
          message:
            error instanceof Error
              ? error.message
              : "The Codex fork could not be imported. Refresh sessions and try again.",
        };
      }
    });
  } catch (error) {
    return {
      status: "failed",
      code: "upstream-unavailable",
      message:
        error instanceof Error
          ? error.message
          : "The Codex thread could not be forked. Check that Codex is available, then try again.",
    };
  }
}
