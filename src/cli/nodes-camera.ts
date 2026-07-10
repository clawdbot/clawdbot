// Camera payload validation and artifact writers for node media commands.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { toErrorObject } from "../infra/errors.js";
import { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
import { normalizeHostname } from "../infra/net/hostname.js";
import { parseStrictNonNegativeInteger } from "../infra/parse-finite-number.js";
import { resolveCliName } from "./cli-name.js";
import {
  asBoolean,
  asNumber,
  asRecord,
  asString,
  resolveTempPathParts,
} from "./nodes-media-utils.js";

const MAX_CAMERA_URL_DOWNLOAD_BYTES = 250 * 1024 * 1024;
const MAX_CAMERA_BASE64_BYTES = MAX_CAMERA_URL_DOWNLOAD_BYTES;
// Keep the 250 MiB media path bounded without applying a short control-request deadline.
const CAMERA_URL_DOWNLOAD_TIMEOUT_MS = 15 * 60_000;

/** Camera orientation accepted by node camera commands. */
export type CameraFacing = "front" | "back";

/** Validated still-image payload from `nodes camera snap`. */
export type CameraSnapPayload = {
  format: string;
  base64?: string;
  url?: string;
  width: number;
  height: number;
};

/** Validated video payload from `nodes camera clip`. */
export type CameraClipPayload = {
  format: string;
  base64?: string;
  url?: string;
  durationMs: number;
  hasAudio: boolean;
};

async function cancelIgnoredResponseBody(response: Response | undefined): Promise<void> {
  if (response?.bodyUsed !== true) {
    await response?.body?.cancel().catch(() => undefined);
  }
}

/** Validate and normalize an unknown camera still-image payload. */
export function parseCameraSnapPayload(value: unknown): CameraSnapPayload {
  const obj = asRecord(value);
  const format = asString(obj.format);
  const base64 = asString(obj.base64);
  const url = asString(obj.url);
  const width = asNumber(obj.width);
  const height = asNumber(obj.height);
  if (!format || (!base64 && !url) || width === undefined || height === undefined) {
    throw new Error("invalid camera.snap payload");
  }
  return { format, ...(base64 ? { base64 } : {}), ...(url ? { url } : {}), width, height };
}

/** Validate and normalize an unknown camera clip payload. */
export function parseCameraClipPayload(value: unknown): CameraClipPayload {
  const obj = asRecord(value);
  const format = asString(obj.format);
  const base64 = asString(obj.base64);
  const url = asString(obj.url);
  const durationMs = asNumber(obj.durationMs);
  const hasAudio = asBoolean(obj.hasAudio);
  if (!format || (!base64 && !url) || durationMs === undefined || hasAudio === undefined) {
    throw new Error("invalid camera.clip payload");
  }
  return { format, ...(base64 ? { base64 } : {}), ...(url ? { url } : {}), durationMs, hasAudio };
}

/** Build a deterministic temp path for a camera artifact. */
export function cameraTempPath(opts: {
  kind: "snap" | "clip";
  facing?: CameraFacing;
  ext: string;
  tmpDir?: string;
  id?: string;
}) {
  const { tmpDir, id, ext } = resolveTempPathParts({
    tmpDir: opts.tmpDir,
    id: opts.id,
    ext: opts.ext,
  });
  const facingPart = opts.facing ? `-${opts.facing}` : "";
  const cliName = resolveCliName();
  return path.join(tmpDir, `${cliName}-camera-${opts.kind}${facingPart}-${id}${ext}`);
}

/** Download a node-hosted media URL to disk after HTTPS, host, redirect, and size checks. */
export async function writeUrlToFile(
  filePath: string,
  url: string,
  opts: { expectedHost: string },
) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") {
    throw new Error(`writeUrlToFile: only https URLs are allowed, got ${parsed.protocol}`);
  }
  const expectedHost = normalizeHostname(opts.expectedHost);
  if (!expectedHost) {
    throw new Error("writeUrlToFile: expectedHost is required");
  }
  if (normalizeHostname(parsed.hostname) !== expectedHost) {
    throw new Error(
      `writeUrlToFile: url host ${parsed.hostname} must match node host ${opts.expectedHost}`,
    );
  }

  // The node host is allowed even when private because the RPC response supplied its remote IP.
  const policy = {
    allowPrivateNetwork: true,
    allowedHostnames: [expectedHost],
    hostnameAllowlist: [expectedHost],
  };

  let release: () => Promise<void> = async () => {};
  let bytes = 0;
  try {
    const guarded = await fetchWithSsrFGuard({
      url,
      auditContext: "writeUrlToFile",
      policy,
      requireHttps: true,
      timeoutMs: CAMERA_URL_DOWNLOAD_TIMEOUT_MS,
    });
    release = guarded.release;
    const res = guarded.response;
    const finalUrl = new URL(guarded.finalUrl);
    if (normalizeHostname(finalUrl.hostname) !== expectedHost) {
      await cancelIgnoredResponseBody(res);
      throw new Error(
        `writeUrlToFile: redirect host ${finalUrl.hostname} must match node host ${opts.expectedHost}`,
      );
    }
    if (!res.ok) {
      await cancelIgnoredResponseBody(res);
      throw new Error(`failed to download ${url}: ${res.status} ${res.statusText}`);
    }

    const contentLengthRaw = res.headers.get("content-length");
    const contentLength = parseStrictNonNegativeInteger(contentLengthRaw);
    if (
      typeof contentLength === "number" &&
      Number.isFinite(contentLength) &&
      contentLength > MAX_CAMERA_URL_DOWNLOAD_BYTES
    ) {
      await cancelIgnoredResponseBody(res);
      throw new Error(
        `writeUrlToFile: content-length ${contentLength} exceeds max ${MAX_CAMERA_URL_DOWNLOAD_BYTES}`,
      );
    }

    const body = res.body;
    if (!body) {
      await cancelIgnoredResponseBody(res);
      throw new Error(`failed to download ${url}: empty response body`);
    }

    const fileHandle = await fs.open(filePath, "w");
    let thrown: unknown;
    const reader = body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (!value || value.byteLength === 0) {
          continue;
        }
        bytes += value.byteLength;
        if (bytes > MAX_CAMERA_URL_DOWNLOAD_BYTES) {
          await reader.cancel().catch(() => undefined);
          throw new Error(
            `writeUrlToFile: downloaded ${bytes} bytes, exceeds max ${MAX_CAMERA_URL_DOWNLOAD_BYTES}`,
          );
        }
        await fileHandle.write(value);
      }
    } catch (err) {
      thrown = err;
      await reader.cancel().catch(() => undefined);
    } finally {
      reader.releaseLock();
      await fileHandle.close();
    }

    if (thrown) {
      await fs.unlink(filePath).catch(() => {});
      throw toErrorObject(thrown, "Non-Error thrown");
    }
  } finally {
    await release();
  }

  return { path: filePath, bytes };
}

