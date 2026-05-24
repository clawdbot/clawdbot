import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { readStringValue } from "../shared/string-coerce.js";
export { asRecord } from "../shared/record-coerce.js";

export const asString = readStringValue;

export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function resolveTempPathParts(opts: { ext: string; tmpDir?: string; id?: string }): {
  ext: string;
  tmpDir: string;
  id: string;
} {
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
