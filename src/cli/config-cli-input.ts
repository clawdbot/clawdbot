import { readByteStreamWithLimit } from "@openclaw/media-core/read-byte-stream-with-limit";
import { isRecord as isPlainRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import JSON5 from "json5";
import {
  coerceSecretRef,
  isValidEnvSecretRefId,
  type SecretProviderConfig,
  type SecretRef,
  type SecretRefSource,
} from "../config/types.secrets.js";
import { SecretProviderSchema } from "../config/zod-schema.core.js";
import { hasErrnoCode } from "../infra/errors.js";
import { parseStrictPositiveInteger } from "../infra/parse-finite-number.js";
import {
  formatExecSecretRefIdValidationMessage,
  isValidFileSecretRefId,
  isValidSecretProviderAlias,
  validateExecSecretRefId,
} from "../secrets/ref-contract.js";
import { resolveConfigSecretTargetByPath } from "../secrets/target-registry.js";
import { formatCliCommand } from "./command-format.js";
import {
  parseConfigSetPath,
  parseConfigSetValue,
  type PathSegment,
  toDotPath,
  validatePathSegments,
} from "./config-cli-path.js";
import type { ConfigSetDryRunInputMode, ConfigSetDryRunResult } from "./config-set-dryrun.js";
import {
  hasProviderBuilderOptions,
  hasRefBuilderOptions,
  readConfigMutationFileSync,
  type ConfigSetBatchEntry,
  type ConfigSetOptions,
} from "./config-set-input.js";
import { resolveConfigSetMode } from "./config-set-parser.js";

const SECRET_PROVIDER_PATH_PREFIX: PathSegment[] = ["secrets", "providers"];
const CONFIG_PATCH_STDIN_MAX_BYTES = 1024 * 1024;

export type ConfigSetOperation = {
  inputMode: ConfigSetDryRunInputMode;
  requestedPath: PathSegment[];
  setPath: PathSegment[];
  value: unknown;
  mutation?: "set" | "merge" | "replace" | "delete";
  schemaValidated?: boolean;
  touchesAllSecretRefs?: boolean;
  touchedSecretTargetPath?: string;
  touchedProviderAlias?: string;
  assignedRef?: SecretRef;
};

export type ConfigPatchOptions = {
  file?: string;
  stdin?: boolean;
  dryRun?: boolean;
  allowExec?: boolean;
  json?: boolean;
  replacePath?: string[];
};

export type ConfigUnsetOptions = {
  dryRun?: boolean;
  allowExec?: boolean;
  json?: boolean;
};

export type ConfigMutationOptions = ConfigUnsetOptions & {
  merge?: boolean;
  replace?: boolean;
};

export class ConfigSetDryRunValidationError extends Error {
  constructor(readonly result: ConfigSetDryRunResult) {
    super("config set dry-run validation failed");
    this.name = "ConfigSetDryRunValidationError";
  }
}

export function modeError(message: string): Error {
  return new Error(`config set mode error: ${message}`);
}

export function configPatchModeError(message: string): Error {
  return new Error(`config patch mode error: ${message}`);
}

function parseSecretRefSource(raw: string, label: string): SecretRefSource {
  const source = raw.trim();
  if (source === "env" || source === "file" || source === "exec") {
    return source;
  }
  throw new Error(`${label} must be one of: env, file, exec.`);
}

function parseSecretRefBuilder(params: {
  provider: string;
  source: string;
  id: string;
  fieldPrefix: string;
}): SecretRef {
  const provider = params.provider.trim();
  if (!provider) {
    throw new Error(`${params.fieldPrefix}.provider is required.`);
  }
  if (!isValidSecretProviderAlias(provider)) {
    throw new Error(
      `${params.fieldPrefix}.provider must match /^[a-z][a-z0-9_-]{0,63}$/ (example: "default").`,
    );
  }

  const source = parseSecretRefSource(params.source, `${params.fieldPrefix}.source`);
  const id = params.id.trim();
  if (!id) {
    throw new Error(`${params.fieldPrefix}.id is required.`);
  }
  if (source === "env" && !isValidEnvSecretRefId(id)) {
    throw new Error(`${params.fieldPrefix}.id must match /^[A-Z][A-Z0-9_]{0,127}$/ for env refs.`);
  }
  if (source === "file" && !isValidFileSecretRefId(id)) {
    throw new Error(
      `${params.fieldPrefix}.id must be an absolute JSON pointer (or "value" for singleValue mode).`,
    );
  }
  if (source === "exec" && !validateExecSecretRefId(id).ok) {
    throw new Error(formatExecSecretRefIdValidationMessage());
  }
  return { source, provider, id };
}

function parseOptionalPositiveInteger(raw: string | undefined, flag: string): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error(`${flag} must not be empty.`);
  }
  const parsed = parseStrictPositiveInteger(trimmed);
  if (parsed === undefined) {
    throw new Error(`${flag} must be a positive integer.`);
  }
  return parsed;
}

