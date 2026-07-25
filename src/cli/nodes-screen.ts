// Screen-recording payload helpers for node media commands.
import * as path from "node:path";
import { writeBase64ToFile } from "./nodes-camera.js";
import { asRecord, asString, resolveTempPathParts } from "./nodes-media-utils.js";

/** Validated payload returned by `nodes screen record` RPC calls. */
type ScreenRecordPayload = {
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
export type ScreenSnapshotScreenInfo = {
  index: number;
  width: number;
  height: number;
  main: boolean;
};

type ScreenSnapshotPayload = {
  format: string;
  base64: string;
  /** Node-issued token binding this image to one physical display geometry. */
  displayFrameId?: string;
  screenIndex?: number;
  width?: number;
  height?: number;
  /** Logical display size in points (CGEvent space); may exceed image pixels. */
  displayWidth?: number;
  displayHeight?: number;
  /** All displays in screenIndex order when the node reports multi-monitor inventory. */
  screens?: ScreenSnapshotScreenInfo[];
};

function parseScreenSnapshotScreens(value: unknown): ScreenSnapshotScreenInfo[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  const screens: ScreenSnapshotScreenInfo[] = [];
  for (const entry of value) {
    const obj = asRecord(entry);
    if (
      typeof obj.index !== "number" ||
      !Number.isInteger(obj.index) ||
      obj.index < 0 ||
      typeof obj.width !== "number" ||
      !Number.isFinite(obj.width) ||
      obj.width <= 0 ||
      typeof obj.height !== "number" ||
      !Number.isFinite(obj.height) ||
      obj.height <= 0 ||
      typeof obj.main !== "boolean"
    ) {
      continue;
    }
    screens.push({
      index: obj.index,
      width: Math.floor(obj.width),
      height: Math.floor(obj.height),
      main: obj.main,
    });
  }
  return screens.length > 0 ? screens : undefined;
}

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
    displayWidth: typeof obj.displayWidth === "number" ? obj.displayWidth : undefined,
    displayHeight: typeof obj.displayHeight === "number" ? obj.displayHeight : undefined,
    screens: parseScreenSnapshotScreens(obj.screens),
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
