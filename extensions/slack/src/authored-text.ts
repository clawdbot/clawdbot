// Slack-private authored text placement after block compilation.
import type { LegacyInteractiveReply } from "openclaw/plugin-sdk/interactive-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

export type SlackAuthoredTextPlacement = "none" | "blocks" | "outside-blocks";

function normalizeComparableSlackText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function isSlackAuthoredTextRepresentedInInteractive(
  text: string,
  interactive?: LegacyInteractiveReply,
): boolean {
  return isSlackAuthoredTextRepresentedInFragments(
    text,
    interactive?.blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])) ?? [],
  );
}

function isSlackAuthoredTextRepresentedInFragments(
  text: string,
  rawFragments: readonly string[],
): boolean {
  const target = normalizeComparableSlackText(text);
  const fragments = rawFragments.map(normalizeComparableSlackText).filter(Boolean);
  // Legacy inline controls split surrounding text into multiple interactive text blocks.
  for (let start = 0; start < fragments.length; start += 1) {
    let combined = "";
    for (let end = start; end < fragments.length; end += 1) {
      combined = normalizeComparableSlackText(`${combined} ${fragments[end]}`);
      if (combined === target) {
        return true;
      }
      if (combined.length > target.length) {
        break;
      }
    }
  }
  return false;
}

/** Resolve placement from producer facts, before accessibility text changes the payload text. */
export function resolveSlackAuthoredTextPlacement(params: {
  text?: string;
  interactive?: LegacyInteractiveReply;
  renderedInBlocks?: boolean;
  renderedTextFragments?: readonly string[];
}): SlackAuthoredTextPlacement {
  const text = normalizeOptionalString(params.text);
  if (!text) {
    return "none";
  }
  const isRepresentedInBlocks =
    params.renderedInBlocks ||
    isSlackAuthoredTextRepresentedInFragments(text, params.renderedTextFragments ?? []) ||
    isSlackAuthoredTextRepresentedInInteractive(text, params.interactive);
  return isRepresentedInBlocks ? "blocks" : "outside-blocks";
}
