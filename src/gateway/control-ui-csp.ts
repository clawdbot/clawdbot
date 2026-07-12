// Control UI content-security-policy helpers.
// Computes inline script hashes and builds the Gateway-served CSP header.
import { createHash } from "node:crypto";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

const SCRIPT_ATTRIBUTE_NAME_RE = /\s([^\s=/>]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/g;

/**
 * Compute SHA-256 CSP hashes for inline `<script>` blocks in an HTML string.
 * Only scripts without a `src` attribute are considered inline.
 */
export function computeInlineScriptHashes(html: string): string[] {
  const hashes: string[] = [];
  const re = /<script(?:\s[^>]*)?>([^]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const openTag = match[0].slice(0, match[0].indexOf(">") + 1);
    if (hasScriptSrcAttribute(openTag)) {
      continue;
    }
    const content = match[1];
    if (!content) {
      continue;
    }
    const hash = createHash("sha256").update(content, "utf8").digest("base64");
    hashes.push(`sha256-${hash}`);
  }
  return hashes;
}

function hasScriptSrcAttribute(openTag: string): boolean {
  return Array.from(openTag.matchAll(SCRIPT_ATTRIBUTE_NAME_RE)).some(
    (match) => normalizeLowercaseStringOrEmpty(match[1]) === "src",
  );
}

/** Build the CSP header applied to Gateway-served Control UI HTML. */
export function buildControlUiCspHeader(opts?: {
  inlineScriptHashes?: string[];
  /**
   * Relax the policy just enough for the embedded terminal's ghostty-web engine:
   * `'wasm-unsafe-eval'` permits WebAssembly compilation and `data:` in
   * connect-src lets it fetch its inlined WASM binary. Gated on the terminal
   * being enabled so the baseline Control UI CSP stays tight otherwise.
   */
  allowWasm?: boolean;
}): string {
  const hashes = opts?.inlineScriptHashes;
  const scriptTokens = ["'self'"];
  if (hashes?.length) {
    scriptTokens.push(...hashes.map((h) => `'${h}'`));
  }
  if (opts?.allowWasm) {
    scriptTokens.push("'wasm-unsafe-eval'");
  }
  const connectTokens = ["'self'", "ws:", "wss:", "https://api.openai.com", "https://tweakcn.com"];
  if (opts?.allowWasm) {
    connectTokens.push("data:");
  }
  return [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    // Gateway selection can move to a remote dedicated MCP Apps origin after
    // this document loads. The component still validates the exact endpoint.
    "frame-src 'self' http: https:",
    `script-src ${scriptTokens.join(" ")}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "font-src 'self' https://fonts.gstatic.com",
    "worker-src 'self'",
    `connect-src ${connectTokens.join(" ")}`,
  ].join("; ");
}
