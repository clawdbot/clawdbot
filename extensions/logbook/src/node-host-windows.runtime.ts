// Windows-only runtime boundary. node-screenshots loads a platform-native
// binding at import time, so node-host.ts must only import this module on win32.
import { Monitor } from "node-screenshots";
import { createRastermill } from "rastermill";
import type { LogbookSnapshotPayload } from "./node-host.js";

type WindowsLogbookSnapshotParams = {
  screenIndex?: number;
  maxWidth?: number;
  quality?: number;
};

const DEFAULT_MAX_SIDE = 1440;
const DEFAULT_JPEG_QUALITY = 60;
// 8K displays exceed Rastermill's conservative 25 MP default input budget.
// Keep a finite ceiling while allowing current high-resolution desktops.
const WINDOWS_CAPTURE_INPUT_PIXELS = 100_000_000;
const rastermill = createRastermill({
  execution: "internal",
  limits: { inputPixels: WINDOWS_CAPTURE_INPUT_PIXELS, outputPixels: 25_000_000 },
});

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function readParams(value: unknown): WindowsLogbookSnapshotParams {
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

export async function captureWindowsLogbookSnapshot(
  rawParams: unknown,
): Promise<LogbookSnapshotPayload> {
  const params = readParams(rawParams);
  const screenIndex = Math.max(0, Math.round(params.screenIndex ?? 0));
  const maxSide =
    params.maxWidth && params.maxWidth >= 480 ? Math.round(params.maxWidth) : DEFAULT_MAX_SIDE;
  const quality = Math.min(
    100,
    Math.max(
      10,
      Math.round(
        (params.quality && params.quality > 0 && params.quality <= 1
          ? params.quality
          : DEFAULT_JPEG_QUALITY / 100) * 100,
      ),
    ),
  );

  let monitors: Monitor[];
  try {
    monitors = Monitor.all()
      .map((monitor) => ({
        monitor,
        id: monitor.id(),
        isPrimary: monitor.isPrimary(),
        x: monitor.x(),
        y: monitor.y(),
      }))
      // Native enumeration order is not a stable screenIndex contract.
      .toSorted(
        (a, b) =>
          Number(b.isPrimary) - Number(a.isPrimary) || a.x - b.x || a.y - b.y || a.id - b.id,
      )
      .map(({ monitor }) => monitor);
  } catch (err) {
    return {
      error:
        `Windows display enumeration failed: ${errorMessage(err)}. ` +
        "Run the OpenClaw node host in the interactive signed-in desktop session you want to capture.",
    };
  }
  if (monitors.length === 0) {
    return {
      error:
        "Windows screen capture found no displays. Run the OpenClaw node host in the " +
        "interactive signed-in desktop session you want to capture.",
    };
  }
  const targetMonitor = monitors[screenIndex];
  if (!targetMonitor) {
    return {
      error:
        `screenIndex ${screenIndex} is unavailable: Windows reported ${monitors.length} display(s). ` +
        `Set plugins.entries.logbook.config.screenIndex to 0-${monitors.length - 1}.`,
    };
  }

  let png: Buffer;
  try {
    const image = await targetMonitor.captureImage();
    png = await image.toPng();
  } catch (err) {
    return {
      error:
        `Windows display ${screenIndex} capture failed: ${errorMessage(err)}. ` +
        "Run the node host in the interactive signed-in desktop session you want to capture.",
    };
  }

  try {
    const encoded = await rastermill.encode(png, {
      format: "jpeg",
      quality,
      resize: { maxSide },
    });
    return {
      format: "jpeg",
      base64: encoded.data.toString("base64"),
      width: encoded.width,
      height: encoded.height,
    };
  } catch (err) {
    return {
      error:
        `Windows display ${screenIndex} was captured, but JPEG normalization failed: ${errorMessage(err)}. ` +
        "Reinstall OpenClaw on this Windows node to restore Rastermill's image processor.",
    };
  }
}
