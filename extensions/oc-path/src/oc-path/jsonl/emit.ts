/**
 * Emit a `JsonlAst` to bytes. Round-trip echoes `ast.raw`; render mode
 * rebuilds from line entries (preserves blank/malformed lines verbatim).
 *
 * @module @openclaw/oc-path/jsonl/emit
 */

import type { JsoncValue } from "../jsonc/ast.js";
import { OcEmitSentinelError, REDACTED_SENTINEL } from "../sentinel.js";
import type { JsonlAst } from "./ast.js";

export interface JsonlEmitOptions {
  readonly mode?: "roundtrip" | "render";
  readonly fileNameForGuard?: string;
  readonly acceptPreExistingSentinel?: boolean;
}

export function emitJsonl(ast: JsonlAst, opts: JsonlEmitOptions = {}): string {
  const mode = opts.mode ?? "roundtrip";
  const guardPath = opts.fileNameForGuard ? `oc://${opts.fileNameForGuard}` : "oc://";
  const acceptPreExisting = opts.acceptPreExistingSentinel ?? true;

  if (mode === "roundtrip") {
    if (!acceptPreExisting && ast.raw.includes(REDACTED_SENTINEL)) {
      throw new OcEmitSentinelError(`${guardPath}/[raw]`);
    }
    return ast.raw;
  }

  const out: string[] = [];
  for (const ln of ast.lines) {
    if (ln.kind === "blank" || ln.kind === "malformed") {
      if (!acceptPreExisting && ln.raw.includes(REDACTED_SENTINEL)) {
        throw new OcEmitSentinelError(`${guardPath}/L${ln.line}`);
      }
      out.push(ln.raw);
      continue;
    }
    // Value lines always scan leaves so caller-injected sentinel is rejected.
    out.push(renderValue(ln.value, `${guardPath}/L${ln.line}`, []));
  }
  // Preserve line-ending convention; otherwise CRLF input edited via
  // setJsonlOcPath would emit mixed endings (silent corruption on Windows).
  return out.join(ast.lineEnding ?? "\n");
}

function renderValue(value: JsoncValue, guardPath: string, walked: readonly string[]): string {
  switch (value.kind) {
    case "object": {
      const parts = value.entries.map(
        (e) => `${JSON.stringify(e.key)}:${renderValue(e.value, guardPath, [...walked, e.key])}`,
      );
      return `{${parts.join(",")}}`;
    }
    case "array": {
      const parts = value.items.map((v, i) => renderValue(v, guardPath, [...walked, String(i)]));
      return `[${parts.join(",")}]`;
    }
    case "string":
      // Substring match: embedded sentinel leaks marker bytes too.
      if (value.value.includes(REDACTED_SENTINEL)) {
        throw new OcEmitSentinelError(`${guardPath}/${walked.join("/")}`);
      }
      return JSON.stringify(value.value);
    case "number":
      return String(value.value);
    case "boolean":
      return String(value.value);
    case "null":
      return "null";
  }
  return "";
}
