import fs from "node:fs/promises";
import path from "node:path";
import type {
  OpenClawPluginNodeHostCommand,
  OpenClawPluginNodeHostCommandAvailabilityContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { runCommandWithTimeout } from "openclaw/plugin-sdk/process-runtime";
import { resolvePreferredOpenClawTmpDir, withTempWorkspace } from "openclaw/plugin-sdk/temp-path";
import {
  assertToolResult,
  clamp,
  isCapabilityEnabledForHost,
  parseParams,
  readFiniteNumber,
  type RunCommand,
} from "./command-utils.js";
import type { ResolvedLinuxNodePluginConfig } from "./config.js";
import { resolveExecutable, type ExecutableResolver } from "./executables.js";
import { createLinuxLocationCommand } from "./location.js";

const MAX_GATEWAY_PAYLOAD_BYTES = 25 * 1024 * 1024;
// The base64 field sits inside payloadJSON and the node.invoke response frame.
const MAX_GATEWAY_ENVELOPE_BYTES = 64 * 1024;
const MAX_BASE64_BYTES = MAX_GATEWAY_PAYLOAD_BYTES - MAX_GATEWAY_ENVELOPE_BYTES;
const MAX_MEDIA_RAW_BYTES = Math.floor(MAX_BASE64_BYTES / 4) * 3;

type VideoDevice = {
  id: string;
  name: string;
  position: "unknown";
  deviceType: "v4l2";
};

type LinuxNodeCommandDeps = {
  config: ResolvedLinuxNodePluginConfig;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  resolveExecutable?: ExecutableResolver;
  runCommand?: RunCommand;
  listVideoDevices?: () => Promise<VideoDevice[]>;
  readFile?: (filePath: string) => Promise<Buffer>;
  statFile?: (filePath: string) => Promise<{ size: number }>;
  withTempFile?: <T>(suffix: string, run: (filePath: string) => Promise<T>) => Promise<T>;
  now?: () => Date;
};

function encodeMedia(buffer: Buffer): string {
  if (buffer.byteLength > MAX_MEDIA_RAW_BYTES) {
    throw new Error("PAYLOAD_TOO_LARGE: camera payload exceeds the 25 MB base64 limit");
  }
  const base64 = buffer.toString("base64");
  if (Buffer.byteLength(base64, "ascii") > MAX_BASE64_BYTES) {
    throw new Error("PAYLOAD_TOO_LARGE: camera payload exceeds the 25 MB base64 limit");
  }
  return base64;
}

function readJpegDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.byteLength < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return null;
  }
  let offset = 2;
  while (offset + 9 < buffer.byteLength) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    if (marker === undefined) {
      return null;
    }
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) {
      return null;
    }
    const segmentLength = buffer.readUInt16BE(offset + 2);
    const isStartOfFrame =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isStartOfFrame && segmentLength >= 7) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
      };
    }
    if (segmentLength < 2) {
      return null;
    }
    offset += segmentLength + 2;
  }
  return null;
}

async function listLinuxVideoDevices(params: {
  ffmpeg: string;
  runCommand: RunCommand;
  listEntries?: () => Promise<string[]>;
  readDeviceName?: (entry: string) => Promise<string>;
}): Promise<VideoDevice[]> {
  const entries = await (params.listEntries ?? (() => fs.readdir("/dev")))().catch(() => []);
  const deviceNames = entries
    .filter((entry) => /^video\d+$/u.test(entry))
    .toSorted((left, right) => left.localeCompare(right, "en", { numeric: true }));
  const devices: VideoDevice[] = [];
  for (const entry of deviceNames) {
    const id = path.join("/dev", entry);
    const probe = await params.runCommand(
      [params.ffmpeg, "-hide_banner", "-f", "v4l2", "-list_formats", "all", "-i", id],
      {
        timeoutMs: 5000,
        maxOutputBytes: { stdout: 4096, stderr: 64 * 1024 },
        outputCapture: "tail",
      },
    );
    // FFmpeg intentionally exits after listing formats. Format rows prove the
    // node supports video capture; the process exit code does not.
    if (!/\b(?:Raw|Compressed)\s*:/u.test(`${probe.stdout}\n${probe.stderr}`)) {
      continue;
    }
    const name = await (
      params.readDeviceName ??
      (async (deviceEntry) =>
        await fs.readFile(path.join("/sys/class/video4linux", deviceEntry, "name"), "utf8"))
    )(entry)
      .then((value) => value.trim())
      .catch(() => entry);
    devices.push({ id, name, position: "unknown", deviceType: "v4l2" });
  }
  return devices;
}

