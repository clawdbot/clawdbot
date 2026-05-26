import { normalizeStringEntries } from "../shared/string-normalization.js";

const TAR_VERBOSE_MONTHS = new Set([
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
]);
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function mapTarVerboseTypeChar(typeChar: string): string {
  switch (typeChar) {
    case "l":
      return "SymbolicLink";
    case "h":
      return "Link";
    case "b":
      return "BlockDevice";
    case "c":
      return "CharacterDevice";
    case "p":
      return "FIFO";
    case "s":
      return "Socket";
    case "d":
      return "Directory";
    default:
      return "File";
  }
}

function parseTarVerboseSize(line: string): number {
  const tokens = line.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 6) {
    throw new Error(`unable to parse tar verbose metadata: ${line}`);
  }

  let dateIndex = tokens.findIndex((token) => TAR_VERBOSE_MONTHS.has(token));
  if (dateIndex > 0) {
    const size = Number.parseInt(tokens[dateIndex - 1] ?? "", 10);
    if (!Number.isFinite(size) || size < 0) {
      throw new Error(`unable to parse tar entry size: ${line}`);
    }
    return size;
  }

  dateIndex = tokens.findIndex((token) => ISO_DATE_PATTERN.test(token));
  if (dateIndex > 0) {
    const size = Number.parseInt(tokens[dateIndex - 1] ?? "", 10);
    if (!Number.isFinite(size) || size < 0) {
      throw new Error(`unable to parse tar entry size: ${line}`);
    }
    return size;
  }

  throw new Error(`unable to parse tar verbose metadata: ${line}`);
}

export function parseTarVerboseMetadata(stdout: string): Array<{ type: string; size: number }> {
  const lines = normalizeStringEntries(stdout.split("\n"));
  return lines.map((line) => {
    const typeChar = line[0] ?? "";
    if (!typeChar) {
      throw new Error("unable to parse tar entry type");
    }
    return {
      type: mapTarVerboseTypeChar(typeChar),
      size: parseTarVerboseSize(line),
    };
  });
}
