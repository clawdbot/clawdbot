import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveNpmJsonEntries } from "./npm-json-output.mts";

// 2026.3.12 ballooned to ~213.6 MiB unpacked and correlated with low-memory
// startup/doctor OOM reports. 2026.4.12 intentionally stages Matrix runtime
// dependencies, including crypto wasm, so packaged installs do not miss Docker
// and gateway runtime dependencies. Keep the budget below the 2026.3.12 bloat
// level while allowing that mirrored runtime surface.
const NPM_PACK_UNPACKED_SIZE_BUDGET_BYTES = 202 * 1024 * 1024;

function formatMiB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function resolvePackResultLabel(entry: Record<string, unknown>, index: number): string {
  return (
    (typeof entry.filename === "string" && entry.filename.trim()) || `pack result #${index + 1}`
  );
}

function formatPackUnpackedSizeBudgetError(params: {
  budgetBytes?: number;
  label: string;
  unpackedSize: number;
}): string {
  const budgetBytes = params.budgetBytes ?? NPM_PACK_UNPACKED_SIZE_BUDGET_BYTES;
  return [
    `${params.label} unpackedSize ${params.unpackedSize} bytes (${formatMiB(params.unpackedSize)}) exceeds budget ${budgetBytes} bytes (${formatMiB(budgetBytes)}).`,
    "Investigate duplicate channel shims, copied extension trees, or other accidental pack bloat before release.",
  ].join(" ");
}

export function collectPackUnpackedSizeErrors(
  results: unknown,
  options: { budgetBytes?: number; missingDataMessage?: string } = {},
): string[] {
  const entries = resolveNpmJsonEntries(results);
  const errors: string[] = [];
  const budgetBytes = options.budgetBytes ?? NPM_PACK_UNPACKED_SIZE_BUDGET_BYTES;
  let checkedCount = 0;

  for (const [index, entry] of entries.entries()) {
    if (!isRecord(entry)) {
      continue;
    }
    const packResult = entry;
    if (typeof packResult.unpackedSize !== "number" || !Number.isFinite(packResult.unpackedSize)) {
      continue;
    }
    checkedCount += 1;
    if (packResult.unpackedSize <= budgetBytes) {
      continue;
    }
    errors.push(
      formatPackUnpackedSizeBudgetError({
        budgetBytes,
        label: resolvePackResultLabel(packResult, index),
        unpackedSize: packResult.unpackedSize,
      }),
    );
  }

  if (entries.length > 0 && checkedCount === 0) {
    errors.push(
      options.missingDataMessage ??
        "npm pack --dry-run produced no unpackedSize data; pack size budget was not verified.",
    );
  }

  return errors;
}
