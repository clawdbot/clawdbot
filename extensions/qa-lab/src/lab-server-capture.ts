import net from "node:net";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";

const CAPTURE_QUERY_PRESETS = new Set([
  "double-sends",
  "retry-storms",
  "cache-busting",
  "ws-duplicate-frames",
  "missing-ack",
  "error-bursts",
]);

type QaStartupProbeStatus = {
  label: string;
  url: string;
  ok: boolean;
  error?: string;
};

export function isCaptureQueryPreset(
  value: string,
): value is Parameters<
  ReturnType<
    typeof import("openclaw/plugin-sdk/proxy-capture").getDebugProxyCaptureStore
  >["queryPreset"]
>[0] {
  return CAPTURE_QUERY_PRESETS.has(value);
}

function parseCaptureMeta(metaJson: unknown): Record<string, unknown> | null {
  if (typeof metaJson !== "string" || metaJson.trim().length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(metaJson) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function readCaptureMetaString(
  meta: Record<string, unknown> | null,
  key: string,
): string | undefined {
  const value = meta?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function mapCaptureEventForQa(row: Record<string, unknown>) {
  const meta = parseCaptureMeta(row.metaJson);
  return {
    ...row,
    payloadPreview: typeof row.dataText === "string" ? row.dataText : undefined,
    provider: readCaptureMetaString(meta, "provider"),
    api: readCaptureMetaString(meta, "api"),
    model: readCaptureMetaString(meta, "model"),
    captureOrigin: readCaptureMetaString(meta, "captureOrigin"),
  };
}

function defaultPortForProtocol(protocol: string): number {
  if (protocol === "https:") {
    return 443;
  }
  if (protocol === "http:") {
    return 80;
  }
  return 0;
}

export async function probeTcpReachability(
  rawUrl: string,
  timeoutMs = 700,
): Promise<QaStartupProbeStatus> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return {
      label: rawUrl,
      url: rawUrl,
      ok: false,
      error: "invalid url",
    };
  }
  const host = parsed.hostname;
  const port = parsed.port ? Number(parsed.port) : defaultPortForProtocol(parsed.protocol);
  if (!host || !Number.isFinite(port) || port <= 0) {
    return {
      label: parsed.origin,
      url: parsed.toString(),
      ok: false,
      error: "missing host or port",
    };
  }
  try {
    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection({ host, port });
      const onError = (error: Error) => {
        socket.destroy();
        reject(error);
      };
      socket.setTimeout(timeoutMs, () => {
        socket.destroy(new Error("timeout"));
      });
      socket.once("connect", () => {
        socket.end();
        resolve();
      });
      socket.once("error", onError);
      socket.once("timeout", () => onError(new Error("timeout")));
    });
    return {
      label: parsed.host,
      url: parsed.toString(),
      ok: true,
    };
  } catch (error) {
    return {
      label: parsed.host,
      url: parsed.toString(),
      ok: false,
      error: formatErrorMessage(error),
    };
  }
}
