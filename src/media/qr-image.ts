// QR image helpers generate QR code image files for media delivery.
import path from "node:path";
import { tempWorkspace } from "../infra/private-temp-workspace.js";
import { loadQrCodeRuntime } from "./qr-runtime.ts";

const DEFAULT_QR_PNG_SCALE = 6;
const DEFAULT_QR_PNG_MARGIN_MODULES = 4;
const MIN_QR_PNG_SCALE = 1;
const MAX_QR_PNG_SCALE = 12;
const MIN_QR_PNG_MARGIN_MODULES = 0;
const MAX_QR_PNG_MARGIN_MODULES = 16;
const QR_PNG_DATA_URL_PREFIX = "data:image/png;base64,";

type QrPngRenderOptions = {
  scale?: number;
  marginModules?: number;
};

/** Temp-file write options kept to filename segments so callers cannot choose parent paths. */
type QrPngTempFileOptions = QrPngRenderOptions & {
  tmpRoot: string;
  dirPrefix: string;
  fileName?: string;
};

type QrPngTempFile = {
  filePath: string;
  dirPath: string;
  mediaLocalRoots: string[];
};

function resolveQrPngIntegerOption(params: {
  name: string;
  value: number | undefined;
  defaultValue: number;
  min: number;
  max: number;
}): number {
  if (params.value === undefined) {
    return params.defaultValue;
  }
  if (!Number.isFinite(params.value)) {
    throw new RangeError(`${params.name} must be a finite number.`);
  }
  const value = Math.floor(params.value);
  if (value < params.min || value > params.max) {
    throw new RangeError(`${params.name} must be between ${params.min} and ${params.max}.`);
  }
  return value;
}

function resolveQrTempPathSegment(name: string, value: string): string {
  if (!value || value === "." || value === ".." || path.basename(value) !== value) {
    throw new RangeError(`${name} must be a non-empty filename segment.`);
  }
  return value;
}

async function renderQrPngBuffer(input: string, opts: QrPngRenderOptions): Promise<Buffer> {
  const scale = resolveQrPngIntegerOption({
    name: "scale",
    value: opts.scale,
    defaultValue: DEFAULT_QR_PNG_SCALE,
    min: MIN_QR_PNG_SCALE,
    max: MAX_QR_PNG_SCALE,
  });
  const marginModules = resolveQrPngIntegerOption({
    name: "marginModules",
    value: opts.marginModules,
    defaultValue: DEFAULT_QR_PNG_MARGIN_MODULES,
    min: MIN_QR_PNG_MARGIN_MODULES,
    max: MAX_QR_PNG_MARGIN_MODULES,
  });
  const qrCode = await loadQrCodeRuntime();
  return await qrCode.toBuffer(input, {
    margin: marginModules,
    scale,
  });
}

/** Renders QR text as raw PNG base64 after validating bounded renderer options. */
export async function renderQrPngBase64(
  input: string,
  opts: QrPngRenderOptions = {},
): Promise<string> {
  return (await renderQrPngBuffer(input, opts)).toString("base64");
}

/** Renders QR text as a PNG data URL. */
export async function renderQrPngDataUrl(
  input: string,
  opts: QrPngRenderOptions = {},
): Promise<string> {
  return `${QR_PNG_DATA_URL_PREFIX}${await renderQrPngBase64(input, opts)}`;
}

/** Writes QR PNG output into a scoped temp directory and returns that directory as a media root. */
export async function writeQrPngTempFile(
  input: string,
  opts: QrPngTempFileOptions,
): Promise<QrPngTempFile> {
  const dirPrefix = resolveQrTempPathSegment("dirPrefix", opts.dirPrefix);
  const fileName = resolveQrTempPathSegment("fileName", opts.fileName ?? "qr.png");
  const png = await renderQrPngBuffer(input, opts);
  const workspace = await tempWorkspace({ rootDir: opts.tmpRoot, prefix: dirPrefix });
  const dirPath = workspace.dir;
  try {
    const filePath = await workspace.write(fileName, png);
    return {
      filePath,
      dirPath,
      mediaLocalRoots: [dirPath],
    };
  } catch (err) {
    await workspace.cleanup();
    throw err;
  }
}
