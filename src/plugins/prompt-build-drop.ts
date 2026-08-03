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
 */
import type { PluginHookBeforePromptBuildResult } from "./types.js";

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
  /** Short error text (first line only) when there is one. */
  detail?: string;
};

const REASON_LABELS: Record<PromptBuildDropReason, string> = {
  "nested-prompt-build": "skipped for a nested prompt build",
  "handler-failed": "handler failed or timed out",
  "dispatch-failed": "hook dispatch failed",
};

const MAX_DETAIL_CHARS = 120;

function formatDrop(drop: PromptBuildDrop): string {
  const who = drop.pluginId ?? "unknown plugin";
  const detail = drop.detail?.trim().replace(/\s+/gu, " ");
  const suffix = detail ? `: ${detail.slice(0, MAX_DETAIL_CHARS)}` : "";
  return `${who} (${REASON_LABELS[drop.reason]}${suffix})`;
}

/**
 * Renders the marker text, or `undefined` when nothing was dropped. Kept to a
 * couple of sentences so it cannot distort the prompt it is warning about.
 */
function formatPromptBuildDropMarker(drops: readonly PromptBuildDrop[]): string | undefined {
  if (drops.length === 0) {
    return undefined;
  }
  return [
    `<dropped_plugin_context hook="before_prompt_build">`,
    `The runtime dropped this turn's before_prompt_build contribution from ${drops.map(formatDrop).join(", ")}.`,
    `That context is MISSING from this prompt, not empty — do not read its absence as "nothing to report"` +
      ` (for example, an empty task or work queue). Re-read anything you need from its source before acting.`,
    `</dropped_plugin_context>`,
  ].join("\n");
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
