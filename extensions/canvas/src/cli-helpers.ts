/**
 * Shared Canvas CLI helpers for snapshot payload parsing and temp paths.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import * as path from "node:path";
import { canonicalizeBase64 } from "openclaw/plugin-sdk/media-runtime";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/security-runtime";
import { asRecord, readStringValue } from "openclaw/plugin-sdk/string-coerce-runtime";

type CanvasSnapshotPayload = {
  format: CanvasSnapshotFormat;
  base64: string;
};

type CanvasSnapshotFormat = "png" | "jpg" | "jpeg";
type CanvasSnapshotFileExtension = "png" | "jpg";

function normalizeCanvasSnapshotFormat(value: string | undefined): CanvasSnapshotFormat | null {
  const format = value?.trim().toLowerCase() ?? "";
  if (format === "png" || format === "jpg" || format === "jpeg") {
    return format;
  }
  return null;
}

function canonicalizeCanvasSnapshotBase64(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      code <= 0x20 &&
      code !== 0x09 &&
      code !== 0x0a &&
      code !== 0x0c &&
      code !== 0x0d &&
      code !== 0x20
    ) {
      return undefined;
    }
  }
  const canonical = canonicalizeBase64(value);
  if (!canonical) {
    return undefined;
  }
  return Buffer.from(canonical, "base64").toString("base64") === canonical ? canonical : undefined;
}

/** Normalizes Canvas snapshot output extensions, mapping jpeg to jpg. */
export function normalizeCanvasSnapshotFileExtension(value: string): CanvasSnapshotFileExtension {
  const format = normalizeCanvasSnapshotFormat(value.startsWith(".") ? value.slice(1) : value);
  if (!format) {
    throw new Error("invalid canvas.snapshot format");
  }
  return format === "jpeg" ? "jpg" : format;
}

/** Parses the node.invoke canvas.snapshot payload shape. */
export function parseCanvasSnapshotPayload(value: unknown): CanvasSnapshotPayload {
  const obj = asRecord(value);
  const format = normalizeCanvasSnapshotFormat(readStringValue(obj.format));
  const base64 = canonicalizeCanvasSnapshotBase64(readStringValue(obj.base64));
  if (!format || !base64) {
    throw new Error("invalid canvas.snapshot payload");
  }
  return { format, base64 };
}

function resolveCliName(): string {
  return "openclaw";
}

function resolveCanvasSnapshotId(id: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new Error("invalid canvas snapshot id");
  }
  return id;
}

function resolveTempPathParts(opts: { ext: string; tmpDir?: string; id?: string }) {
  const tmpDir = opts.tmpDir ?? resolvePreferredOpenClawTmpDir();
  if (!opts.tmpDir) {
    fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
  }
  return {
    tmpDir,
    id: resolveCanvasSnapshotId(opts.id ?? randomUUID()),
    ext: `.${normalizeCanvasSnapshotFileExtension(opts.ext)}`,
  };
}

/** Builds a safe temp path for a Canvas snapshot output file. */
export function canvasSnapshotTempPath(opts: { ext: string; tmpDir?: string; id?: string }) {
  const { tmpDir, id, ext } = resolveTempPathParts(opts);
  const cliName = resolveCliName();
  return path.join(tmpDir, `${cliName}-canvas-snapshot-${id}${ext}`);
}
