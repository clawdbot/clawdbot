import { Option } from "commander";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { parseStrictNonNegativeInteger } from "../../infra/parse-finite-number.js";
import type { RuntimeEnv } from "../../runtime.js";
import type { ChannelSetupInput } from "./setup-input.js";

type ChannelSetupCliOption = {
  flags: string;
  negatedFlags?: string;
  description: string;
  defaultValue?: boolean | string;
};

type ChannelSetupStringField = {
  kind: "string";
  sensitive?: boolean;
  cli: ChannelSetupCliOption;
};

type ChannelSetupBooleanField = {
  kind: "boolean";
  cli: ChannelSetupCliOption;
};

type ChannelSetupIntegerField = {
  kind: "integer";
  cli: ChannelSetupCliOption;
};

type ChannelSetupStringListField = {
  kind: "string-list";
  sensitive?: boolean;
  cli: ChannelSetupCliOption;
};

type ChannelSetupChoiceField<Choices extends readonly string[] = readonly string[]> = {
  kind: "choice";
  choices: Choices;
  cli: ChannelSetupCliOption;
};

type ChannelSetupField =
  | ChannelSetupStringField
  | ChannelSetupBooleanField
  | ChannelSetupIntegerField
  | ChannelSetupStringListField
  | ChannelSetupChoiceField;

export type ChannelSetupFieldMetadata = ChannelSetupField & {
  key: string;
};

export type ChannelSetupMetadata = {
  fields: readonly ChannelSetupFieldMetadata[];
};

export function resolveChannelSetupFieldCliAttributeName(flags: string): string | undefined {
  const option = new Option(flags);
  return option.long ? option.attributeName() : undefined;
}

function assertChannelSetupFieldCliAttributeName(key: string, flags: string): void {
  let attributeName: string | undefined;
  try {
    attributeName = resolveChannelSetupFieldCliAttributeName(flags);
  } catch {
    throw new Error(`Channel setup field "${key}" has invalid CLI flags "${flags}".`);
  }
  if (!attributeName) {
    throw new Error(`Channel setup field "${key}" must declare a long CLI flag.`);
  }
  if (attributeName !== key) {
    throw new Error(
      `Channel setup field "${key}" must match camelCased long flag name "${attributeName}" from "${flags}".`,
    );
  }
}

type ChannelSetupFieldValue<Field extends ChannelSetupField> = Field extends {
  kind: "boolean";
}
  ? boolean
  : Field extends { kind: "integer" }
    ? number
    : Field extends { kind: "string-list" }
      ? string[]
      : Field extends { kind: "choice"; choices: infer Choices extends readonly string[] }
        ? Choices[number]
        : string;

type ChannelSetupInputForFields<Fields extends Record<string, ChannelSetupField>> = {
  name?: string;
} & {
  [Key in keyof Fields]?: ChannelSetupFieldValue<Fields[Key]>;
};

type ChannelSetupParseResult = { ok: true; value: unknown } | { ok: false; error: string };

type ChannelSetupContractAdapterParams<Fields extends Record<string, ChannelSetupField>> =
  | {
      adapter: ChannelOwnedSetupAdapterShape<ChannelSetupInputForFields<Fields>>;
      legacyAdapter?: never;
    }
  | {
      adapter?: never;
      legacyAdapter: ChannelOwnedSetupAdapterShape<ChannelSetupInput>;
    };

type ChannelOwnedSetupAdapterShape<Input extends { name?: string }> = {
  resolveAccountId?: (params: { cfg: OpenClawConfig; accountId?: string; input?: Input }) => string;
  prepareAccountConfigInput?: (params: {
    cfg: OpenClawConfig;
    accountId: string;
    input: Input;
    runtime: RuntimeEnv;
  }) => Promise<Input> | Input;
  resolveBindingAccountId?: (params: {
    cfg: OpenClawConfig;
    agentId: string;
    accountId?: string;
  }) => string | undefined;
  applyAccountName?: (params: {
    cfg: OpenClawConfig;
    accountId: string;
    name?: string;
  }) => OpenClawConfig;
  applyAccountConfig: (params: {
    cfg: OpenClawConfig;
    accountId: string;
    input: Input;
  }) => OpenClawConfig;
  afterAccountConfigWritten?: (params: {
    previousCfg: OpenClawConfig;
    cfg: OpenClawConfig;
    accountId: string;
    input: Input;
    runtime: RuntimeEnv;
  }) => Promise<void> | void;
  validateInput?: (params: {
    cfg: OpenClawConfig;
    accountId: string;
    input: Input;
  }) => string | null;
  singleAccountKeysToMove?: readonly string[];
  namedAccountPromotionKeys?: readonly string[];
  resolveSingleAccountPromotionTarget?: (params: {
    channel: Record<string, unknown>;
  }) => string | undefined;
};

