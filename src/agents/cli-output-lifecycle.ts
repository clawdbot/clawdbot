import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { formatErrorMessage } from "../infra/errors.js";
import type {
  CliBackendConfig,
  CliBackendParseJsonlLifecycleEvent,
  CliBackendParsedJsonlLifecycleEvent,
} from "../plugins/cli-backend.types.js";
import type { CliCompactionDelta } from "./cli-output-contracts.js";

export function parseCliBackendLifecycleLine(params: {
  line: string;
  backendId: string;
  backend: CliBackendConfig;
  parse?: CliBackendParseJsonlLifecycleEvent;
}): { events: readonly CliBackendParsedJsonlLifecycleEvent[] } | { errorText: string } | undefined {
  if (!params.parse) {
    return undefined;
  }
  try {
    const parsed = params.parse(params.line, {
      backendId: params.backendId,
      backend: params.backend,
    });
    if (parsed == null) {
      return undefined;
    }
    return { events: "kind" in parsed ? [parsed] : parsed };
  } catch (error) {
    return {
      errorText: truncateUtf16Safe(
        `CLI backend ${params.backendId} JSONL lifecycle parser failed: ${formatErrorMessage(error)}`,
        500,
      ),
    };
  }
}

export function projectCliBackendLifecycleEvent(
  event: CliBackendParsedJsonlLifecycleEvent,
): CliCompactionDelta {
  return event.phase === "start"
    ? { phase: "start" }
    : { phase: "end", completed: event.completed };
}