function parseProviderEnvEntries(
  entries: string[] | undefined,
): Record<string, string> | undefined {
  if (!entries || entries.length === 0) {
    return undefined;
  }
  const env: Record<string, string> = {};
  for (const entry of entries) {
    const separator = entry.indexOf("=");
    if (separator <= 0) {
      throw new Error(`--provider-env expects KEY=VALUE entries (received: "${entry}").`);
    }
    const key = entry.slice(0, separator).trim();
    if (!key) {
      throw new Error(`--provider-env key must not be empty (received: "${entry}").`);
    }
    env[key] = entry.slice(separator + 1);
  }
  return Object.keys(env).length > 0 ? env : undefined;
}

function parseProviderAliasPath(path: PathSegment[]): string {
  if (
    path.length !== 3 ||
    path[0] !== SECRET_PROVIDER_PATH_PREFIX[0] ||
    path[1] !== SECRET_PROVIDER_PATH_PREFIX[1]
  ) {
    throw new Error(
      'Provider builder mode requires path "secrets.providers.<alias>" (example: secrets.providers.vault).',
    );
  }
  const alias = path[2] ?? "";
  if (!isValidSecretProviderAlias(alias)) {
    throw new Error(
      `Provider alias "${alias}" must match /^[a-z][a-z0-9_-]{0,63}$/ (example: "default").`,
    );
  }
  return alias;
}

