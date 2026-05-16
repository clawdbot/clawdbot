import { randomUUID } from "node:crypto";
import fs from "node:fs";
import * as path from "node:path";
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

export function normalizeCanvasSnapshotFileExtension(value: string): CanvasSnapshotFileExtension {
  const format = normalizeCanvasSnapshotFormat(value.startsWith(".") ? value.slice(1) : value);
  if (!format) {
    throw new Error("invalid canvas.snapshot format");
  }
  return format === "jpeg" ? "jpg" : format;
}

export function parseCanvasSnapshotPayload(value: unknown): CanvasSnapshotPayload {
  const obj = asRecord(value);
  const format = normalizeCanvasSnapshotFormat(readStringValue(obj.format));
  const base64 = readStringValue(obj.base64);
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

export function canvasSnapshotTempPath(opts: { ext: string; tmpDir?: string; id?: string }) {
  const { tmpDir, id, ext } = resolveTempPathParts(opts);
  const cliName = resolveCliName();
  return path.join(tmpDir, `${cliName}-canvas-snapshot-${id}${ext}`);
}
