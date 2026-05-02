import * as path from "node:path";
import { resolveCliName } from "./cli-name.js";
import { asRecord, asString, resolveTempPathParts } from "./nodes-media-utils.js";

type CanvasSnapshotPayload = {
  format: string;
  base64: string;
};

export function parseCanvasSnapshotPayload(value: unknown): CanvasSnapshotPayload {
  const obj = asRecord(value);
  const format = asString(obj.format);
  const base64 = asString(obj.base64);
  if (!format || !base64) {
    throw new Error("invalid canvas.snapshot payload");
  }
  return { format, base64 };
}

export function canvasSnapshotTempPath(opts: { ext: string; tmpDir?: string; id?: string }) {
  const { tmpDir, id, ext } = resolveTempPathParts(opts);
  const cliName = resolveCliName();
  return path.join(tmpDir, `${cliName}-canvas-snapshot-${id}${ext}`);
}
