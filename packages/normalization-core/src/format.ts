import { expectDefined } from "./expect.js";

type ByteSizeUnit = "byte" | "kilo" | "mega" | "giga" | "tera";
type ByteSizeStyle = "iec" | "legacy-binary";

type ByteSizeFormatOptions = {
  style: ByteSizeStyle;
  maxUnit: ByteSizeUnit;
  separator: "" | " ";
  fractionDigits: number | ((value: number, unit: ByteSizeUnit) => number | null);
  floorUnits?: readonly ByteSizeUnit[];
};

const BYTE_SIZE_UNITS: readonly ByteSizeUnit[] = ["byte", "kilo", "mega", "giga", "tera"];
const BYTE_SIZE_STYLES = {
  iec: { base: 1024, labels: ["B", "KiB", "MiB", "GiB", "TiB"] },
  "legacy-binary": { base: 1024, labels: ["B", "KB", "MB", "GB", "TB"] },
} as const satisfies Record<ByteSizeStyle, { base: number; labels: readonly string[] }>;

/** Formats a byte count with caller-explicit scale, labels, precision, and unit cap. */
export function formatByteSize(bytes: number, options: ByteSizeFormatOptions): string {
  const { base, labels } = BYTE_SIZE_STYLES[options.style];
  const maxUnitIndex = BYTE_SIZE_UNITS.indexOf(options.maxUnit);
  let unitIndex = 0;
  let value = bytes;
  while (value >= base && unitIndex < maxUnitIndex) {
    value /= base;
    unitIndex += 1;
  }

  const unit = expectDefined(BYTE_SIZE_UNITS[unitIndex], "byte-size unit");
  const label = expectDefined(labels[unitIndex], "byte-size label");
  const fractionDigits =
    typeof options.fractionDigits === "function"
      ? options.fractionDigits(value, unit)
      : options.fractionDigits;
  if (fractionDigits === null) {
    return `${value}${options.separator}${label}`;
  }
  if (options.floorUnits?.includes(unit)) {
    value = Math.floor(value * 10 ** fractionDigits) / 10 ** fractionDigits;
  }
  return `${value.toFixed(fractionDigits)}${options.separator}${label}`;
}
