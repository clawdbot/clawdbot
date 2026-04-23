import { loadQrCodeTuiRuntime } from "./qr-runtime.ts";

const DEFAULT_QR_PNG_SCALE = 6;
const DEFAULT_QR_PNG_MARGIN_MODULES = 4;
const MIN_QR_PNG_SCALE = 1;
const MAX_QR_PNG_SCALE = 12;
const MIN_QR_PNG_MARGIN_MODULES = 0;
const MAX_QR_PNG_MARGIN_MODULES = 16;

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

export async function renderQrPngBase64(
  input: string,
  opts: { scale?: number; marginModules?: number } = {},
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