async function defaultWithTempFile<T>(
  suffix: string,
  run: (filePath: string) => Promise<T>,
): Promise<T> {
  return await withTempWorkspace(
    { rootDir: resolvePreferredOpenClawTmpDir(), prefix: "openclaw-linux-node-" },
    async ({ dir }) => await run(path.join(dir, `capture${suffix}`)),
  );
}

export function createLinuxNodeCommands(
  deps: LinuxNodeCommandDeps,
): OpenClawPluginNodeHostCommand[] {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const findExecutable = deps.resolveExecutable ?? resolveExecutable;
  const runCommand = deps.runCommand ?? runCommandWithTimeout;
  const readFile = deps.readFile ?? fs.readFile;
  const statFile = deps.statFile ?? fs.stat;
  const withTempFile = deps.withTempFile ?? defaultWithTempFile;
  const now = deps.now ?? (() => new Date());

  const findTool = (name: "ffmpeg" | "notify-send", candidateEnv = env) =>
    findExecutable(name, candidateEnv);
  const listVideoDevices =
    deps.listVideoDevices ??
    (async () => {
      const ffmpeg = findTool("ffmpeg");
      return ffmpeg ? await listLinuxVideoDevices({ ffmpeg, runCommand }) : [];
    });
  const readMedia = async (filePath: string) => {
    if ((await statFile(filePath)).size > MAX_MEDIA_RAW_BYTES) {
      throw new Error("PAYLOAD_TOO_LARGE: camera payload exceeds the 25 MB base64 limit");
    }
    return await readFile(filePath);
  };
  const assertLinuxCapability = (capability: keyof ResolvedLinuxNodePluginConfig, code: string) => {
    if (platform !== "linux") {
      throw new Error(`${code}: Linux node host required`);
    }
    if (!deps.config[capability].enabled) {
      throw new Error(
        `${code}: enable plugins.entries.linux-node.config.${capability}.enabled and restart the node service`,
      );
    }
  };
  const isAvailable =
    (capability: keyof ResolvedLinuxNodePluginConfig, tool: "ffmpeg" | "notify-send") =>
    (context: OpenClawPluginNodeHostCommandAvailabilityContext) =>
      platform === "linux" &&
      isCapabilityEnabledForHost(context, capability) &&
      findTool(tool, context.env) !== null;
  const resolveTool = (
    capability: keyof ResolvedLinuxNodePluginConfig,
    tool: "ffmpeg" | "notify-send",
    disabledCode: string,
    unavailableCode: string,
  ) => {
    assertLinuxCapability(capability, disabledCode);
    const executable = findTool(tool);
    if (!executable) {
      throw new Error(`${unavailableCode}: ${tool} not found`);
    }
    return executable;
  };
  const selectVideoDevice = async (deviceId: unknown) => {
    const devices = await listVideoDevices();
    if (typeof deviceId === "string" && deviceId.trim()) {
      const match = devices.find((device) => device.id === deviceId.trim());
      if (!match) {
        throw new Error(`INVALID_REQUEST: camera device not found: ${deviceId.trim()}`);
      }
      return match;
    }
    const device = devices[0];
    if (!device) {
      throw new Error("CAMERA_UNAVAILABLE: no V4L2 camera devices found");
    }
    return device;
  };

  return [
    {
      command: "system.notify",
      isAvailable: isAvailable("notify", "notify-send"),
      handle: async (paramsJSON) => {
        const notifySend = resolveTool(
          "notify",
          "notify-send",
          "NOTIFICATIONS_DISABLED",
          "NOTIFICATIONS_UNAVAILABLE",
        );
        const params = parseParams(paramsJSON);
        const title = typeof params.title === "string" ? params.title.trim() : "";
        const body = typeof params.body === "string" ? params.body.trim() : "";
        if (!title && !body) {
          throw new Error("INVALID_REQUEST: empty notification");
        }
        const urgency =
          params.priority === "passive"
            ? "low"
            : params.priority === "timeSensitive"
              ? "critical"
              : "normal";
        const result = await runCommand([notifySend, "--urgency", urgency, "--", title, body], {
          timeoutMs: 10_000,
        });
        assertToolResult(result, "NOTIFICATIONS_UNAVAILABLE");
        return JSON.stringify({ ok: true });
      },
    },
    {
      command: "camera.list",
      cap: "camera",
      isAvailable: isAvailable("camera", "ffmpeg"),
      handle: async () => {
        resolveTool("camera", "ffmpeg", "CAMERA_DISABLED", "CAMERA_UNAVAILABLE");
        return JSON.stringify({ devices: await listVideoDevices() });
      },
    },
    {
      command: "camera.snap",
      cap: "camera",
      dangerous: true,
      isAvailable: isAvailable("camera", "ffmpeg"),
      handle: async (paramsJSON) => {
        const ffmpeg = resolveTool("camera", "ffmpeg", "CAMERA_DISABLED", "CAMERA_UNAVAILABLE");
        const params = parseParams(paramsJSON);
        const format = typeof params.format === "string" ? params.format.toLowerCase() : "jpg";
        if (format !== "jpg" && format !== "jpeg") {
          throw new Error(`INVALID_REQUEST: unsupported camera image format: ${format}`);
        }
        const device = await selectVideoDevice(params.deviceId);
        const maxWidthRaw = readFiniteNumber(params.maxWidth);
        // Honor small downscale requests, but floor to 2 so the proportional `-2`
        // height in the scale filter never rounds to a non-positive dimension.
        const maxWidth =
          maxWidthRaw && maxWidthRaw > 0 ? Math.max(2, Math.floor(maxWidthRaw)) : 1600;
        const quality = clamp(readFiniteNumber(params.quality) ?? 0.9, 0.05, 1);
        const delayMs = clamp(Math.floor(readFiniteNumber(params.delayMs) ?? 2000), 0, 10_000);
        const ffmpegQuality = Math.round(31 - quality * 29);
        return await withTempFile(".jpg", async (outputPath) => {
          const result = await runCommand(
            [
              ffmpeg,
              "-hide_banner",
              "-loglevel",
              "error",
              "-y",
              "-f",
              "v4l2",
              "-i",
              device.id,
              "-ss",
              (delayMs / 1000).toFixed(3),
              "-frames:v",
              "1",
              "-vf",
              `scale=min(iw\\,${maxWidth}):-2`,
              "-q:v",
              String(ffmpegQuality),
              outputPath,
            ],
            { timeoutMs: delayMs + 20_000 },
          );
          assertToolResult(result, "CAMERA_UNAVAILABLE");
          const image = await readMedia(outputPath);
          const dimensions = readJpegDimensions(image);
          if (!dimensions) {
            throw new Error("CAMERA_UNAVAILABLE: FFmpeg returned an invalid JPEG");
          }
          return JSON.stringify({
            format,
            base64: encodeMedia(image),
            width: dimensions.width,
            height: dimensions.height,
          });
        });
      },
    },
    {
      command: "camera.clip",
      cap: "camera",
      dangerous: true,
      isAvailable: isAvailable("camera", "ffmpeg"),
      handle: async (paramsJSON) => {
        const ffmpeg = resolveTool("camera", "ffmpeg", "CAMERA_DISABLED", "CAMERA_UNAVAILABLE");
        const params = parseParams(paramsJSON);
        const format = typeof params.format === "string" ? params.format.toLowerCase() : "mp4";
        if (format !== "mp4") {
          throw new Error(`INVALID_REQUEST: unsupported camera clip format: ${format}`);
        }
        const device = await selectVideoDevice(params.deviceId);
        const durationMs = clamp(
          Math.floor(readFiniteNumber(params.durationMs) ?? 3000),
          250,
          60_000,
        );
        const includeAudio = typeof params.includeAudio === "boolean" ? params.includeAudio : true;
        return await withTempFile(".mp4", async (outputPath) => {
          const inputs = ["-f", "v4l2", "-i", device.id];
          if (includeAudio) {
            inputs.push("-f", "pulse", "-i", "default");
          }
          const audioArgs = includeAudio
            ? ["-map", "0:v:0", "-map", "1:a:0", "-c:a", "aac", "-b:a", "128k", "-shortest"]
            : ["-an"];
          const result = await runCommand(
            [
              ffmpeg,
              "-hide_banner",
              "-loglevel",
              "error",
              "-y",
              ...inputs,
              "-t",
              (durationMs / 1000).toFixed(3),
              "-c:v",
              "libx264",
              "-preset",
              "veryfast",
              "-pix_fmt",
              "yuv420p",
              ...audioArgs,
              "-movflags",
              "+faststart",
              outputPath,
            ],
            { timeoutMs: durationMs + 30_000 },
          );
          assertToolResult(result, "CAMERA_UNAVAILABLE");
          const clip = await readMedia(outputPath);
          return JSON.stringify({
            format: "mp4",
            base64: encodeMedia(clip),
            durationMs,
            hasAudio: includeAudio,
          });
        });
      },
    },
    createLinuxLocationCommand({
      config: deps.config,
      platform,
      env,
      resolveExecutable: findExecutable,
      runCommand,
      now,
    }),
  ];
}
