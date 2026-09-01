import type { LegacyInteractiveReply } from "openclaw/plugin-sdk/interactive-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { slackMrkdwnTextBoundary } from "./format.js";

export type SlackAuthoredTextPlacement = "none" | "blocks" | "outside-blocks";

// Project producer plans alike; null barriers retain native content with no mrkdwn equivalent.
function normalizeSlackAuthoredTextFragments(fragments: readonly (string | null)[]) {
  return fragments
    .map((fragment) => fragment?.trim() ?? null)
    .filter((fragment) => fragment !== "");
}

/** Resolve placement from producer facts, before accessibility text changes the payload text. */
export function resolveSlackAuthoredTextPlacement(params: {
  text?: string;
  interactive?: LegacyInteractiveReply;
  renderedInBlocks?: boolean;
  renderedTextFragments?: readonly (string | null)[];
  authoredChunkPlans?: readonly (readonly string[])[];
}): SlackAuthoredTextPlacement {
  const text = normalizeOptionalString(params.text);
  if (!text) {
    return "none";
  }
  if (params.renderedInBlocks) {
    return "blocks";
  }
  // Rendered facts own placement; raw legacy text is only a pre-render metadata source.
  const fragments = normalizeSlackAuthoredTextFragments(
    params.renderedTextFragments ??
      params.interactive?.blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])) ??
      [],
  );
  for (const rawPlan of params.authoredChunkPlans ?? []) {
    const plan = normalizeSlackAuthoredTextFragments(rawPlan);
    if (
      plan.length > 0 &&
      fragments.some((_, start) =>
        plan.every((fragment, index) => fragment === fragments[start + index]),
      )
    ) {
      return "blocks";
    }
  }
  // Legacy inline controls may split authored whitespace at fragment boundaries.
  // Consume only separators outside complete native formatting spans and tokens.
  const isBoundary = slackMrkdwnTextBoundary(text);
  for (let start = 0; start < fragments.length; start += 1) {
    let remaining = text;
    for (const fragment of fragments.slice(start)) {
      if (fragment === null || !remaining.startsWith(fragment)) {
        break;
      }
      remaining = remaining.slice(fragment.length);
      if (!remaining) {
        return "blocks";
      }
      if (!/^\s/u.test(remaining) || !isBoundary(text.length - remaining.length)) {
        break;
      }
      remaining = remaining.trimStart();
    }
  }
  return "outside-blocks";
}
