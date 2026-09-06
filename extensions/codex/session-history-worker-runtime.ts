import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  captureCodexSessionTranscriptReadAdmission,
  validateCodexSessionTranscriptReadAdmission,
  validateCodexSessionTranscriptContextVersion,
} from "openclaw/plugin-sdk/codex-session-transcript-runtime";
import { WorkerTaskPool } from "openclaw/plugin-sdk/process-runtime";
import { isIncognitoSessionKey } from "openclaw/plugin-sdk/session-key-runtime";
import type { TranscriptTurnAdmission } from "openclaw/plugin-sdk/session-transcript-runtime";
import {
  codexHistoryWorkerUrl,
  runCodexHistoryWorkerInput,
  type CodexHistoryWorkerInput,
  type CodexHistoryWorkerResult,
} from "./session-history.worker.js";
import type { JsonValue } from "./src/app-server/protocol.js";
import {
  resolveCodexHistoryTarget,
  type CodexMirroredSessionHistoryTarget,
} from "./src/app-server/session-history.js";
import type { SettledTurnMessages } from "./src/app-server/settled-turn-evidence.js";

const historyReads = new WorkerTaskPool<CodexHistoryWorkerInput, CodexHistoryWorkerResult>({
  workerUrl: codexHistoryWorkerUrl,
  maxWorkers: 1,
});

async function readHistory(
  target: CodexMirroredSessionHistoryTarget,
  operation: { kind: "messages" } | { kind: "settled"; evidence: SettledTurnMessages },
  admission?: TranscriptTurnAdmission,
  signal?: AbortSignal,
): Promise<CodexHistoryWorkerResult> {
  signal?.throwIfAborted();
  const resolved = resolveCodexHistoryTarget(target, admission);
  const receipt =
    admission ??
    (resolved.kind === "sqlite"
      ? captureCodexSessionTranscriptReadAdmission(resolved.target)
      : undefined);
  const input: CodexHistoryWorkerInput = {
    ...operation,
    target: resolved,
    sessionId: target.sessionId,
    ...(receipt ? { admission: { ...receipt } } : {}),
  };
  // Incognito SQLite is held by this process; run the same lazy operation here.
  const result =
    resolved.kind === "sqlite" && isIncognitoSessionKey(resolved.target.sessionKey)
      ? await runCodexHistoryWorkerInput(input)
      : await historyReads.run(input, { timeoutMs: 60_000, signal });
  signal?.throwIfAborted();
  if (resolved.kind === "sqlite") {
    if (input.admission) {
      validateCodexSessionTranscriptReadAdmission(resolved.target, input.admission);
    } else {
      validateCodexSessionTranscriptContextVersion(resolved.target, result.version);
    }
  }
  return result;
}

export async function readCodexHistoryMessagesInWorker(
  target: CodexMirroredSessionHistoryTarget,
  admission?: TranscriptTurnAdmission,
  signal?: AbortSignal,
): Promise<AgentMessage[] | undefined> {
  const result = await readHistory(target, { kind: "messages" }, admission, signal);
  return result.kind === "messages" ? result.messages : undefined;
}

function describeSettledHistoryFailure(result: CodexHistoryWorkerResult): string | undefined {
  if (!result.failure) {
    return undefined;
  }
  if (result.failure.code === "history_consumer_failed") {
    switch (result.failure.reason) {
      case "settled_turn_item_limit":
        return "Codex settled-turn projection exceeds the item limit";
      case "settled_turn_size_limit":
        return "Codex settled-turn projection exceeds the size limit";
      case "settled_turn_unsupported_content":
        return "Codex settled-turn projection found unsupported content";
      case "settled_turn_invalid_evidence":
        return "Codex settled-turn projection found invalid evidence";
      default:
        return "Codex settled-turn history projection failed";
    }
  }
  return "Codex settled-turn history read failed";
}

export async function projectCodexSettledHistoryInWorker(
  target: CodexMirroredSessionHistoryTarget & SettledTurnMessages,
  signal?: AbortSignal,
): Promise<JsonValue[] | undefined> {
  const result = await readHistory(
    target,
    {
      kind: "settled",
      evidence: {
        mirroredMessages: target.mirroredMessages,
        settledMessages: target.settledMessages,
        turnId: target.turnId,
      },
    },
    undefined,
    signal,
  );
  const failure = describeSettledHistoryFailure(result);
  if (failure) {
    throw new Error(failure);
  }
  return result.kind === "settled" ? result.data : undefined;
}
