import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { SessionTranscriptContextVersion } from "openclaw/plugin-sdk/codex-session-transcript-runtime";
import { serveWorkerTasks } from "openclaw/plugin-sdk/process-runtime";
import type { TranscriptTurnAdmission } from "openclaw/plugin-sdk/session-transcript-runtime";
import type { CodexHistoryReadResult } from "./src/app-server/history-rejection.js";
import type { JsonValue } from "./src/app-server/protocol.js";
import {
  readCodexNativeHistory,
  type ResolvedCodexHistoryTarget,
} from "./src/app-server/session-history-read.js";
import {
  projectVerifiedSettledCodexMessages,
  type SettledTurnMessages,
} from "./src/app-server/settled-turn-evidence.js";

type ReadInput = {
  target: ResolvedCodexHistoryTarget;
  sessionId: string;
  admission?: TranscriptTurnAdmission;
};
export type CodexHistoryWorkerInput = ReadInput &
  ({ kind: "messages" } | { kind: "settled"; evidence: SettledTurnMessages });
export type CodexHistoryWorkerResult = (
  | { kind: "messages"; result: CodexHistoryReadResult<AgentMessage[]> }
  | { kind: "settled"; result: CodexHistoryReadResult<JsonValue[]> }
) & { version?: SessionTranscriptContextVersion };

// This top-level plugin entry is packaged in both standalone and bundled builds.
export const codexHistoryWorkerUrl = new URL(import.meta.url);

export async function runCodexHistoryWorkerInput(
  input: unknown,
): Promise<CodexHistoryWorkerResult> {
  // SAFETY: The paired runtime constructs this request; the SQLite snapshot validates admission.
  const request = input as CodexHistoryWorkerInput;
  let version: SessionTranscriptContextVersion | undefined;
  const onSnapshot = (value: SessionTranscriptContextVersion | undefined) => {
    version = value;
  };
  if (request.kind === "messages") {
    const result = await readCodexNativeHistory(
      request.target,
      request.sessionId,
      (messages) => Array.from(messages),
      request.admission,
      onSnapshot,
    );
    return {
      kind: request.kind,
      result,
      version,
    };
  }
  if (request.kind === "settled") {
    const result = await readCodexNativeHistory(
      request.target,
      request.sessionId,
      (messages) => projectVerifiedSettledCodexMessages(messages, request.evidence),
      request.admission,
      onSnapshot,
    );
    return {
      kind: request.kind,
      result,
      version,
    };
  }
  throw new Error("Invalid Codex history worker operation");
}

serveWorkerTasks(runCodexHistoryWorkerInput);
