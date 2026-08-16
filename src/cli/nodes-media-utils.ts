// Media utility adapters for node CLI commands and temporary media outputs.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { extnameFromAnyPath } from "@openclaw/media-core/file-name";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
export { asFiniteNumber as asNumber } from "@openclaw/normalization-core/number-coercion";
export { asRecord } from "@openclaw/normalization-core/record-coerce";
export { readStringValue } from "@openclaw/normalization-core/string-coerce";
export { asBoolean } from "../utils/boolean.js";

function normalizeMediaExtension(value: string): string | undefined {
  const raw = (value.startsWith(".") ? value.slice(1) : value).toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,15}$/u.test(raw)) {
    return undefined;
  }
  // `jpeg` and `jpg` name one encoding; collapse them so a caller-supplied
  // `.jpeg` is not rewritten to `.jpg` for no reason.
  return raw === "jpeg" ? ".jpg" : `.${raw}`;
}

/**
 * True when `filePath` does not contradict media encoded as `format`.
 *
 * Callers choose an output path before the node reports how it encoded the
 * media, so the name can end up describing bytes it never received. Everything
 * that dispatches on extension — viewers, uploads, content-type headers,
 * channel attachment handling — is misled when that happens. A path with no
 * extension claims nothing and is therefore accepted.
 *
 * This only compares; it never rewrites the path. Output paths reach the media
 * writers already workspace-guarded, and that guard alias-checks the exact
 * final segment, so swapping the extension afterwards would write to a name
 * nothing validated.
 */
export function mediaPathMatchesFormat(filePath: string, format: string): boolean {
  const current = extnameFromAnyPath(filePath);
  if (!current) {
    return true;
  }
  const desired = normalizeMediaExtension(format);
  return !desired || normalizeMediaExtension(current) === desired;
}

export function resolveTempPathParts(opts: { ext: string; tmpDir?: string; id?: string }): {
  ext: string;
  tmpDir: string;
  id: string;
} {
  // Restrict extensions before writing temp media paths derived from CLI/user input.
  const tmpDir = opts.tmpDir ?? resolvePreferredOpenClawTmpDir();
  const rawExt = opts.ext.startsWith(".") ? opts.ext : `.${opts.ext}`;
  if (!/^\.[A-Za-z0-9][A-Za-z0-9_-]{0,15}$/u.test(rawExt)) {
    throw new Error("invalid media format");
  }
  if (!opts.tmpDir) {
    fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
  }
  return {
    tmpDir,
    id: opts.id ?? randomUUID(),
    ext: rawExt,
  };
}