export type ChannelOwnedSetupContract = {
  kind: "channel-owned";
  metadata: ChannelSetupMetadata;
  parseInput: (input: unknown) => ChannelSetupParseResult;
  resolveAccountId?: (params: {
    cfg: OpenClawConfig;
    accountId?: string;
    input?: unknown;
  }) => string;
  prepareAccountConfigInput?: (params: {
    cfg: OpenClawConfig;
    accountId: string;
    input: unknown;
    runtime: RuntimeEnv;
  }) => Promise<object> | object;
  resolveBindingAccountId?: ChannelOwnedSetupAdapterShape<{
    name?: string;
  }>["resolveBindingAccountId"];
  applyAccountName?: ChannelOwnedSetupAdapterShape<{ name?: string }>["applyAccountName"];
  applyAccountConfig: (params: {
    cfg: OpenClawConfig;
    accountId: string;
    input: unknown;
  }) => OpenClawConfig;
  afterAccountConfigWritten?: (params: {
    previousCfg: OpenClawConfig;
    cfg: OpenClawConfig;
    accountId: string;
    input: unknown;
    runtime: RuntimeEnv;
  }) => Promise<void> | void;
  validateInput?: (params: {
    cfg: OpenClawConfig;
    accountId: string;
    input: unknown;
  }) => string | null;
  singleAccountKeysToMove?: readonly string[];
  namedAccountPromotionKeys?: readonly string[];
  resolveSingleAccountPromotionTarget?: ChannelOwnedSetupAdapterShape<{
    name?: string;
  }>["resolveSingleAccountPromotionTarget"];
};

type ChannelSetupExecutionAdapter = Omit<
  ChannelOwnedSetupContract,
  "kind" | "metadata" | "parseInput"
>;

