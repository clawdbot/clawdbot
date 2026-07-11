/**
 * Managed Chrome graphics diagnostics.
 *
 * Reads the browser-level SystemInfo domain and caches normalized facts on the
 * exact RunningChrome instance that owns the process.
 */
import type { SsrFPolicy } from "../infra/net/ssrf.js";
import { redactCdpErrorText, withCdpSocket } from "./cdp.helpers.js";
import { getChromeWebSocketUrl, type RunningChrome } from "./chrome.js";
import type {
  BrowserGraphicsAcceleration,
  BrowserGraphicsDevice,
  BrowserGraphicsDiagnostics,
  BrowserVideoDecodeCapability,
  BrowserVideoEncodeCapability,
} from "./client.types.js";

type UnknownRecord = Record<string, unknown>;

export type ChromeGraphicsProbeOptions = {
  httpTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  commandTimeoutMs?: number;
  ssrfPolicy?: SsrFPolicy;
};

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readStringRecord(value: unknown): Record<string, string> {
  const record = asRecord(value);
  if (!record) {
    return {};
  }
  const entries = Object.entries(record)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .toSorted(([left], [right]) => left.localeCompare(right));
  return Object.fromEntries(entries);
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function readSize(value: unknown): { width: number; height: number } {
  const size = asRecord(value);
  return {
    width: readNumber(size?.width),
    height: readNumber(size?.height),
  };
}

function readDevices(value: unknown): BrowserGraphicsDevice[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    const device = asRecord(item);
    if (!device) {
      return [];
    }
    return [
      {
        vendorId: readNumber(device.vendorId),
        deviceId: readNumber(device.deviceId),
        vendor: readString(device.vendorString),
        device: readString(device.deviceString),
        driverVendor: readString(device.driverVendor),
        driverVersion: readString(device.driverVersion),
      },
    ];
  });
}

function readVideoDecoding(value: unknown): BrowserVideoDecodeCapability[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    const capability = asRecord(item);
    if (!capability) {
      return [];
    }
    return [
      {
        profile: readString(capability.profile),
        minResolution: readSize(capability.minResolution),
        maxResolution: readSize(capability.maxResolution),
      },
    ];
  });
}

function readVideoEncoding(value: unknown): BrowserVideoEncodeCapability[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    const capability = asRecord(item);
    if (!capability) {
      return [];
    }
    return [
      {
        profile: readString(capability.profile),
        maxResolution: readSize(capability.maxResolution),
        maxFramerateNumerator: readNumber(capability.maxFramerateNumerator),
        maxFramerateDenominator: readNumber(capability.maxFramerateDenominator),
      },
    ];
  });
}

function firstAttribute(
  attributes: Record<string, string>,
  names: readonly string[],
): string | null {
  for (const name of names) {
    const value = readString(attributes[name]);
    if (value) {
      return value;
    }
  }
  return null;
}

function classifyGraphicsAcceleration(params: {
  renderer: string | null;
  devices: BrowserGraphicsDevice[];
  featureStatus: Record<string, string>;
}): BrowserGraphicsAcceleration {
  const deviceText = params.devices
    .flatMap((device) => [device.vendor, device.device, device.driverVendor])
    .join(" ");
  const description = `${params.renderer ?? ""} ${deviceText}`.toLowerCase();
  if (
    /(swiftshader|swangle|llvmpipe|softpipe|software rasterizer|swrast|microsoft basic render driver|d3d11-warp|\bdisabled\b)/.test(
      description,
    )
  ) {
    return "software";
  }
  if (description.trim()) {
    return "hardware";
  }

  // Chrome omits renderer/device text when GPU use is disabled, but its core
  // feature states still distinguish the effective software rendering path.
  const coreFeatureStatuses = ["2d_canvas", "gpu_compositing", "rasterization", "webgl"].map(
    (feature) => params.featureStatus[feature]?.toLowerCase() ?? "",
  );
  return coreFeatureStatuses.some((status) => status.includes("software")) ? "software" : "unknown";
}

