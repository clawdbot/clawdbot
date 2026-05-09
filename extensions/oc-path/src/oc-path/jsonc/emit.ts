/**
 * Emit a `JsoncAst` to bytes.
 *
 * Round-trip (default) echoes `ast.raw` verbatim — preserves comments
 * and formatting. Sentinel guard fires only in render mode by default;
 * round-trip trusts parsed bytes so a workspace file legitimately
 * containing the sentinel literal isn't a global emit DoS. Callers
 * that need pre-existing detection opt in via
 * `acceptPreExistingSentinel: false`.
 *
 * @module @openclaw/oc-path/jsonc/emit
 */

import { OcEmitSentinelError, REDACTED_SENTINEL } from "../sentinel.js";
import type { JsoncAst, JsoncValue } from "./ast.js";

export interface JsoncEmitOptions {
  readonly mode?: "roundtrip" | "render";
  readonly fileNameForGuard?: string;
  readonly acceptPreExistingSentinel?: boolean;
}

export function emitJsonc(ast: JsoncAst, opts: JsoncEmitOptions = {}): string {
  const mode = opts.mode ?? "roundtrip";
  const guardPath = opts.fileNameForGuard ? `oc://${opts.fileNameForGuard}` : "oc://";
  const acceptPreExisting = opts.acceptPreExistingSentinel ?? true;

  if (mode === "roundtrip") {
    if (!acceptPreExisting && ast.raw.includes(REDACTED_SENTINEL)) {
      throw new OcEmitSentinelError(`${guardPath}/[raw]`);
    }
    return ast.raw;
  }

  // Render mode loses comments; walks leaves for caller-injected sentinel.
  if (ast.root === null) {return "";}
  return renderValue(ast.root, guardPath, []);
}

function renderValue(value: JsoncValue, guardPath: string, walked: readonly string[]): string {
  switch (value.kind) {
    case "object": {
      const parts = value.entries.map(
        (e) => `${JSON.stringify(e.key)}: ${renderValue(e.value, guardPath, [...walked, e.key])}`,
      );
      return `{ ${parts.join(", ")} }`;
    }
    case "array": {
      const parts = value.items.map((v, i) => renderValue(v, guardPath, [...walked, String(i)]));
      return `[ ${parts.join(", ")} ]`;
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