/** Adapts the released shared-bag contract at one explicit compatibility boundary. */
export function resolveChannelSetupExecutionAdapter(plugin: {
  setupContract?: ChannelOwnedSetupContract;
  setup?: ChannelOwnedSetupAdapterShape<ChannelSetupInput>;
}): ChannelSetupExecutionAdapter | undefined {
  if (plugin.setupContract) {
    return plugin.setupContract;
  }
  const legacy = plugin.setup;
  if (!legacy) {
    return undefined;
  }
  const legacyInput = (input: unknown): ChannelSetupInput => input as ChannelSetupInput;
  const prepareAccountConfigInput = legacy.prepareAccountConfigInput;
  return {
    ...(legacy.resolveAccountId
      ? {
          resolveAccountId: (params) =>
            legacy.resolveAccountId?.({ ...params, input: legacyInput(params.input) }) ??
            params.accountId ??
            "default",
        }
      : {}),
    ...(prepareAccountConfigInput
      ? {
          prepareAccountConfigInput: (params) =>
            prepareAccountConfigInput({
              ...params,
              input: legacyInput(params.input),
            }),
        }
      : {}),
    resolveBindingAccountId: legacy.resolveBindingAccountId,
    applyAccountName: legacy.applyAccountName,
    applyAccountConfig: (params) =>
      legacy.applyAccountConfig({ ...params, input: legacyInput(params.input) }),
    ...(legacy.afterAccountConfigWritten
      ? {
          afterAccountConfigWritten: (params) =>
            legacy.afterAccountConfigWritten?.({
              ...params,
              input: legacyInput(params.input),
            }),
        }
      : {}),
    ...(legacy.validateInput
      ? {
          validateInput: (params) =>
            legacy.validateInput?.({ ...params, input: legacyInput(params.input) }) ?? null,
        }
      : {}),
    singleAccountKeysToMove: legacy.singleAccountKeysToMove,
    namedAccountPromotionKeys: legacy.namedAccountPromotionKeys,
    resolveSingleAccountPromotionTarget: legacy.resolveSingleAccountPromotionTarget,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseStringList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return value.every((entry) => typeof entry === "string") ? value : undefined;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  return value
    .split(/[\n,]/u)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseFieldValue(
  key: string,
  field: ChannelSetupField,
  value: unknown,
): { ok: true; value: unknown } | { ok: false; error: string } {
  if (field.kind === "string") {
    return typeof value === "string"
      ? { ok: true, value }
      : { ok: false, error: `${key} must be a string.` };
  }
  if (field.kind === "boolean") {
    return typeof value === "boolean"
      ? { ok: true, value }
      : { ok: false, error: `${key} must be true or false.` };
  }
  if (field.kind === "integer") {
    const parsed = parseStrictNonNegativeInteger(value);
    return parsed === undefined
      ? { ok: false, error: `${key} must be a non-negative integer.` }
      : { ok: true, value: parsed };
  }
  if (field.kind === "string-list") {
    const parsed = parseStringList(value);
    return parsed
      ? { ok: true, value: parsed }
      : { ok: false, error: `${key} must be a comma-separated list of strings.` };
  }
  if (typeof value !== "string" || !field.choices.includes(value)) {
    return {
      ok: false,
      error: `${key} must be one of: ${field.choices.map((choice) => JSON.stringify(choice)).join(", ")}.`,
    };
  }
  return { ok: true, value };
}

function parseSetupInput<Fields extends Record<string, ChannelSetupField>>(
  fields: Fields,
  rawInput: unknown,
): { ok: true; value: ChannelSetupInputForFields<Fields> } | { ok: false; error: string } {
  if (!isRecord(rawInput)) {
    return { ok: false, error: "Channel setup input must be an object." };
  }
  const value: Record<string, unknown> = {};
  for (const [key, rawValue] of Object.entries(rawInput)) {
    if (rawValue === undefined) {
      continue;
    }
    if (key === "name") {
      if (typeof rawValue !== "string") {
        return { ok: false, error: "name must be a string." };
      }
      value.name = rawValue;
      continue;
    }
    const field = fields[key];
    if (!field) {
      return { ok: false, error: `Unsupported setup option: ${key}` };
    }
    const parsed = parseFieldValue(key, field, rawValue);
    if (!parsed.ok) {
      return parsed;
    }
    value[key] = parsed.value;
  }
  // Every property was checked against the field map above. This assertion is
  // the single dynamic-object boundary; plugin callbacks remain fully typed.
  return { ok: true, value: value as ChannelSetupInputForFields<Fields> };
}

function requireParsedInput<Fields extends Record<string, ChannelSetupField>>(
  fields: Fields,
  input: unknown,
): ChannelSetupInputForFields<Fields> {
  const parsed = parseSetupInput(fields, input);
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  return parsed.value;
}

export function defineChannelSetupContract<const Fields extends Record<string, ChannelSetupField>>(
  params: { fields: Fields } & ChannelSetupContractAdapterParams<Fields>,
): ChannelOwnedSetupContract {
  const { fields } = params;
  const fieldEntries = Object.entries(fields);
  // The field key crosses serialized projections, Commander parsing, and parseInput.
  // Match Commander's attribute name so all three stay aligned by construction.
  for (const [key, field] of fieldEntries) {
    assertChannelSetupFieldCliAttributeName(key, field.cli.flags);
    if (field.cli.negatedFlags) {
      assertChannelSetupFieldCliAttributeName(key, field.cli.negatedFlags);
    }
  }
  const adapter =
    params.adapter ??
    (params.legacyAdapter as ChannelOwnedSetupAdapterShape<ChannelSetupInputForFields<Fields>>);
  const prepareAccountConfigInput = adapter.prepareAccountConfigInput;
  const metadata: ChannelSetupMetadata = {
    fields: fieldEntries.map(([key, field]) => Object.assign({}, field, { key })),
  };
  return {
    kind: "channel-owned",
    metadata,
    parseInput: (input) => parseSetupInput(fields, input),
    ...(adapter.resolveAccountId
      ? {
          resolveAccountId: (inputParams) =>
            adapter.resolveAccountId?.({
              ...inputParams,
              input: requireParsedInput(fields, inputParams.input ?? {}),
            }) ??
            inputParams.accountId ??
            "default",
        }
      : {}),
    ...(prepareAccountConfigInput
      ? {
          prepareAccountConfigInput: async (inputParams) =>
            await prepareAccountConfigInput({
              ...inputParams,
              input: requireParsedInput(fields, inputParams.input),
            }),
        }
      : {}),
    resolveBindingAccountId: adapter.resolveBindingAccountId,
    applyAccountName: adapter.applyAccountName,
    applyAccountConfig: (inputParams) =>
      adapter.applyAccountConfig({
        ...inputParams,
        input: requireParsedInput(fields, inputParams.input),
      }),
    ...(adapter.afterAccountConfigWritten
      ? {
          afterAccountConfigWritten: (inputParams) =>
            adapter.afterAccountConfigWritten?.({
              ...inputParams,
              input: requireParsedInput(fields, inputParams.input),
            }),
        }
      : {}),
    ...(adapter.validateInput
      ? {
          validateInput: (inputParams) => {
            const parsed = parseSetupInput(fields, inputParams.input);
            if (!parsed.ok) {
              return parsed.error;
            }
            return adapter.validateInput?.({ ...inputParams, input: parsed.value }) ?? null;
          },
        }
      : {}),
    singleAccountKeysToMove: adapter.singleAccountKeysToMove,
    namedAccountPromotionKeys: adapter.namedAccountPromotionKeys,
    resolveSingleAccountPromotionTarget: adapter.resolveSingleAccountPromotionTarget,
  };
}
