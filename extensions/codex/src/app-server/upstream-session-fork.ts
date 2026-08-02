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
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { isIncognitoSessionKey } from "../incognito-session.js";
import type { CodexSessionCatalogControl } from "../session-catalog-types.js";
import { codexLastTerminalTurnId, codexUpstreamBaseline } from "../session-upstream-marker.js";
import { assertCodexThreadForkResponse } from "./protocol-validators.js";
import type { CodexThread, CodexThreadForkResponse } from "./protocol.js";
import { sessionBindingIdentity, type CodexAppServerBindingStore } from "./session-binding.js";
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

function normalizeTurnId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export async function forkCodexUpstreamSession(
  params: AgentHarnessSessionForkParams,
  options: {
    bindingStore: CodexAppServerBindingStore;
    control: CodexSessionCatalogControl;
    harnessRuntimeId: string;
    resolveConfig?: () => OpenClawConfig | undefined;
    runtime: PluginRuntime;
  },
): Promise<AgentHarnessSessionForkResult> {
  try {
    return await options.control.withPinnedConnection(async (control) => {
      const incognito = isIncognitoSessionKey(params.targetKey);
      const clientId = control.clientId?.trim();
      if (incognito && !clientId) {
        throw new Error("Incognito Codex forks require the live pinned app-server client");
      }
      let linked = false;
      let bindingIdentity: ReturnType<typeof sessionBindingIdentity> | undefined;
      const compensateFork = async (forkedThreadId: string) => {
        if (bindingIdentity) {
          await options.bindingStore
            .mutate(bindingIdentity, { kind: "clear", threadId: forkedThreadId })
            .catch(() => undefined);
        }
        if (linked) {
          deleteSessionUpstreamLink(params.targetKey, params.source.agentId);
        }
        await control.archiveThread(forkedThreadId).catch(() => undefined);
      };
      const sourceFingerprint = readConnectionFingerprint(params.upstream.ref);
      if (
        params.upstream.kind !== "codex-app-server" ||
        !sourceFingerprint ||
        sourceFingerprint !== control.connectionFingerprint
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
        threadId: params.upstream.threadId,
        control,
      });
      if (!resolved.ok) {
        return { status: "failed", code: resolved.code, message: resolved.message };
      }
      const liveTurns = await listCodexUpstreamTurns(control, params.upstream.threadId);
      const precheck = precheckCodexUpstreamForkBoundary({
        boundary: resolved.boundary,
        turns: liveTurns,
      });
      if (!precheck.ok) {
        return { status: "failed", code: precheck.code, message: precheck.message };
      }
      // beforeTurnId is experimental; the initialized shared client explicitly negotiates it.
      const rawResponse = await control.forkThread({
        threadId: params.upstream.threadId,
        beforeTurnId: resolved.boundary.beforeTurnId,
        ...(incognito ? { ephemeral: true } : {}),
        excludeTurns: !incognito,
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
        if (orphanThreadId && orphanThreadId !== params.upstream.threadId) {
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
      if (threadId === params.upstream.threadId) {
        throw new Error("Codex thread/fork response reused the source thread id");
      }
      const forkedThreadId = threadId;
      try {
        const connectionFingerprint = control.connectionFingerprint;
        if (!connectionFingerprint) {
          throw new Error("Codex fork connection did not include a fingerprint");
        }
        const forkedTurns = incognito
          ? (response.thread.turns ?? [])
          : await listCodexUpstreamTurns(control, threadId);
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
        const throughTurnId = codexLastTerminalTurnId(forkedThread, normalizeTurnId) ?? null;
        const marker = codexUpstreamBaseline(forkedThread, normalizeTurnId);
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
            bindingIdentity = sessionBindingIdentity({
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
            const attached = await options.bindingStore.mutate(bindingIdentity, {
              kind: "set",
              binding: {
                threadId,
                ...(incognito && clientId ? { clientId } : {}),
                cwd: forkedThread.cwd ?? "",
                model: response.model,
                modelProvider: response.modelProvider ?? undefined,
                historyCoveredThrough: new Date().toISOString(),
              },
            });
            if (!attached) {
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
