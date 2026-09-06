/**
 * Nodes media action executor.
 *
 * Captures camera/photos/screen media from paired nodes and formats media-safe tool results.
 */
import crypto from "node:crypto";
import { extnameFromAnyPath } from "@openclaw/media-core/file-name";
import { imageMimeFromFormat } from "@openclaw/media-core/mime";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import {
  type CameraArtifactFacing,
  cameraTempPath,
  parseCameraClipPayload,
  parseCameraSnapPayload,
  resolveCameraClipTarget,
  resolveCameraSnapTargets,
  writeCameraClipPayloadToFile,
  writeCameraPayloadToFile,
} from "../../cli/nodes-camera.js";
import { mediaPathMatchesFormat } from "../../cli/nodes-media-utils.js";
import {
  parseScreenRecordPayload,
  screenRecordTempPath,
  screenSnapshotFormatForPath,
  screenSnapshotTempPath,
  writeScreenRecordToFile,
  writeScreenSnapshotToFile,
} from "../../cli/nodes-screen.js";
import { parseDurationMs } from "../../cli/parse-duration.js";
import { parseScreenSnapshotResult } from "../../plugins/computer-use-contract.js";
import type { ImageSanitizationLimits } from "../image-sanitization.js";
import type { AgentToolResult } from "../runtime/index.js";
import { sanitizeToolResultImages } from "../tool-images.js";
import {
  readFiniteNumberParam,
  readNonNegativeIntegerParam,
  readPositiveIntegerParam,
} from "./common.js";
import type { GatewayCallOptions } from "./gateway.js";
import { callNodesToolNodeInvoke } from "./nodes-tool-invoke.js";
import { resolveAgentNode, resolveAgentNodeId } from "./nodes-utils.js";

export const MEDIA_INVOKE_ACTIONS = {
  "camera.snap": "camera_snap",
  "camera.clip": "camera_clip",
  "photos.latest": "photos_latest",
  "screen.record": "screen_record",
  "screen.snapshot": "screen_snapshot",
  // file-transfer commands: redirect to dedicated tools for better result
  // formatting and media-store handling. The gateway still enforces the
  // underlying node-invoke path policy for raw callers.
  "file.fetch": "file_fetch",
  "dir.list": "dir_list",
  "dir.fetch": "dir_fetch",
  "file.write": "file_write",
} as const;

// Subset of MEDIA_INVOKE_ACTIONS where the dedicated tool is the preferred
// agent UX. Gateway node-invoke policy still protects raw node.invoke callers.
export const POLICY_REDIRECT_INVOKE_COMMANDS: ReadonlySet<string> = new Set([
  "file.fetch",
  "dir.list",
  "dir.fetch",
  "file.write",
]);

type NodeMediaAction =
  | "camera_snap"
  | "photos_latest"
  | "camera_clip"
  | "screen_record"
  | "screen_snapshot";
const MAX_RECORDING_DURATION_MS = 300_000;
const RECORDING_INVOKE_GRACE_MS = 30_000;
const RECORDING_TRANSPORT_GRACE_MS = 30_000;

type ExecuteNodeMediaActionParams = {
  action: NodeMediaAction;
  params: Record<string, unknown>;
  gatewayOpts: GatewayCallOptions;
  modelHasVision?: boolean;
  imageSanitization: ImageSanitizationLimits;
};

function resolveRecordingTimeouts(params: {
  input: Record<string, unknown>;
  gatewayOpts: GatewayCallOptions;
  durationMs: number;
}): { gatewayOpts: GatewayCallOptions; invokeTimeoutMs: number } {
  const invokeTimeoutMs =
    readPositiveIntegerParam(params.input, "invokeTimeoutMs") ??
    params.durationMs + RECORDING_INVOKE_GRACE_MS;
  // The Gateway transport starts before the forwarded node timer and must outlive it.
  // Keep explicit transport and invoke overrides independent so callers can cancel either layer.
  const transportTimeoutMs =
    params.gatewayOpts.timeoutMs ?? invokeTimeoutMs + RECORDING_TRANSPORT_GRACE_MS;
  return {
    gatewayOpts: { ...params.gatewayOpts, timeoutMs: transportTimeoutMs },
    invokeTimeoutMs,
  };
}

export async function executeNodeMediaAction(
  input: ExecuteNodeMediaActionParams,
): Promise<AgentToolResult<unknown>> {
  switch (input.action) {
    case "camera_snap":
      return await executeCameraSnap(input);
    case "photos_latest":
      return await executePhotosLatest(input);
    case "camera_clip":
      return await executeCameraClip(input);
    case "screen_record":
      return await executeScreenRecord(input);
    case "screen_snapshot":
      return await executeScreenSnapshot(input);
  }
  throw new Error("Unsupported node media action");
}

