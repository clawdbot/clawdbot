// Screen-recording payload helpers for node media commands.
import * as path from "node:path";
import { writeBase64ToFile } from "./nodes-camera.js";
import { asRecord, asString, resolveTempPathParts } from "./nodes-media-utils.js";

/** Validated payload returned by `nodes screen record` RPC calls. */
export type ScreenRecordPayload = {
  format: string;
  base64: string;
  durationMs?: number;
  fps?: number;
  screenIndex?: number;
  hasAudio?: boolean;
};

/** Validate and normalize an unknown screen-record payload. */
export function parseScreenRecordPayload(value: unknown): ScreenRecordPayload {
  const obj = asRecord(value);
  const format = asString(obj.format);
  const base64 = asString(obj.base64);
  if (!format || !base64) {
    throw new Error("invalid screen.record payload");
  }
  return {
    format,
    base64,
    durationMs: typeof obj.durationMs === "number" ? obj.durationMs : undefined,
    fps: typeof obj.fps === "number" ? obj.fps : undefined,
    screenIndex: typeof obj.screenIndex === "number" ? obj.screenIndex : undefined,
    hasAudio: typeof obj.hasAudio === "boolean" ? obj.hasAudio : undefined,
  };
}

/** Build the temp output path for a screen recording artifact. */
export function screenRecordTempPath(opts: { ext: string; tmpDir?: string; id?: string }) {
  const { tmpDir, id, ext } = resolveTempPathParts(opts);
  return path.join(tmpDir, `openclaw-screen-record-${id}${ext}`);
}

/** Decode and write a screen recording payload to disk. */
export async function writeScreenRecordToFile(
  filePath: string,
  base64: string,
  opts?: { maxBytes?: number },
) {
  return writeBase64ToFile(filePath, base64, opts);
}

/** Validated payload returned by `nodes screen snapshot` RPC calls. */
export type ScreenSnapshotPayload = {
  format: string;
  base64: string;
  /** Node-issued token binding this image to one physical display geometry. */
  displayFrameId?: string;
  screenIndex?: number;
  width?: number;
  height?: number;
};

/** Validate and normalize an unknown screen-snapshot payload. */
export function parseScreenSnapshotPayload(value: unknown): ScreenSnapshotPayload {
  const obj = asRecord(value);
  const format = asString(obj.format);
  const base64 = asString(obj.base64);
  if (!format || !base64) {
    throw new Error("invalid screen.snapshot payload");
  }
  return {
    format,
    base64,
    displayFrameId: asString(obj.displayFrameId) || undefined,
    screenIndex: typeof obj.screenIndex === "number" ? obj.screenIndex : undefined,
    width: typeof obj.width === "number" ? obj.width : undefined,
    height: typeof obj.height === "number" ? obj.height : undefined,
  };
}

/** Build the temp output path for a screen snapshot artifact. */
export function screenSnapshotTempPath(opts: { ext?: string; tmpDir?: string; id?: string }) {
  const { tmpDir, id, ext } = resolveTempPathParts({ ...opts, ext: opts.ext ?? ".png" });
  return path.join(tmpDir, `openclaw-screen-snapshot-${id}${ext}`);
}

/** Decode and write a screen snapshot payload to disk. */
export async function writeScreenSnapshotToFile(
  filePath: string,
  base64: string,
  opts?: { maxBytes?: number },
) {
  return writeBase64ToFile(filePath, base64, opts);
}
