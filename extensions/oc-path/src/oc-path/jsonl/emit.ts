/**
 * Emit a `JsonlAst` to bytes. Round-trip echoes `ast.raw`; render mode
 * rebuilds from line entries (preserves blank/malformed lines verbatim).
 *
 * @module @openclaw/oc-path/jsonl/emit
 */

import { renderJsoncValue } from "../jsonc/emit.js";
import { OcEmitSentinelError, REDACTED_SENTINEL } from "../sentinel.js";
import type { JsonlAst } from "./ast.js";

interface JsonlEmitOptions {
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
    out.push(renderJsoncValue(ln.value, `${guardPath}/L${ln.line}`, ""));
  }
  // Preserve line-ending convention; otherwise CRLF input edited via
  // setJsonlOcPath would emit mixed endings (silent corruption on Windows).
  return out.join(ast.lineEnding ?? "\n");
}