function validateNodePhoto(
  photo: ReturnType<typeof parseCameraSnapPayload>,
  command: "camera.snap" | "photos.latest",
) {
  const format = normalizeLowercaseStringOrEmpty(photo.format);
  if (format !== "jpg" && format !== "jpeg" && format !== "png") {
    throw new Error(`unsupported ${command} format: ${photo.format}`);
  }
  return { photo, isJpeg: format !== "png" };
}

type ValidatedNodePhoto = ReturnType<typeof validateNodePhoto> & {
  facing?: CameraArtifactFacing;
  createdAt?: unknown;
};

async function createNodePhotoResult(params: {
  kind: "snaps" | "photos";
  photos: ValidatedNodePhoto[];
  expectedHost?: string;
  modelHasVision?: boolean;
  imageSanitization: ImageSanitizationLimits;
}): Promise<AgentToolResult<unknown>> {
  const command = params.kind === "snaps" ? "camera.snap" : "photos.latest";
  const content: AgentToolResult<unknown>["content"] = [];
  const details: Array<Record<string, unknown> & { path: string }> = [];
  for (const [index, { photo, facing, createdAt, isJpeg }] of params.photos.entries()) {
    const filePath = cameraTempPath({
      kind: "snap",
      ...(facing ? { facing } : { id: crypto.randomUUID() }),
      ext: isJpeg ? "jpg" : "png",
    });
    await writeCameraPayloadToFile({
      filePath,
      payload: photo,
      expectedHost: params.expectedHost,
      invalidPayloadMessage: `invalid ${command} payload`,
    });
    content.push(
      params.modelHasVision && photo.base64
        ? {
            type: "image",
            data: photo.base64,
            mimeType: imageMimeFromFormat(photo.format) ?? (isJpeg ? "image/jpeg" : "image/png"),
          }
        : {
            type: "text",
            text: `${facing ? "Camera" : "Library"} photo saved to ${filePath}.`,
          },
    );
    details.push({
      ...(facing ? { facing } : { index }),
      path: filePath,
      width: photo.width,
      height: photo.height,
      ...(typeof createdAt === "string" ? { createdAt } : {}),
    });
  }
  if (details.length === 0) {
    content.push({ type: "text", text: "No photos found." });
  }
  const mediaUrls = details.map((entry) => entry.path);
  return await sanitizeToolResultImages(
    {
      content,
      details: details.length > 0 ? { [params.kind]: details, media: { mediaUrls } } : [],
    },
    params.kind === "snaps" ? "nodes:camera_snap" : "nodes:photos_latest",
    params.imageSanitization,
  );
}

async function executeCameraSnap({
  params,
  gatewayOpts,
  modelHasVision,
  imageSanitization,
}: ExecuteNodeMediaActionParams): Promise<AgentToolResult<unknown>> {
  const node = requireString(params, "node");
  const resolvedNode = await resolveAgentNode(gatewayOpts, node);
  const nodeId = resolvedNode.nodeId;
  const facingRaw = normalizeLowercaseStringOrEmpty(params.facing) || "front";
  const facing =
    facingRaw === "both" || facingRaw === "front" || facingRaw === "back"
      ? facingRaw
      : (() => {
          throw new Error("invalid facing (front|back|both)");
        })();
  const maxWidth = readPositiveIntegerParam(params, "maxWidth") ?? 1600;
  const quality =
    readFiniteNumberParam(params, "quality", {
      min: 0,
      max: 1,
      message: "quality must be between 0 and 1",
    }) ?? 0.95;
  const delayMs = readNonNegativeIntegerParam(params, "delayMs");
  const deviceId =
    typeof params.deviceId === "string" && params.deviceId.trim()
      ? params.deviceId.trim()
      : undefined;
  if (deviceId && facing === "both" && resolvedNode.platform?.toLowerCase() !== "linux") {
    throw new Error("facing=both is not allowed when deviceId is set");
  }
  const targets = resolveCameraSnapTargets({
    facing,
    platform: resolvedNode.platform,
    deviceId,
  });

  const photos: ValidatedNodePhoto[] = [];
  for (const target of targets) {
    const raw = await callNodesToolNodeInvoke<{ payload: unknown }>(gatewayOpts, {
      nodeId,
      command: "camera.snap",
      params: {
        facing: target.requestFacing,
        maxWidth,
        quality,
        format: "jpg",
        delayMs,
        deviceId,
      },
      idempotencyKey: crypto.randomUUID(),
    });
    const photo = parseCameraSnapPayload(raw?.payload, { expectedHost: resolvedNode.remoteIp });
    photos.push({
      ...validateNodePhoto(photo, "camera.snap"),
      facing: target.artifactFacing,
    });
  }
  return await createNodePhotoResult({
    kind: "snaps",
    photos,
    expectedHost: resolvedNode.remoteIp,
    modelHasVision,
    imageSanitization,
  });
}