export function normalizeChromeGraphicsInfo(
  value: unknown,
  observedAt = Date.now(),
): BrowserGraphicsDiagnostics {
  const result = asRecord(value);
  const gpu = asRecord(result?.gpu);
  if (!gpu) {
    return {
      status: "unavailable",
      observedAt,
      reason: "SystemInfo.getInfo returned no GPU information",
    };
  }

  const attributes = readStringRecord(gpu.auxAttributes);
  const featureStatus = readStringRecord(gpu.featureStatus);
  const devices = readDevices(gpu.devices);
  const renderer = firstAttribute(attributes, ["glRenderer", "angleRenderer", "webglRenderer"]);
  const disabledFeatures = Object.entries(featureStatus)
    .filter(([, status]) => !status.toLowerCase().startsWith("enabled"))
    .map(([feature, status]) => ({ feature, status }));

  return {
    status: "available",
    observedAt,
    acceleration: classifyGraphicsAcceleration({ renderer, devices, featureStatus }),
    renderer,
    vendor: firstAttribute(attributes, ["glVendor", "angleVendor", "webglVendor"]),
    version: firstAttribute(attributes, ["glVersion", "angleVersion"]),
    backend: firstAttribute(attributes, ["glImplementationParts", "displayType"]),
    devices,
    featureStatus,
    disabledFeatures,
    driverBugWorkarounds: readStringArray(gpu.driverBugWorkarounds),
    videoDecoding: readVideoDecoding(gpu.videoDecoding),
    videoEncoding: readVideoEncoding(gpu.videoEncoding),
  };
}

export async function inspectChromeGraphicsDiagnostics(
  cdpUrl: string,
  options: ChromeGraphicsProbeOptions = {},
): Promise<BrowserGraphicsDiagnostics> {
  const observedAt = Date.now();
  try {
    const wsUrl = await getChromeWebSocketUrl(cdpUrl, options.httpTimeoutMs, options.ssrfPolicy);
    if (!wsUrl) {
      return {
        status: "unavailable",
        observedAt,
        reason: "browser-level CDP WebSocket was not advertised",
      };
    }
    const result = await withCdpSocket(wsUrl, async (send) => await send("SystemInfo.getInfo"), {
      handshakeTimeoutMs: options.handshakeTimeoutMs,
      commandTimeoutMs: options.commandTimeoutMs,
      handshakeRetries: 0,
    });
    return normalizeChromeGraphicsInfo(result, observedAt);
  } catch (error) {
    return {
      status: "unavailable",
      observedAt,
      reason: redactCdpErrorText(error instanceof Error ? error.message : String(error)),
    };
  }
}

export async function getCachedChromeGraphicsDiagnostics(
  running: RunningChrome,
  load: () => Promise<BrowserGraphicsDiagnostics>,
): Promise<BrowserGraphicsDiagnostics> {
  if (running.graphicsDiagnostics) {
    return running.graphicsDiagnostics;
  }
  running.graphicsDiagnosticsPending ??= load();
  try {
    const diagnostics = await running.graphicsDiagnosticsPending;
    running.graphicsDiagnostics = diagnostics;
    return diagnostics;
  } finally {
    running.graphicsDiagnosticsPending = undefined;
  }
}

export function formatBrowserGraphicsSummary(diagnostics: BrowserGraphicsDiagnostics): string {
  if (diagnostics.status === "unavailable") {
    return `unavailable: ${diagnostics.reason}`;
  }
  const device = diagnostics.devices[0];
  const details = [
    diagnostics.acceleration,
    diagnostics.renderer ? `renderer ${diagnostics.renderer}` : undefined,
    diagnostics.backend ? `backend ${diagnostics.backend}` : undefined,
    device?.device ? `device ${device.device}` : undefined,
    `video decode ${diagnostics.videoDecoding.length}, encode ${diagnostics.videoEncoding.length}`,
  ].filter((value): value is string => Boolean(value));
  return details.join("; ");
}
