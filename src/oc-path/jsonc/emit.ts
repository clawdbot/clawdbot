/**
 * Emit a `JsoncAst` to bytes.
 *
 * **Round-trip mode (default)** returns `ast.raw` verbatim — this
 * preserves comments, formatting, and trailing whitespace exactly.
 *
 * **Sentinel-guard policy**:
 *
 * - Round-trip echoes `ast.raw` *without* scanning for the redaction
 *   sentinel. Bytes that came in via `parseJsonc` are trusted: a
 *   workspace file legitimately containing the literal
 *   `__OPENCLAW_REDACTED__` (in a code-block comment, in a pasted
 *   error log, etc.) would otherwise become a workspace-wide emit
 *   DoS — every `openclaw path emit FILE.jsonc` would exit non-zero,
 *   breaking lint round-trip rules, doctor fixers, and LKG
 *   fingerprinting. The substrate's contract is "no NEW sentinel
 *   bytes introduced via emit", not "no sentinel byte ever leaves".
 * - Render mode walks every leaf and rejects sentinel-bearing leaf
 *   values (caller-injected sentinel via `setOcPath` lands here:
 *   `setJsoncOcPath` rebuilds raw via render-mode, so a leaf set to
 *   the sentinel by the caller is caught at the rebuild boundary
 *   before the raw is shipped back).
 *
 * Callers that want pre-existing sentinel detection (e.g., LKG
 * fingerprint verification) can opt in via
 * `acceptPreExistingSentinel: false`.
 *
 * @module @openclaw/oc-path/jsonc/emit
 */

import { OcEmitSentinelError, REDACTED_SENTINEL } from '../sentinel.js';
import type { JsoncAst, JsoncValue } from './ast.js';

export interface JsoncEmitOptions {
  readonly mode?: 'roundtrip' | 'render';
  readonly fileNameForGuard?: string;
  /**
   * When `false`, round-trip mode also scans `ast.raw` for the
   * redaction sentinel and throws `OcEmitSentinelError` if found.
   * Default `true` — round-trip trusts parsed bytes (see policy
   * comment above). Render mode always scans leaves regardless.
   */
  readonly acceptPreExistingSentinel?: boolean;
}

export function emitJsonc(ast: JsoncAst, opts: JsoncEmitOptions = {}): string {
  const mode = opts.mode ?? 'roundtrip';
  const guardPath = opts.fileNameForGuard ? `oc://${opts.fileNameForGuard}` : 'oc://';
  const acceptPreExisting = opts.acceptPreExistingSentinel ?? true;

  if (mode === 'roundtrip') {
    if (!acceptPreExisting && ast.raw.includes(REDACTED_SENTINEL)) {
      throw new OcEmitSentinelError(`${guardPath}/[raw]`);
    }
    return ast.raw;
  }

  // Render mode — synthesize JSON from the structural tree (loses
  // comments). Walk every leaf string for sentinel detection so a
  // caller-injected sentinel via setOcPath is rejected.
  if (ast.root === null) {return '';}
  return renderValue(ast.root, guardPath, []);
}

function renderValue(value: JsoncValue, guardPath: string, walked: readonly string[]): string {
  switch (value.kind) {
    case 'object': {
      const parts = value.entries.map(
        (e) =>
          `${JSON.stringify(e.key)}: ${renderValue(e.value, guardPath, [...walked, e.key])}`,
      );
      return `{ ${parts.join(', ')} }`;
    }
    case 'array': {
      const parts = value.items.map((v, i) =>
        renderValue(v, guardPath, [...walked, String(i)]),
      );
      return `[ ${parts.join(', ')} ]`;
    }
    case 'string': {
      // Reject ANY string that contains the sentinel — embedded
      // (`prefix__OPENCLAW_REDACTED__suffix`) is just as much of a
      // "literal redacted token landed on disk" leak as exact-match.
      // The roundtrip path uses `raw.includes()` for the same reason;
      // render needs the same predicate per leaf.
      if (value.value.includes(REDACTED_SENTINEL)) {
        throw new OcEmitSentinelError(`${guardPath}/${walked.join('/')}`);
      }
      return JSON.stringify(value.value);
    }
    case 'number':
      return String(value.value);
    case 'boolean':
      return String(value.value);
    case 'null':
      return 'null';
  }
  throw new Error(`unreachable: jsonc renderValue kind`);
}