function buildProviderFromBuilder(opts: ConfigSetOptions): SecretProviderConfig {
  const sourceRaw = opts.providerSource?.trim();
  if (!sourceRaw) {
    throw new Error("--provider-source is required in provider builder mode.");
  }
  const source = parseSecretRefSource(sourceRaw, "--provider-source");
  const timeoutMs = parseOptionalPositiveInteger(opts.providerTimeoutMs, "--provider-timeout-ms");
  const maxBytes = parseOptionalPositiveInteger(opts.providerMaxBytes, "--provider-max-bytes");
  const noOutputTimeoutMs = parseOptionalPositiveInteger(
    opts.providerNoOutputTimeoutMs,
    "--provider-no-output-timeout-ms",
  );
  const maxOutputBytes = parseOptionalPositiveInteger(
    opts.providerMaxOutputBytes,
    "--provider-max-output-bytes",
  );
  const providerEnv = parseProviderEnvEntries(opts.providerEnv);

  let provider: SecretProviderConfig;
  if (source === "env") {
    const allowlist = normalizeStringEntries(opts.providerAllowlist);
    for (const envName of allowlist) {
      if (!isValidEnvSecretRefId(envName)) {
        throw new Error(
          `--provider-allowlist entry "${envName}" must match /^[A-Z][A-Z0-9_]{0,127}$/.`,
        );
      }
    }
    provider = { source: "env", ...(allowlist.length > 0 ? { allowlist } : {}) };
  } else if (source === "file") {
    const filePath = opts.providerPath?.trim();
    if (!filePath) {
      throw new Error("--provider-path is required when --provider-source file is used.");
    }
    const modeRaw = opts.providerMode?.trim();
    if (modeRaw && modeRaw !== "singleValue" && modeRaw !== "json") {
      throw new Error("--provider-mode must be one of: singleValue, json.");
    }
    const mode = modeRaw === "singleValue" || modeRaw === "json" ? modeRaw : undefined;
    provider = {
      source: "file",
      path: filePath,
      ...(mode ? { mode } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(maxBytes !== undefined ? { maxBytes } : {}),
      ...(opts.providerAllowInsecurePath ? { allowInsecurePath: true } : {}),
    };
  } else {
    const command = opts.providerCommand?.trim();
    if (!command) {
      throw new Error("--provider-command is required when --provider-source exec is used.");
    }
    provider = {
      source: "exec",
      command,
      ...(opts.providerArg?.length ? { args: opts.providerArg.map((entry) => entry.trim()) } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(noOutputTimeoutMs !== undefined ? { noOutputTimeoutMs } : {}),
      ...(maxOutputBytes !== undefined ? { maxOutputBytes } : {}),
      ...(opts.providerJsonOnly ? { jsonOnly: true } : {}),
      ...(providerEnv ? { env: providerEnv } : {}),
      ...(opts.providerPassEnv?.length
        ? { passEnv: normalizeStringEntries(opts.providerPassEnv) }
        : {}),
      ...(opts.providerTrustedDir?.length
        ? { trustedDirs: normalizeStringEntries(opts.providerTrustedDir) }
        : {}),
      ...(opts.providerAllowInsecurePath ? { allowInsecurePath: true } : {}),
      ...(opts.providerAllowSymlinkCommand ? { allowSymlinkCommand: true } : {}),
    };
  }

  const validated = SecretProviderSchema.safeParse(provider);
  if (!validated.success) {
    const issue = validated.error.issues[0];
    throw new Error(
      `Provider builder config invalid at ${issue?.path?.join(".") ?? "<provider>"}: ${issue?.message ?? "Invalid provider config."}`,
    );
  }
  return validated.data;
}

function parseSecretRefFromUnknown(value: unknown, label: string): SecretRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object with source/provider/id.`);
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.provider !== "string" ||
    typeof candidate.source !== "string" ||
    typeof candidate.id !== "string"
  ) {
    throw new Error(`${label} must include string fields: source, provider, id.`);
  }
  return parseSecretRefBuilder({
    provider: candidate.provider,
    source: candidate.source,
    id: candidate.id,
    fieldPrefix: label,
  });
}

function parseProviderAliasFromTargetPath(path: PathSegment[]): string | null {
  return path.length >= 3 && path[0] === "secrets" && path[1] === "providers"
    ? (path[2] ?? null)
    : null;
}

function touchesSecretProviderCollection(path: PathSegment[]): boolean {
  return (
    (path.length === 1 && path[0] === "secrets") ||
    (path.length === 2 && path[0] === "secrets" && path[1] === "providers")
  );
}

function touchesSecretDefaults(path: PathSegment[]): boolean {
  return (
    (path.length === 1 && path[0] === "secrets") ||
    (path.length === 2 && path[0] === "secrets" && path[1] === "defaults")
  );
}

function buildRefAssignmentOperation(params: {
  requestedPath: PathSegment[];
  ref: SecretRef;
  inputMode: ConfigSetDryRunInputMode;
}): ConfigSetOperation {
  const resolved = resolveConfigSecretTargetByPath(params.requestedPath);
  if (resolved?.entry.secretShape === "sibling_ref" && resolved.refPathSegments) {
    return {
      inputMode: params.inputMode,
      requestedPath: params.requestedPath,
      setPath: resolved.refPathSegments,
      value: params.ref,
      schemaValidated: true,
      touchedSecretTargetPath: toDotPath(resolved.pathSegments),
      assignedRef: params.ref,
      ...(resolved.providerId ? { touchedProviderAlias: resolved.providerId } : {}),
    };
  }
  return {
    inputMode: params.inputMode,
    requestedPath: params.requestedPath,
    setPath: params.requestedPath,
    value: params.ref,
    ...(resolved ? { schemaValidated: true } : {}),
    touchedSecretTargetPath: toDotPath(resolved?.pathSegments ?? params.requestedPath),
    assignedRef: params.ref,
    ...(resolved?.providerId ? { touchedProviderAlias: resolved.providerId } : {}),
  };
}

function buildValueAssignmentOperation(params: {
  requestedPath: PathSegment[];
  value: unknown;
  inputMode: ConfigSetDryRunInputMode;
}): ConfigSetOperation {
  const resolved = resolveConfigSecretTargetByPath(params.requestedPath);
  const providerAlias = parseProviderAliasFromTargetPath(params.requestedPath);
  const coercedRef = coerceSecretRef(params.value);
  return {
    inputMode: params.inputMode,
    requestedPath: params.requestedPath,
    setPath: params.requestedPath,
    value: params.value,
    ...(resolved ? { touchedSecretTargetPath: toDotPath(resolved.pathSegments) } : {}),
    ...(providerAlias ? { touchedProviderAlias: providerAlias } : {}),
    ...(coercedRef ? { assignedRef: coercedRef } : {}),
  };
}

function parseBatchOperations(entries: ConfigSetBatchEntry[]): ConfigSetOperation[] {
  return entries.map((entry, index) => {
    const path = parseConfigSetPath(entry.path);
    if (entry.ref !== undefined) {
      return buildRefAssignmentOperation({
        requestedPath: path,
        ref: parseSecretRefFromUnknown(entry.ref, `batch[${index}].ref`),
        inputMode: "json",
      });
    }
    if (entry.provider !== undefined) {
      const alias = parseProviderAliasPath(path);
      const validated = SecretProviderSchema.safeParse(entry.provider);
      if (!validated.success) {
        const issue = validated.error.issues[0];
        throw new Error(
          `batch[${index}].provider invalid at ${issue?.path?.join(".") ?? "<provider>"}: ${issue?.message ?? ""}`,
        );
      }
      return {
        inputMode: "json",
        requestedPath: path,
        setPath: path,
        value: validated.data,
        schemaValidated: true,
        touchedProviderAlias: alias,
      };
    }
    return buildValueAssignmentOperation({
      requestedPath: path,
      value: entry.value,
      inputMode: "json",
    });
  });
}

function buildSingleSetOperations(params: {
  path?: string;
  value?: string;
  opts: ConfigSetOptions;
}): ConfigSetOperation[] {
  const pathProvided = typeof params.path === "string" && params.path.trim().length > 0;
  const parsedPath = pathProvided ? parseConfigSetPath(params.path as string) : null;
  const strictJson = Boolean(params.opts.strictJson || params.opts.json);
  const modeResolution = resolveConfigSetMode({
    hasBatchMode: false,
    hasRefBuilderOptions: hasRefBuilderOptions(params.opts),
    hasProviderBuilderOptions: hasProviderBuilderOptions(params.opts),
    strictJson,
  });
  if (!modeResolution.ok) {
    throw modeError(modeResolution.error);
  }

  if (modeResolution.mode === "ref_builder") {
    if (!pathProvided || !parsedPath) {
      throw modeError("ref builder mode requires <path>.");
    }
    if (params.value !== undefined) {
      throw modeError("ref builder mode does not accept <value>.");
    }
    if (!params.opts.refProvider || !params.opts.refSource || !params.opts.refId) {
      throw modeError(
        "ref builder mode requires --ref-provider <alias>, --ref-source <env|file|exec>, and --ref-id <id>.",
      );
    }
    return [
      buildRefAssignmentOperation({
        requestedPath: parsedPath,
        ref: parseSecretRefBuilder({
          provider: params.opts.refProvider,
          source: params.opts.refSource,
          id: params.opts.refId,
          fieldPrefix: "ref",
        }),
        inputMode: "builder",
      }),
    ];
  }

  if (modeResolution.mode === "provider_builder") {
    if (!pathProvided || !parsedPath) {
      throw modeError("provider builder mode requires <path>.");
    }
    if (params.value !== undefined) {
      throw modeError("provider builder mode does not accept <value>.");
    }
    return [
      {
        inputMode: "builder",
        requestedPath: parsedPath,
        setPath: parsedPath,
        value: buildProviderFromBuilder(params.opts),
        schemaValidated: true,
        touchedProviderAlias: parseProviderAliasPath(parsedPath),
      },
    ];
  }

  if (!pathProvided || !parsedPath) {
    throw modeError("value/json mode requires <path> when batch mode is not used.");
  }
  if (params.value === undefined) {
    throw modeError("value/json mode requires <value>.");
  }
  return [
    buildValueAssignmentOperation({
      requestedPath: parsedPath,
      value: parseConfigSetValue(params.value, strictJson),
      inputMode: modeResolution.mode === "json" ? "json" : "value",
    }),
  ];
}

export function buildConfigSetOperations(params: {
  path?: string;
  value?: string;
  opts: ConfigSetOptions;
  batchEntries: ConfigSetBatchEntry[] | null;
}): ConfigSetOperation[] {
  return params.batchEntries
    ? parseBatchOperations(params.batchEntries)
    : buildSingleSetOperations(params);
}

async function readStdinText(): Promise<string> {
  if (process.stdin.isTTY) {
    throw configPatchModeError(
      "--stdin refuses to read from an interactive terminal; pipe input or use --file <path>.",
    );
  }
  process.stdin.setEncoding("utf8");
  const bytes = await readByteStreamWithLimit(process.stdin, {
    maxBytes: CONFIG_PATCH_STDIN_MAX_BYTES,
    onOverflow: ({ maxBytes }) =>
      configPatchModeError(
        `--stdin input exceeds ${maxBytes} bytes; use --file <path> for larger patches.`,
      ),
  });
  return bytes.toString("utf8");
}

async function readConfigPatchInput(opts: ConfigPatchOptions): Promise<unknown> {
  const file = normalizeOptionalString(opts.file);
  const stdin = Boolean(opts.stdin);
  if (Boolean(file) === stdin) {
    throw configPatchModeError("provide exactly one of --file <path> or --stdin.");
  }
  const sourceLabel = stdin ? "--stdin" : "--file";
  let raw: string;
  if (stdin) {
    raw = await readStdinText();
  } else {
    try {
      raw = readConfigMutationFileSync(file as string, "--file");
    } catch (err) {
      if (hasErrnoCode(err, "ENOENT")) {
        throw new Error(`--file not found: ${file}`, { cause: err });
      }
      throw err;
    }
  }
  try {
    return JSON5.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse ${sourceLabel} as JSON5: ${String(err)}`, { cause: err });
  }
}

