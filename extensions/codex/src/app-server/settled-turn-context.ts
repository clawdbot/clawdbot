import { embeddedAgentLog, formatErrorMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { JsonValue } from "./protocol.js";
import type { CodexMirroredSessionHistoryTarget } from "./session-history.js";
import type { SettledTurnMessages } from "./settled-turn-evidence.js";

function freezeProjection(value: JsonValue): void {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) {
      freezeProjection(child);
    }
    Object.freeze(value);
  }
}

type CodexSettledTurnSelection = {
  model: string;
  modelProvider?: string;
  authProfileId?: string;
};

/** Only the Codex owner interprets this bounded, detached replay projection. */
export class CodexSettledTurnContext {
  readonly source = "harness";

  constructor(
    readonly data: JsonValue[],
    readonly selection: CodexSettledTurnSelection,
  ) {
    freezeProjection(data);
    Object.freeze(selection);
    Object.freeze(this);
  }
}

/** Verifies and freezes a complete replay projection while reading the active branch. */
export async function captureCodexSettledTurnFinalizationContext(
  params: CodexMirroredSessionHistoryTarget &
    SettledTurnMessages &
    Partial<CodexSettledTurnSelection> & { signal?: AbortSignal; assertActive?: () => void },
): Promise<CodexSettledTurnContext | undefined> {
  try {
    params.signal?.throwIfAborted();
    params.assertActive?.();
    const { model, modelProvider, authProfileId } = params;
    if (!model) {
      throw new Error("Codex settled-turn model selection is unavailable");
    }
    const { projectCodexSettledHistoryInWorker } =
      await import("../../session-history-worker-runtime.js");
    const data = await projectCodexSettledHistoryInWorker(params, params.signal);
    params.signal?.throwIfAborted();
    params.assertActive?.();
    return data === undefined
      ? undefined
      : new CodexSettledTurnContext(data, { model, modelProvider, authProfileId });
  } catch (error) {
    // Capture follows settled side effects; any failure must preserve the incomplete-turn result.
    embeddedAgentLog.warn("codex settled-turn finalization context capture failed", {
      error: formatErrorMessage(error),
      turnId: params.turnId,
    });
    return undefined;
  }
}
