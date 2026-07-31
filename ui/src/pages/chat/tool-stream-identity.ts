import { asNullableRecord as asToolRecord } from "@openclaw/normalization-core/record-coerce";
import {
  isToolCallContentType,
  isToolResultContentType,
  resolveToolUseId,
} from "../../../../src/chat/tool-content.js";
import { normalizeRoleForGrouping } from "../../lib/chat/message-normalizer.ts";
import { normalizeOptionalString } from "../../lib/string-coerce.ts";

type ToolMessageRef = {
  id: string;
  runId?: string;
};

type LiveToolStreamRef = ToolMessageRef & {
  identity: string;
};

type LiveToolStreamHost = {
  chatStream?: string | null;
  chatStreamStartedAt?: number | null;
  toolStreamById?: Map<string, unknown>;
  toolStreamOrder?: unknown[];
};

const TOOL_NAME_FIELDS = ["toolName", "tool_name"] as const;

/** Tool call ids belong to one run; sibling runs may legitimately reuse them. */
export function buildToolStreamIdentity(runId: string, toolCallId: string): string {
  return JSON.stringify([runId, toolCallId]);
}

function addToolMessageRef(
  refs: ToolMessageRef[],
  seen: Set<string>,
  id: string | undefined,
  runId?: string,
) {
  if (!id) {
    return;
  }
  const identity = runId ? buildToolStreamIdentity(runId, id) : id;
  if (seen.has(identity)) {
    return;
  }
  seen.add(identity);
  refs.push({ id, ...(runId ? { runId } : {}) });
}

function isToolMessageContentBlock(block: Record<string, unknown>): boolean {
  return isToolCallContentType(block.type) || isToolResultContentType(block.type);
}

/** Reads provider-shaped transcript ids without inventing a missing run owner. */
export function extractToolMessageRefs(message: unknown): ToolMessageRef[] {
  const record = asToolRecord(message);
  if (!record) {
    return [];
  }

  const refs: ToolMessageRef[] = [];
  const seen = new Set<string>();
  const blocks = Array.isArray(record.content)
    ? record.content.filter(
        (block): block is Record<string, unknown> => Boolean(block) && typeof block === "object",
      )
    : [];
  const topLevelToolId = resolveToolUseId(record);
  const topLevelRunId = normalizeOptionalString(record.runId);
  const role = record.role;
  const messageHasToolShape =
    (typeof role === "string" && normalizeRoleForGrouping(role).toLowerCase() === "tool") ||
    TOOL_NAME_FIELDS.some((field) => Boolean(normalizeOptionalString(record[field]))) ||
    blocks.some(isToolMessageContentBlock);

  if (messageHasToolShape) {
    addToolMessageRef(refs, seen, topLevelToolId, topLevelRunId);
  }

  for (const block of blocks) {
    if (!isToolMessageContentBlock(block)) {
      continue;
    }
    addToolMessageRef(
      refs,
      seen,
      resolveToolUseId(block) ?? topLevelToolId,
      normalizeOptionalString(block.runId) ?? topLevelRunId,
    );
  }

  return refs;
}

/** Resolves canonical live entries while preserving existing bare-id fixtures. */
export function resolveLiveToolStreamRefs(state: LiveToolStreamHost): LiveToolStreamRef[] {
  if (!Array.isArray(state.toolStreamOrder)) {
    return [];
  }
  return state.toolStreamOrder
    .filter(
      (identity): identity is string => typeof identity === "string" && Boolean(identity.trim()),
    )
    .map((identity) => {
      const entry = asToolRecord(state.toolStreamById?.get(identity));
      const message = asToolRecord(entry?.message);
      const id =
        normalizeOptionalString(entry?.toolCallId) ??
        (message ? resolveToolUseId(message) : undefined) ??
        identity;
      const runId =
        normalizeOptionalString(entry?.runId) ?? normalizeOptionalString(message?.runId);
      return runId ? { identity, id, runId } : { identity, id };
    });
}

/** Unscoped history cannot prove which sibling owns a reused tool call id. */
export function resolveMatchingLiveToolIdentity(
  ref: ToolMessageRef,
  liveToolRefs: LiveToolStreamRef[],
): string | undefined {
  const matches = liveToolRefs.filter(
    (liveRef) =>
      liveRef.id === ref.id && (!ref.runId || !liveRef.runId || liveRef.runId === ref.runId),
  );
  return matches.length === 1 ? matches[0]?.identity : undefined;
}