function buildDeleteOperation(path: PathSegment[]): ConfigSetOperation {
  return {
    inputMode: "json",
    requestedPath: path,
    setPath: path,
    value: undefined,
    mutation: "delete",
  };
}

export function buildUnsetOperation(path: PathSegment[]): ConfigSetOperation {
  const resolved = resolveConfigSecretTargetByPath(path);
  const providerAlias = parseProviderAliasFromTargetPath(path);
  return {
    inputMode: "unset",
    requestedPath: path,
    setPath: path,
    value: undefined,
    mutation: "delete",
    ...(touchesSecretProviderCollection(path) || touchesSecretDefaults(path)
      ? { touchesAllSecretRefs: true }
      : {}),
    ...(resolved ? { touchedSecretTargetPath: toDotPath(resolved.pathSegments) } : {}),
    ...(providerAlias ? { touchedProviderAlias: providerAlias } : {}),
  };
}

function buildApplyValueOperation(params: {
  path: PathSegment[];
  value: unknown;
  mutation?: ConfigSetOperation["mutation"];
}): ConfigSetOperation {
  const ref = isPlainRecord(params.value) ? coerceSecretRef(params.value) : null;
  const operation = ref
    ? buildRefAssignmentOperation({
        requestedPath: params.path,
        ref: parseSecretRefFromUnknown(params.value, `patch.${toDotPath(params.path)}`),
        inputMode: "json",
      })
    : buildValueAssignmentOperation({
        requestedPath: params.path,
        value: params.value,
        inputMode: "json",
      });
  return { ...operation, ...(params.mutation ? { mutation: params.mutation } : {}) };
}