function estimateDecodedBase64Bytes(base64: string): number {
  const normalized = base64.replace(/\s+/g, "");
  const padding = normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0;
  return Math.floor((normalized.length * 3) / 4) - padding;
}

/** Decode a base64 media payload to disk with preflight and post-decode size checks. */
export async function writeBase64ToFile(
  filePath: string,
  base64: string,
  opts: { maxBytes?: number } = {},
) {
  const maxBytes = opts.maxBytes ?? MAX_CAMERA_BASE64_BYTES;
  if (estimateDecodedBase64Bytes(base64) > maxBytes) {
    throw new Error(`writeBase64ToFile: decoded payload exceeds max ${maxBytes}`);
  }
  const buf = Buffer.from(base64, "base64");
  if (buf.length > maxBytes) {
    throw new Error(`writeBase64ToFile: decoded ${buf.length} bytes, exceeds max ${maxBytes}`);
  }
  await fs.writeFile(filePath, buf);
  return { path: filePath, bytes: buf.length };
}

/** Require the node remote IP needed to validate URL-backed camera payloads. */
function requireNodeRemoteIp(remoteIp?: string): string {
  const normalized = remoteIp?.trim();
  if (!normalized) {
    throw new Error("camera URL payload requires node remoteIp");
  }
  return normalized;
}

/** Write either a URL-backed or base64-backed camera payload to disk. */
export async function writeCameraPayloadToFile(params: {
  filePath: string;
  payload: { url?: string; base64?: string };
  expectedHost?: string;
  invalidPayloadMessage?: string;
}) {
  if (params.payload.url) {
    await writeUrlToFile(params.filePath, params.payload.url, {
      expectedHost: requireNodeRemoteIp(params.expectedHost),
    });
    return;
  }
  if (params.payload.base64) {
    await writeBase64ToFile(params.filePath, params.payload.base64);
    return;
  }
  throw new Error(params.invalidPayloadMessage ?? "invalid camera payload");
}

/** Write a camera clip payload to a generated temp file and return its path. */
export async function writeCameraClipPayloadToFile(params: {
  payload: CameraClipPayload;
  facing: CameraFacing;
  tmpDir?: string;
  id?: string;
  expectedHost?: string;
}): Promise<string> {
  const filePath = cameraTempPath({
    kind: "clip",
    facing: params.facing,
    ext: params.payload.format,
    tmpDir: params.tmpDir,
    id: params.id,
  });
  await writeCameraPayloadToFile({
    filePath,
    payload: params.payload,
    expectedHost: params.expectedHost,
    invalidPayloadMessage: "invalid camera.clip payload",
  });
  return filePath;
}
