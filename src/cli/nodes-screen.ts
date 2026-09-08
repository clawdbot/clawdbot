// Screen-recording payload helpers for node media commands.
import * as path from "node:path";
import { extnameFromAnyPath } from "@openclaw/media-core/file-name";
import { asRecord, readStringValue, resolveTempPathParts } from "./nodes-media-utils.js";

export {
  writeBase64ToFile as writeScreenRecordToFile,
  writeBase64ToFile as writeScreenSnapshotToFile,
} from "./nodes-camera.js";

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
  const format = readStringValue(obj.format);
  const base64 = readStringValue(obj.base64);
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

/**
 * Maps a caller-chosen snapshot path to the encoding the node should produce.
 *
 * `screen.snapshot` lets the node pick its encoding, so asking for the one the
 * filename already promises is what keeps the name and the bytes in agreement.
 * Returns undefined when the path claims nothing recognizable and the node's
 * own default should stand.
 */
export function screenSnapshotFormatForPath(filePath: string): "png" | "jpeg" | undefined {
  const ext = extnameFromAnyPath(filePath).toLowerCase();
  if (ext === ".png") {
    return "png";
  }
  return ext === ".jpg" || ext === ".jpeg" ? "jpeg" : undefined;
}

/** Build the temp output path for a screen snapshot artifact. */
export function screenSnapshotTempPath(opts: { ext: string; tmpDir?: string; id?: string }) {
  // No default extension: the node chooses the encoding, and assuming PNG here
  // is how a JPEG snapshot ends up named `.png`.
  const { tmpDir, id, ext } = resolveTempPathParts(opts);
  return path.join(tmpDir, `openclaw-screen-snapshot-${id}${ext}`);
}
