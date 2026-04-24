import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadQrCodeTuiRuntime } from "./qr-runtime.ts";

const DEFAULT_QR_PNG_SCALE = 6;
const DEFAULT_QR_PNG_MARGIN_MODULES = 4;
const MIN_QR_PNG_SCALE = 1;
const MAX_QR_PNG_SCALE = 12;
const MIN_QR_PNG_MARGIN_MODULES = 0;
const MAX_QR_PNG_MARGIN_MODULES = 16;
const QR_PNG_DATA_URL_PREFIX = "data:image/png;base64,";

export type QrPngRenderOptions = {
  scale?: number;
  marginModules?: number;
};

export type QrPngTempFileOptions = QrPngRenderOptions & {
  tmpRoot: string;
  dirPrefix: string;
  fileName?: string;
};

export type QrPngTempFile = {
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

export async function renderQrPngBase64(
  input: string,
  opts: QrPngRenderOptions = {},
): Promise<string> {
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
  const { renderPngBase64 } = await loadQrCodeTuiRuntime();
  return await renderPngBase64(input, {
    margin: marginModules,
    scale,
  });
}

export function formatQrPngDataUrl(base64: string): string {
  return `${QR_PNG_DATA_URL_PREFIX}${base64}`;
}

export async function renderQrPngDataUrl(
  input: string,
  opts: QrPngRenderOptions = {},
): Promise<string> {
  return formatQrPngDataUrl(await renderQrPngBase64(input, opts));
}

export async function writeQrPngTempFile(
  input: string,
  opts: QrPngTempFileOptions,
): Promise<QrPngTempFile> {
  const dirPrefix = resolveQrTempPathSegment("dirPrefix", opts.dirPrefix);
  const fileName = resolveQrTempPathSegment("fileName", opts.fileName ?? "qr.png");
  const pngBase64 = await renderQrPngBase64(input, opts);
  const dirPath = await mkdtemp(path.join(opts.tmpRoot, dirPrefix));
  const filePath = path.join(dirPath, fileName);
  try {
    await writeFile(filePath, Buffer.from(pngBase64, "base64"));
  } catch (err) {
    await rm(dirPath, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
  return {
    filePath,
    dirPath,
    mediaLocalRoots: [dirPath],
  };
}
