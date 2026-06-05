// Control UI chat module implements tool message refs behavior.
import {
  isToolCallContentType,
  isToolResultContentType,
  resolveToolUseId,
} from "../../../../src/chat/tool-content.js";
import { normalizeOptionalString } from "../string-coerce.ts";
import { normalizeRoleForGrouping } from "./role-normalizer.ts";

const TOOL_NAME_FIELDS = ["toolName", "tool_name"] as const;
type ToolNameField = (typeof TOOL_NAME_FIELDS)[number];
type ToolHistoryRecord = Record<string, unknown> & Partial<Record<ToolNameField, unknown>>;

export type ToolMessageRef = {
  id: string;
};

function asRecord(value: unknown): ToolHistoryRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as ToolHistoryRecord)
    : null;
}

function addToolRef(refs: ToolMessageRef[], seen: Set<string>, id: string | undefined) {
  if (!id || seen.has(id)) {
    return;
  }
  seen.add(id);
  refs.push({ id });
}

function isToolLikeRole(role: unknown): boolean {
  return typeof role === "string" && normalizeRoleForGrouping(role).toLowerCase() === "tool";
}

function hasToolName(message: ToolHistoryRecord): boolean {
  return TOOL_NAME_FIELDS.some((field) => Boolean(normalizeOptionalString(message[field])));
}

function toolContentBlocks(message: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(message.content)
    ? message.content.filter(
        (block): block is Record<string, unknown> => Boolean(block) && typeof block === "object",
      )
    : [];
}

function isToolContentBlock(block: Record<string, unknown>): boolean {
  return isToolCallContentType(block.type) || isToolResultContentType(block.type);
}

export function extractToolMessageRefs(message: unknown): ToolMessageRef[] {
  const record = asRecord(message);
  if (!record) {
    return [];
  }

  const refs: ToolMessageRef[] = [];
  const seen = new Set<string>();
  const blocks = toolContentBlocks(record);
  const hasToolBlock = blocks.some(isToolContentBlock);
  const topLevelToolId = resolveToolUseId(record);
  const messageHasToolShape = isToolLikeRole(record.role) || hasToolName(record) || hasToolBlock;

  // Long term, chat.history should expose canonical toolRefs on UI messages so
  // WebChat never infers provider/transcript spellings here. Until then, keep
  // raw compatibility isolated at this tool-message boundary.
  if (messageHasToolShape) {
    addToolRef(refs, seen, topLevelToolId);
  }

  for (const block of blocks) {
    if (!isToolContentBlock(block)) {
      continue;
    }
    addToolRef(refs, seen, resolveToolUseId(block) ?? topLevelToolId);
  }

  return refs;
}
