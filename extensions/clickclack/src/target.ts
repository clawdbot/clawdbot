/**
 * Parser and formatter for ClickClack outbound target strings.
 */
import type { ClickClackTarget } from "./types.js";

/**
 * Parses `channel:name`, `thread:msg_id`, `dm:usr_id`, or a bare channel name.
 */
export function parseClickClackTarget(raw: string): ClickClackTarget {
  const value = raw.trim();
  if (!value) {
    throw new Error("ClickClack target is required");
  }
  const [prefix, ...rest] = value.split(":");
  const body = rest.join(":").trim();
  if (prefix === "channel" && body) {
    return { chatType: "group", kind: "channel", id: body };
  }
  if (prefix === "thread" && body) {
    return { chatType: "group", kind: "thread", id: body };
  }
  if (prefix === "dm" && body) {
    return { chatType: "direct", kind: "dm", id: body };
  }
  if (!body) {
    return { chatType: "group", kind: "channel", id: value };
  }
  throw new Error(`Unsupported ClickClack target: ${raw}`);
}

/** Formats a parsed ClickClack target back into canonical target syntax. */
export function buildClickClackTarget(target: ClickClackTarget): string {
  return `${target.kind}:${target.id}`;
}

/** Normalizes user-entered ClickClack target text for channel routing. */
export function normalizeClickClackTarget(raw: string): string {
  return buildClickClackTarget(parseClickClackTarget(raw));
}

/** Reports whether a target string can be offered to the ClickClack parser. */
export function looksLikeClickClackTarget(raw: string): boolean {
  return /^(channel|thread|dm):/i.test(raw.trim()) || raw.trim().length > 0;
}
