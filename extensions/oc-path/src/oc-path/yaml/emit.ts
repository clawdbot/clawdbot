import { OcEmitSentinelError, REDACTED_SENTINEL } from "../sentinel.js";
import type { YamlAst } from "./ast.js";

export interface YamlEmitOptions {
  readonly mode?: "roundtrip" | "render";
  readonly fileNameForGuard?: string;
  readonly acceptPreExistingSentinel?: boolean;
}

export function emitYaml(ast: YamlAst, opts: YamlEmitOptions = {}): string {
  const mode = opts.mode ?? "roundtrip";
  const guardPath = opts.fileNameForGuard ? `oc://${opts.fileNameForGuard}` : "oc://";
  const acceptPreExisting = opts.acceptPreExistingSentinel ?? true;

  if (mode === "roundtrip") {
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
