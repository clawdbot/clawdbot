import fs from "node:fs";
import JSON5 from "json5";
import {
  normalizeOptionalString,
  normalizeStringifiedOptionalString,
} from "../shared/string-coerce.js";

export type ConfigSetOptions = {
  strictJson?: boolean;
  json?: boolean;
  dryRun?: boolean;
  allowExec?: boolean;
  merge?: boolean;
  replace?: boolean;
  refProvider?: string;
  refSource?: string;
  refId?: string;
  providerSource?: string;
  providerAllowlist?: string[];
  providerPath?: string;
  providerMode?: string;
  providerTimeoutMs?: string;
  providerMaxBytes?: string;
  providerCommand?: string;
  providerArg?: string[];
  providerNoOutputTimeoutMs?: string;
  providerMaxOutputBytes?: string;
  providerJsonOnly?: boolean;
  providerEnv?: string[];
  providerPassEnv?: string[];
  providerTrustedDir?: string[];
  providerAllowInsecurePath?: boolean;
  providerAllowSymlinkCommand?: boolean;
  batchJson?: string;
  batchFile?: string;
};

export type ConfigSetBatchEntry = {
  path: string;
  value?: unknown;
  ref?: unknown;
  provider?: unknown;
};

export function hasBatchMode(opts: ConfigSetOptions): boolean {
  return Boolean(
    normalizeOptionalString(opts.batchJson) || normalizeOptionalString(opts.batchFile),
  );
}

export function hasRefBuilderOptions(opts: ConfigSetOptions): boolean {
  return Boolean(opts.refProvider || opts.refSource || opts.refId);
}

export function hasProviderBuilderOptions(opts: ConfigSetOptions): boolean {
  return Boolean(
    opts.providerSource ||
    opts.providerAllowlist?.length ||
    opts.providerPath ||
    opts.providerMode ||
    opts.providerTimeoutMs ||
    opts.providerMaxBytes ||
    opts.providerCommand ||
    opts.providerArg?.length ||
    opts.providerNoOutputTimeoutMs ||
    opts.providerMaxOutputBytes ||
    opts.providerJsonOnly ||
    opts.providerEnv?.length ||
    opts.providerPassEnv?.length ||
    opts.providerTrustedDir?.length ||
    opts.providerAllowInsecurePath ||
    opts.providerAllowSymlinkCommand,
  );
}

function parseJson5Raw(raw: string, label: string): unknown {
  try {
    return JSON5.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse ${label}: ${String(err)}`, { cause: err });
  }
}

function parseBatchEntries(raw: string, sourceLabel: string): ConfigSetBatchEntry[] {
  const parsed = parseJson5Raw(raw, sourceLabel);
  if (!Array.isArray(parsed)) {
    throw new Error(`${sourceLabel} must be a JSON array.`);
  }
  const out: ConfigSetBatchEntry[] = [];
  for (const [index, entry] of parsed.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`${sourceLabel}[${index}] must be an object.`);
    }
    const typed = entry as Record<string, unknown>;
    const path = normalizeOptionalString(typed.path) ?? "";
    if (!path) {
      throw new Error(`${sourceLabel}[${index}].path is required.`);
    }
    const hasValue = Object.prototype.hasOwnProperty.call(typed, "value");
    const hasRef = Object.prototype.hasOwnProperty.call(typed, "ref");
    const hasProvider = Object.prototype.hasOwnProperty.call(typed, "provider");
    const modeCount = Number(hasValue) + Number(hasRef) + Number(hasProvider);
    if (modeCount !== 1) {
      throw new Error(
        `${sourceLabel}[${index}] must include exactly one of: value, ref, provider.`,
      );
    }
    out.push({
      path,
      ...(hasValue ? { value: typed.value } : {}),
      ...(hasRef ? { ref: typed.ref } : {}),
      ...(hasProvider ? { provider: typed.provider } : {}),
    });
  }
  return out;
}

export function parseBatchSource(opts: ConfigSetOptions): ConfigSetBatchEntry[] | null {
  const batchJson = normalizeOptionalString(opts.batchJson);
  const batchFile = normalizeOptionalString(opts.batchFile);
  const hasInline = Boolean(batchJson);
  const hasFile = Boolean(batchFile);
  if (!hasInline && !hasFile) {
    return null;
  }
  if (hasInline && hasFile) {
    throw new Error("Use either --batch-json or --batch-file, not both.");
  }
  if (hasInline) {
    return parseBatchEntries(batchJson as string, "--batch-json");
  }
  const pathname = normalizeStringifiedOptionalString(opts.batchFile) ?? "";
  if (!pathname) {
    throw new Error("--batch-file must not be empty.");
  }
  const raw = fs.readFileSync(pathname, "utf8");
  return parseBatchEntries(raw, "--batch-file");
}
