// Media utility adapters for node CLI commands and temporary media outputs.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { extnameFromAnyPath } from "@openclaw/media-core/file-name";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
export { asFiniteNumber as asNumber } from "../../packages/normalization-core/src/number-coercion.js";
import { readStringValue } from "../../packages/normalization-core/src/string-coerce.js";
export { asRecord } from "../../packages/normalization-core/src/record-coerce.js";
export { asBoolean } from "../utils/boolean.js";

export const asString = readStringValue;

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
 * Returns `filePath` carrying the extension that matches `format`.
 *
 * Callers choose an output path before the node reports how it encoded the
 * media, so the requested name can disagree with the bytes. Everything that
 * dispatches on extension — viewers, uploads, content-type headers, channel
 * attachment handling — mislabels the artifact when that happens. An
 * unrecognizable format leaves the caller's path untouched.
 */
export function withMediaFileExtension(filePath: string, format: string): string {
  const desired = normalizeMediaExtension(format);
  if (!desired) {
    return filePath;
  }
  const current = extnameFromAnyPath(filePath);
  if (normalizeMediaExtension(current) === desired) {
    return filePath;
  }
  return `${filePath.slice(0, filePath.length - current.length)}${desired}`;
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
