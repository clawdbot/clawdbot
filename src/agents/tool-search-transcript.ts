import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { transferMcpCodeModeGuestResult } from "./mcp-content.js";
import type { AgentToolResult } from "./runtime/index.js";
import { copyInternalToolResultState } from "./runtime/internal-hooks.js";
import { toToolSearchJsonSafe } from "./tool-search-json.js";

function freezeJsonSnapshot(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  for (const nested of Object.values(value)) {
    freezeJsonSnapshot(nested);
  }
  return Object.freeze(value);
}

/** Capture a stable JSON-safe result before delayed transcript settlement. */
export function snapshotToolSearchTargetTranscriptResult(
  result: AgentToolResult<unknown>,
): AgentToolResult<unknown> {
  const hasDetails = "details" in result;
  const snapshot = toToolSearchJsonSafe(result);
  if (!isRecord(snapshot)) {
    throw new Error("Tool Search target result could not be captured for transcript projection.");
  }
  if (hasDetails && !("details" in snapshot)) {
    // `details` presence selects callValue unwrapping. JSON serialization drops
    // an explicit undefined, so restore that marker before freezing the envelope.
    snapshot.details =
      result.details === undefined ? undefined : toToolSearchJsonSafe(result.details);
  }
  const target = freezeJsonSnapshot(snapshot) as AgentToolResult<unknown>;
  return transferMcpCodeModeGuestResult(result, copyInternalToolResultState(result, target));
}
