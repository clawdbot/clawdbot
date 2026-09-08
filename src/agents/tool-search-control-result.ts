import {
  truncateSanitizedExternalContent,
  wrapExternalContent,
} from "../security/external-content.js";

/** Shared by budget fitting and delivery so formatting cannot consume unreserved context. */
export function serializeToolSearchControlResult(payload: unknown, compact = false): string {
  return JSON.stringify(payload, null, compact ? undefined : 2);
}

/** Shared by the source projector and final formatter; no terminal receipts are consumed here. */
export function renderToolSearchControlText(text: string, networkContent: boolean) {
  if (!networkContent) {
    return { text, truncated: false };
  }
  const bounded = truncateSanitizedExternalContent(text, 20_000);
  const modelText = bounded.truncated
    ? `${truncateSanitizedExternalContent(text, 19_988).text}\n[truncated]`
    : bounded.text;
  return { text: wrapExternalContent(modelText, { source: "api" }), truncated: bounded.truncated };
}
