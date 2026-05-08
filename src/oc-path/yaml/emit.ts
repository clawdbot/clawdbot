/**
 * Emit a `YamlAst` to bytes.
 *
 * **Round-trip mode (default)** returns `ast.raw` verbatim — preserves
 * comments, anchors, formatting exactly.
 *
 * **Render mode** uses `doc.toString()` from the `yaml` package — also
 * comment-preserving, but normalizes whitespace per the package's
 * options.
 *
 * **Sentinel guard**: scans every emitted byte sequence for the
 * `__OPENCLAW_REDACTED__` literal.
 *
 * @module @openclaw/oc-path/yaml/emit
 */

import { OcEmitSentinelError, REDACTED_SENTINEL } from '../sentinel.js';
import type { YamlAst } from './ast.js';

export interface YamlEmitOptions {
  readonly mode?: 'roundtrip' | 'render';
  readonly fileNameForGuard?: string;
  /**
   * See `JsoncEmitOptions.acceptPreExistingSentinel` for the rationale.
   * Default `true` — round-trip echoes parsed bytes without scanning.
   * Render mode always scans the rendered output (callers can inject
   * sentinels via setYamlOcPath, so render-time scan is mandatory).
   */
  readonly acceptPreExistingSentinel?: boolean;
}

export function emitYaml(ast: YamlAst, opts: YamlEmitOptions = {}): string {
  const mode = opts.mode ?? 'roundtrip';
  const guardPath = opts.fileNameForGuard ? `oc://${opts.fileNameForGuard}` : 'oc://';
  const acceptPreExisting = opts.acceptPreExistingSentinel ?? true;

  if (mode === 'roundtrip') {
    if (!acceptPreExisting && ast.raw.includes(REDACTED_SENTINEL)) {
      throw new OcEmitSentinelError(`${guardPath}/[raw]`);
    }
    return ast.raw;
  }

  const rendered = ast.doc.toString();
  if (rendered.includes(REDACTED_SENTINEL)) {
    throw new OcEmitSentinelError(`${guardPath}/[rendered]`);
  }
  return rendered;
}
