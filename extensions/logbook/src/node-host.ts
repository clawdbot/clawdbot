// Logbook node-host command: screen capture for headless node hosts.
// Nodes without the OpenClaw app (plain `openclaw node host run`) advertise
// logbook.snapshot so capture works when the plugin is enabled.
// macOS uses screencapture+sips; Linux uses ffmpeg x11grab (X11/XWayland) or grim.
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { runExec } from "openclaw/plugin-sdk/process-runtime";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";

type LogbookSnapshotParams = {
  screenIndex?: number;
  maxWidth?: number;
  quality?: number;
};

type LogbookSnapshotPayload = { format: "jpeg"; base64: string } | { error: string };

const LOGBOOK_SNAPSHOT_EXEC_TIMEOUT_MS = 25_000;

function readParams(value: unknown): LogbookSnapshotParams {
  if (!value || typeof value !== "object") {
    return {};
  }
  const record = value as Record<string, unknown>;
  const num = (key: string) => {
    const candidate = record[key];
    return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined;
  };
  return { screenIndex: num("screenIndex"), maxWidth: num("maxWidth"), quality: num("quality") };
}

function resolveCaptureParams(rawParams: unknown): {
  screenIndex: number;
  maxWidth: number;
  qualityPct: number;
} {
  const params = readParams(rawParams);
  return {
    screenIndex: Math.max(0, Math.round(params.screenIndex ?? 0)),
    maxWidth: params.maxWidth && params.maxWidth >= 480 ? Math.round(params.maxWidth) : 1440,
    qualityPct: Math.min(
      100,
      Math.max(
        10,
        Math.round(
          (params.quality && params.quality > 0 && params.quality <= 1 ? params.quality : 0.6) *
            100,
        ),
      ),
    ),
  };
}

async function prepareCaptureFile(): Promise<string> {
  // The shared helper rejects unsafe temp roots; the private subdirectory
  // keeps captures out of the broader OpenClaw temp namespace.
  const captureDir = path.join(resolvePreferredOpenClawTmpDir(), "logbook");
  await mkdir(captureDir, { recursive: true, mode: 0o700 });
  await chmod(captureDir, 0o700);
  const filePath = path.join(captureDir, `logbook-snapshot-${randomUUID()}.jpg`);
  // Pre-create owner-only so capture tools truncate an existing inode instead
  // of creating a world-readable file if directory mode drifts.
  await writeFile(filePath, "", { mode: 0o600 });
  return filePath;
}

async function captureDarwin(params: {
  screenIndex: number;
  maxWidth: number;
  qualityPct: number;
  filePath: string;
  signal: AbortSignal;
}): Promise<void> {
  // -x: no capture sound; -C: include cursor; -D is 1-based display index.
  await runExec(
    "screencapture",
    ["-x", "-C", "-D", String(params.screenIndex + 1), "-t", "jpg", params.filePath],
    { logOutput: false, signal: params.signal },
  );
  await runExec(
    "sips",
    [
      "--resampleHeightWidthMax",
      String(params.maxWidth),
      "-s",
      "format",
      "jpeg",
      "-s",
      "formatOptions",
      String(params.qualityPct),
      params.filePath,
    ],
    { logOutput: false, signal: params.signal },
  );
}

async function captureLinux(params: {
  screenIndex: number;
  maxWidth: number;
  qualityPct: number;
  filePath: string;
  signal: AbortSignal;
}): Promise<void> {
  const display = process.env.DISPLAY?.trim();
  if (display) {
    // ffmpeg -q:v is 1 (best) .. 31 (worst); map JPEG % roughly into that range.
    const qScale = Math.max(2, Math.min(31, Math.round(31 - (params.qualityPct / 100) * 29)));
    const input = `${display}.${params.screenIndex}`;
    // X11/XWayland path: cua-computer screen.snapshot often advertises on Linux
    // but fails under Cosmic/Wayland GetImage; ffmpeg x11grab is the reliable
    // fallback Logbook uses for frame capture on those hosts.
    await runExec(
      "ffmpeg",
      [
        "-y",
        "-loglevel",
        "error",
        "-f",
        "x11grab",
        "-i",
        input,
        "-frames:v",
        "1",
        "-vf",
        `scale='min(${params.maxWidth}\\,iw)':-2`,
        "-q:v",
        String(qScale),
        "-update",
        "1",
        params.filePath,
      ],
      { logOutput: false, signal: params.signal },
    );
    return;
  }
  if (process.env.WAYLAND_DISPLAY?.trim()) {
    // grim writes JPEG when -t jpeg; -q is 0-100.
    await runExec("grim", ["-t", "jpeg", "-q", String(params.qualityPct), params.filePath], {
      logOutput: false,
      signal: params.signal,
    });
    return;
  }
  throw new Error(
    "logbook.snapshot on linux needs DISPLAY (X11/XWayland) or WAYLAND_DISPLAY+grim in the node host environment",
  );
}

export async function handleLogbookSnapshot(rawParams: unknown): Promise<LogbookSnapshotPayload> {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    return { error: `logbook.snapshot is not supported on ${process.platform}` };
  }
  const capture = resolveCaptureParams(rawParams);
  const filePath = await prepareCaptureFile();
  try {
    // node.invoke stops waiting after 30 seconds but cannot reap node-host children.
    // Share an earlier deadline so capture + resize terminate before that outer boundary.
    const execSignal = AbortSignal.timeout(LOGBOOK_SNAPSHOT_EXEC_TIMEOUT_MS);
    if (process.platform === "darwin") {
      await captureDarwin({ ...capture, filePath, signal: execSignal });
    } else {
      await captureLinux({ ...capture, filePath, signal: execSignal });
    }
    const buffer = await readFile(filePath);
    if (buffer.byteLength === 0) {
      return { error: "logbook.snapshot captured an empty image" };
    }
    return { format: "jpeg", base64: buffer.toString("base64") };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  } finally {
    await rm(filePath, { force: true });
  }
}