function buildConfigPatchOperations(params: {
  patch: unknown;
  replacePaths: PathSegment[][];
}): ConfigSetOperation[] {
  if (!isPlainRecord(params.patch)) {
    throw configPatchModeError("input must be a JSON5 object patch.");
  }
  const operations: ConfigSetOperation[] = [];
  const pathKey = (path: PathSegment[]) => JSON.stringify(path);
  const replacePathKeys = new Set(params.replacePaths.map(pathKey));
  const matchedReplacePathKeys = new Set<string>();
  const visit = (value: unknown, path: PathSegment[]) => {
    validatePathSegments(path);
    const replacementKey = pathKey(path);
    if (path.length > 0 && replacePathKeys.has(replacementKey)) {
      matchedReplacePathKeys.add(replacementKey);
      operations.push(
        value === null
          ? buildDeleteOperation(path)
          : buildApplyValueOperation({ path, value, mutation: "replace" }),
      );
      return;
    }
    if (path.length > 0 && value === null) {
      operations.push(buildDeleteOperation(path));
      return;
    }
    if (path.length > 0 && isPlainRecord(value) && coerceSecretRef(value)) {
      operations.push(buildApplyValueOperation({ path, value }));
      return;
    }
    if (isPlainRecord(value)) {
      if (path.length > 0 && Object.keys(value).length === 0) {
        operations.push(buildApplyValueOperation({ path, value, mutation: "merge" }));
        return;
      }
      for (const [key, child] of Object.entries(value)) {
        visit(child, [...path, key]);
      }
      return;
    }
    if (path.length === 0) {
      throw configPatchModeError("input must contain at least one config key.");
    }
    operations.push(buildApplyValueOperation({ path, value }));
  };

  visit(params.patch, []);
  const unusedReplacePath = params.replacePaths.find(
    (path) => !matchedReplacePathKeys.has(pathKey(path)),
  );
  if (unusedReplacePath) {
    throw configPatchModeError(
      `--replace-path ${toDotPath(unusedReplacePath)} did not match any value in the input patch.`,
    );
  }
  if (operations.length === 0) {
    throw configPatchModeError("input patch did not contain any config updates.");
  }
  return operations;
}

export async function readConfigPatchOperations(
  opts: ConfigPatchOptions,
): Promise<ConfigSetOperation[]> {
  return buildConfigPatchOperations({
    patch: await readConfigPatchInput(opts),
    replacePaths: (opts.replacePath ?? []).map(parseConfigSetPath),
  });
}

export function formatPluginInstallConfigSetError(): string {
  return [
    "plugins.installs is managed by the plugin index and cannot be edited with config set.",
    "",
    "Use plugin commands instead:",
    `  ${formatCliCommand("openclaw plugins install <spec>")}`,
    `  ${formatCliCommand("openclaw plugins update <plugin-id>")}`,
    `  ${formatCliCommand("openclaw plugins uninstall <plugin-id>")}`,
  ].join("\n");
}
