/**
 * Marker for a `before_prompt_build` contribution the runtime produced (or was
 * about to produce) and then dropped.
 *
 * A dropped contribution leaves no hole in the prompt: the plugin's block is
 * simply absent, which reads identically to the plugin having nothing to say.
 * An agent whose work queue arrives through `before_prompt_build` therefore
 * cannot distinguish "no ready work" from "the ready-work block was lost", and
 * silently does nothing. Every host-side drop path injects this marker instead
 * so the loss is visible in the prompt itself (openclaw-beads-201).
 *
 * The marker crosses the model/provider boundary, so it carries bounded
 * structured provenance ONLY: a fixed reason code per drop plus a capped,
 * charset-restricted plugin list. Error text never enters it — diagnostics stay
 * in the operator log (`handleHookError` in hooks.ts and each call site's
 * `log.warn`), which is where credentials, endpoints, or hostile handler output
 * can be read safely.
 */
import type { PluginHookBeforePromptBuildResult } from "./types.js";

/**
 * Model-visible drop reasons. These strings are rendered verbatim into the
 * prompt, so the union is the whole vocabulary the marker can ever emit.
 */
type PromptBuildDropReason =
  /** Re-entrancy guard skipped the whole hook chain for a nested prompt build. */
  | "nested-prompt-build"
  /** One handler threw or exceeded the modifying-hook timeout. */
  | "handler-failed"
  /** The hook dispatch itself rejected, so no handler result survived. */
  | "dispatch-failed";

export type PromptBuildDrop = {
  /** Plugin whose contribution was lost, when the drop can be attributed. */
  pluginId?: string;
  reason: PromptBuildDropReason;
};

// Hard caps required by AGENTS.md's model-context budget rule: every injected
// context item is bounded, and new model-visible text that can cross ~1K tokens
// is a review blocker. Five entries name enough plugins to act on; the byte cap
// holds the WHOLE marker (fixed frame included) near 160 tokens and is the
// binding limit when plugin ids are long. Whatever either cap excludes is still
// counted by the "+N more" summary, so the marker can never understate the loss
// it is reporting.
const MAX_LISTED_DROPS = 5;
const MAX_MARKER_BYTES = 640;
const MAX_PLUGIN_ID_CHARS = 64;
const UNKNOWN_PLUGIN = "unknown plugin";

const MARKER_OPEN = `<dropped_plugin_context hook="before_prompt_build">`;
const MARKER_CLOSE = `</dropped_plugin_context>`;
const MARKER_GUIDANCE =
  `That context is MISSING from this prompt, not empty — do not read its absence as "nothing to report"` +
  ` (for example, an empty task or work queue). Re-read anything you need from its source before acting.`;

const encoder = new TextEncoder();

const markerByteLength = (text: string): number => encoder.encode(text).length;

/**
 * Plugin ids are plugin-authored text landing on a model-visible line, so keep
 * them to an identifier charset: an id carrying markup or instructions must not
 * be able to break the marker's frame or address the model itself.
 */
function safePluginId(pluginId: string | undefined): string {
  const trimmed = pluginId?.trim();
  if (!trimmed) {
    return UNKNOWN_PLUGIN;
  }
  const safe = trimmed.slice(0, MAX_PLUGIN_ID_CHARS).replace(/[^A-Za-z0-9._@/-]/gu, "?");
  return safe || UNKNOWN_PLUGIN;
}

function formatDrop(drop: PromptBuildDrop): string {
  return `${safePluginId(drop.pluginId)} (${drop.reason})`;
}

function joinEntries(listed: readonly string[], omitted: number): string {
  const list = listed.join(", ");
  return omitted > 0 ? `${list}, +${omitted} more` : list;
}

function renderMarker(list: string): string {
  return [
    MARKER_OPEN,
    `The runtime dropped this turn's before_prompt_build contribution from ${list}.`,
    MARKER_GUIDANCE,
    MARKER_CLOSE,
  ].join("\n");
}

/**
 * Renders the marker text, or `undefined` when nothing was dropped. Bounded by
 * both caps above so it cannot distort the prompt it is warning about.
 */
function formatPromptBuildDropMarker(drops: readonly PromptBuildDrop[]): string | undefined {
  if (drops.length === 0) {
    return undefined;
  }
  // Collapse exact raw identities before sanitizing them. Distinct plugin ids
  // can share the same bounded display label, and that collision still counts
  // as a distinct lost contribution in the overflow summary.
  const uniqueDrops: PromptBuildDrop[] = [];
  const seenDrops = new Set<string>();
  for (const drop of drops) {
    const identity = JSON.stringify([drop.pluginId, drop.reason]);
    if (seenDrops.has(identity)) {
      continue;
    }
    seenDrops.add(identity);
    uniqueDrops.push(drop);
  }
  const uniqueEntries: string[] = [];
  const seenEntries = new Set<string>();
  for (const drop of uniqueDrops) {
    const entry = formatDrop(drop);
    if (!seenEntries.has(entry)) {
      seenEntries.add(entry);
      uniqueEntries.push(entry);
    }
  }
  const listed: string[] = [];
  for (const entry of uniqueEntries.slice(0, MAX_LISTED_DROPS)) {
    // Cost the candidate WITH its overflow summary so the byte cap always
    // leaves room for "+N more" instead of silently dropping the count.
    const candidate = renderMarker(
      joinEntries([...listed, entry], uniqueDrops.length - (listed.length + 1)),
    );
    if (listed.length > 0 && markerByteLength(candidate) > MAX_MARKER_BYTES) {
      break;
    }
    listed.push(entry);
  }
  return renderMarker(joinEntries(listed, uniqueDrops.length - listed.length));
}

/**
 * Wraps the marker as a `before_prompt_build` result so it reaches the model
 * through the same append-context slot a live contribution would have used.
 */
export function buildPromptBuildDropResult(
  drops: readonly PromptBuildDrop[],
): PluginHookBeforePromptBuildResult | undefined {
  const marker = formatPromptBuildDropMarker(drops);
  return marker ? { appendContext: marker } : undefined;
}