async function executePhotosLatest({
  params,
  gatewayOpts,
  modelHasVision,
  imageSanitization,
}: ExecuteNodeMediaActionParams): Promise<AgentToolResult<unknown>> {
  const node = requireString(params, "node");
  const resolvedNode = await resolveAgentNode(gatewayOpts, node);
  const nodeId = resolvedNode.nodeId;
  const limit = Math.min(
    readPositiveIntegerParam(params, "limit") ?? DEFAULT_PHOTOS_LIMIT,
    MAX_PHOTOS_LIMIT,
  );
  const maxWidth = readPositiveIntegerParam(params, "maxWidth") ?? DEFAULT_PHOTOS_MAX_WIDTH;
  const quality =
    readFiniteNumberParam(params, "quality", {
      min: 0,
      max: 1,
      message: "quality must be between 0 and 1",
    }) ?? DEFAULT_PHOTOS_QUALITY;
  const raw = await callNodesToolNodeInvoke<{ payload: unknown }>(gatewayOpts, {
    nodeId,
    command: "photos.latest",
    params: {
      limit,
      maxWidth,
      quality,
    },
    idempotencyKey: crypto.randomUUID(),
  });
  const payload = raw?.payload;
  if (!isRecord(payload) || !Array.isArray(payload.photos)) {
    throw new Error("invalid photos.latest payload");
  }
  if (payload.photos.length > limit) {
    throw new Error(
      `photos.latest returned ${payload.photos.length} photos; requested at most ${limit}`,
    );
  }

  // Validate the complete native batch before the shared owner writes private artifacts.
  const photos = payload.photos.map((photoRaw) => {
    const photo = parseCameraSnapPayload(photoRaw, { expectedHost: resolvedNode.remoteIp });
    return Object.assign(validateNodePhoto(photo, "photos.latest"), {
      createdAt: isRecord(photoRaw) ? photoRaw.createdAt : undefined,
    });
  });
  return await createNodePhotoResult({
    kind: "photos",
    photos,
    expectedHost: resolvedNode.remoteIp,
    modelHasVision,
    imageSanitization,
  });
}

async function executeCameraClip({
  params,
  gatewayOpts,
}: ExecuteNodeMediaActionParams): Promise<AgentToolResult<unknown>> {
  const node = requireString(params, "node");
  const resolvedNode = await resolveAgentNode(gatewayOpts, node);
  const nodeId = resolvedNode.nodeId;
  const facing = normalizeLowercaseStringOrEmpty(params.facing) || "front";
  if (facing !== "front" && facing !== "back") {
    throw new Error("invalid facing (front|back)");
  }
  const target = resolveCameraClipTarget({ facing, platform: resolvedNode.platform });
  const durationMs = Math.min(
    readPositiveIntegerParam(params, "durationMs") ??
      (typeof params.duration === "string" ? parseDurationMs(params.duration) : 3000),
    MAX_RECORDING_DURATION_MS,
  );
  const includeAudio = typeof params.includeAudio === "boolean" ? params.includeAudio : true;
  const deviceId =
    typeof params.deviceId === "string" && params.deviceId.trim()
      ? params.deviceId.trim()
      : undefined;
  const timeouts = resolveRecordingTimeouts({ input: params, gatewayOpts, durationMs });
  const raw = await callNodesToolNodeInvoke<{ payload: unknown }>(timeouts.gatewayOpts, {
    nodeId,
    command: "camera.clip",
    params: {
      facing: target.requestFacing,
      durationMs,
      includeAudio,
      format: "mp4",
      deviceId,
    },
    timeoutMs: timeouts.invokeTimeoutMs,
    idempotencyKey: crypto.randomUUID(),
  });
  const payload = parseCameraClipPayload(raw?.payload);
  const filePath = await writeCameraClipPayloadToFile({
    payload,
    facing: target.artifactFacing,
    expectedHost: resolvedNode.remoteIp,
  });
  return {
    content: [{ type: "text", text: `FILE:${filePath}` }],
    details: {
      facing: target.artifactFacing,
      path: filePath,
      durationMs: payload.durationMs,
      hasAudio: payload.hasAudio,
    },
  };
}

async function executeScreenRecord({
  params,
  gatewayOpts,
}: ExecuteNodeMediaActionParams): Promise<AgentToolResult<unknown>> {
  const node = requireString(params, "node");
  const nodeId = await resolveAgentNodeId(gatewayOpts, node);
  const durationMs = Math.min(
    readPositiveIntegerParam(params, "durationMs") ??
      (typeof params.duration === "string" ? parseDurationMs(params.duration) : 10_000),
    MAX_RECORDING_DURATION_MS,
  );
  const fps =
    readFiniteNumberParam(params, "fps", {
      min: 0,
      minExclusive: true,
      message: "fps must be greater than 0",
    }) ?? 10;
  const screenIndex = readNonNegativeIntegerParam(params, "screenIndex") ?? 0;
  const includeAudio = typeof params.includeAudio === "boolean" ? params.includeAudio : true;
  const timeouts = resolveRecordingTimeouts({ input: params, gatewayOpts, durationMs });
  const raw = await callNodesToolNodeInvoke<{ payload: unknown }>(timeouts.gatewayOpts, {
    nodeId,
    command: "screen.record",
    params: {
      durationMs,
      screenIndex,
      fps,
      format: "mp4",
      includeAudio,
    },
    timeoutMs: timeouts.invokeTimeoutMs,
    idempotencyKey: crypto.randomUUID(),
  });
  const payload = parseScreenRecordPayload(raw?.payload);
  const ext = payload.format || "mp4";
  const outPath = normalizeOptionalString(params.outPath);
  assertMediaOutPathFormat({ command: "screen.record", outPath, format: ext });
  const filePath = outPath ?? screenRecordTempPath({ ext });
  const written = await writeScreenRecordToFile(filePath, payload.base64);
  return {
    content: [{ type: "text", text: `FILE:${written.path}` }],
    details: {
      path: written.path,
      durationMs: payload.durationMs,
      fps: payload.fps,
      screenIndex: payload.screenIndex,
      hasAudio: payload.hasAudio,
    },
  };
}

async function executeScreenSnapshot({
  params,
  gatewayOpts,
}: ExecuteNodeMediaActionParams): Promise<AgentToolResult<unknown>> {
  const node = requireString(params, "node");
  const nodeId = await resolveAgentNodeId(gatewayOpts, node);
  const screenIndex = readNonNegativeIntegerParam(params, "screenIndex") ?? 0;
  const maxWidth = readPositiveIntegerParam(params, "maxWidth");
  const outPath = normalizeOptionalString(params.outPath);
  // The node owns the encoding choice, so ask for the one the caller's filename
  // already promises instead of letting the default contradict it.
  const requestedFormat = outPath ? screenSnapshotFormatForPath(outPath) : undefined;
  const raw = await callNodesToolNodeInvoke<{ payload: unknown }>(gatewayOpts, {
    nodeId,
    command: "screen.snapshot",
    params: { screenIndex, maxWidth, format: requestedFormat },
    idempotencyKey: crypto.randomUUID(),
  });
  const payload = parseScreenSnapshotResult(raw?.payload);
  const ext = payload.format === "png" ? "png" : "jpg";
  assertMediaOutPathFormat({ command: "screen.snapshot", outPath, format: ext });
  const filePath = outPath ?? screenSnapshotTempPath({ ext });
  const written = await writeScreenSnapshotToFile(filePath, payload.base64);
  return {
    content: [{ type: "text", text: `FILE:${written.path}` }],
    details: {
      path: written.path,
      format: payload.format,
      displayFrameId: payload.displayFrameId,
      screenIndex: payload.screenIndex,
      width: payload.width,
      height: payload.height,
      media: {
        mediaUrl: written.path,
      },
    },
  };
}

/**
 * Refuses to write media whose bytes contradict the caller's filename.
 *
 * `outPath` is workspace-guarded before this tool runs and that guard
 * alias-checks the exact final segment, so the extension cannot be corrected
 * here; the caller has to name the artifact for what it is.
 */
function assertMediaOutPathFormat(params: {
  command: string;
  outPath?: string;
  format: string;
}): void {
  if (!params.outPath || mediaPathMatchesFormat(params.outPath, params.format)) {
    return;
  }
  throw new Error(
    `${params.command} returned ${params.format}; outPath must use a matching extension (got ${extnameFromAnyPath(params.outPath)})`,
  );
}

function requireString(params: Record<string, unknown>, key: string): string {
  const raw = params[key];
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new Error(`${key} required`);
  }
  return raw.trim();
}

const DEFAULT_PHOTOS_LIMIT = 1;
const MAX_PHOTOS_LIMIT = 20;
const DEFAULT_PHOTOS_MAX_WIDTH = 1600;
const DEFAULT_PHOTOS_QUALITY = 0.85;
