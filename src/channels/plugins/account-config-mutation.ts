import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { err as resultError, ok, type Result } from "@openclaw/normalization-core/result";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../routing/session-key.js";
import type { RuntimeEnv } from "../../runtime.js";
import {
  resolveChannelSetupExecutionAdapter,
  type ChannelSetupFieldMetadata,
} from "./setup-contract.js";
import { moveSingleAccountChannelSectionToDefaultAccount } from "./setup-helpers.js";
import type { ChannelSetupAdapter } from "./types.adapters.js";
import type { ChannelPlugin } from "./types.plugin.js";
import type { ChannelId } from "./types.public.js";

export type ChannelAccountMutationPlugin = Pick<
  ChannelPlugin,
  "id" | "meta" | "config" | "setup" | "setupContract" | "gateway" | "lifecycle"
>;

type ChannelSetupExecutionAdapter = NonNullable<
  ReturnType<typeof resolveChannelSetupExecutionAdapter>
>;

type ChannelAccountConfigurationError =
  | { kind: "unsupported" }
  | { kind: "invalid-input"; message: string };

type PreparedChannelAccountConfiguration = {
  plugin: ChannelAccountMutationPlugin;
  setup: ChannelSetupExecutionAdapter;
  applyAccountConfig: NonNullable<ChannelSetupExecutionAdapter["applyAccountConfig"]>;
  accountId: string;
  input: unknown;
};

function resolveMissingSetupEnvMessage(
  plugin: ChannelAccountMutationPlugin,
  input: unknown,
): string | undefined {
  if (!plugin.setupContract || !isRecord(input) || input.useEnv !== true) {
    return undefined;
  }
  const useEnvField = plugin.setupContract.metadata.fields.find(
    (field): field is Extract<ChannelSetupFieldMetadata, { kind: "boolean" }> =>
      field.kind === "boolean" && field.key === "useEnv",
  );
  if (!useEnvField?.envVars?.length) {
    return undefined;
  }
  const { envVars, envVarMode } = useEnvField;
  const missing = envVars.filter((name) => !process.env[name]?.trim());
  const ready = envVarMode === "any" ? missing.length < envVars.length : !missing.length;
  if (ready) {
    return undefined;
  }
  return envVarMode === "any"
    ? `Set one of these environment variables before using --use-env: ${missing.join(", ")}.`
    : `Set these environment variables before using --use-env: ${missing.join(", ")}.`;
}

export async function prepareChannelAccountConfiguration(params: {
  cfg: OpenClawConfig;
  plugin: ChannelAccountMutationPlugin;
  requestedAccountId?: string;
  resolveInput: () => unknown;
  runtime: RuntimeEnv;
  beforePersistentEffect?: () => Promise<void>;
}): Promise<Result<PreparedChannelAccountConfiguration, ChannelAccountConfigurationError>> {
  const setup = resolveChannelSetupExecutionAdapter(params.plugin);
  if (!setup?.applyAccountConfig) {
    return resultError({ kind: "unsupported" });
  }

  // Input resolution can perform plugin-owned reads. Keep it behind setup
  // capability discovery so unsupported channels retain their existing failure path.
  const rawInput = params.resolveInput();
  let input: unknown;
  if (params.plugin.setupContract) {
    const parsed = params.plugin.setupContract.parseInput(rawInput);
    if (!parsed.ok) {
      return resultError({ kind: "invalid-input", message: parsed.error });
    }
    input = parsed.value;
  } else {
    input = rawInput;
  }

  const accountId =
    setup.resolveAccountId?.({
      cfg: params.cfg,
      accountId: params.requestedAccountId,
      input,
    }) ?? normalizeAccountId(params.requestedAccountId);
  if (setup.prepareAccountConfigInput) {
    await params.beforePersistentEffect?.();
    input = await setup.prepareAccountConfigInput({
      cfg: params.cfg,
      accountId,
      input,
      runtime: params.runtime,
    });
  }

  const validationError = setup.validateInput?.({
    cfg: params.cfg,
    accountId,
    input,
  });
  if (validationError) {
    return resultError({ kind: "invalid-input", message: validationError });
  }
  const missingEnvMessage = resolveMissingSetupEnvMessage(params.plugin, input);
  if (missingEnvMessage) {
    return resultError({ kind: "invalid-input", message: missingEnvMessage });
  }

  return ok({
    plugin: params.plugin,
    setup,
    applyAccountConfig: setup.applyAccountConfig,
    accountId,
    input,
  });
}

export async function applyPreparedChannelAccountConfiguration(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  prepared: PreparedChannelAccountConfiguration;
  runtime: RuntimeEnv;
  beforePersistentEffect?: () => Promise<void>;
}): Promise<{
  nextConfig: OpenClawConfig;
  accountId: string;
  input: unknown;
  afterAccountConfigWritten?: ChannelSetupExecutionAdapter["afterAccountConfigWritten"];
}> {
  const { accountId, applyAccountConfig, input, plugin, setup } = params.prepared;
  const configAccountId = normalizeAccountId(accountId);
  let nextConfig = params.cfg;
  if (accountId !== DEFAULT_ACCOUNT_ID) {
    nextConfig = moveSingleAccountChannelSectionToDefaultAccount({
      cfg: nextConfig,
      channelKey: params.channel,
      setupSurface: setup as ChannelSetupAdapter,
    });
  }
  nextConfig = applyAccountConfig({
    cfg: nextConfig,
    accountId: configAccountId,
    input,
  });

  // Lifecycle hooks can mutate owner state. The command supplies an authority
  // check while retaining responsibility for the later config commit.
  if (plugin.lifecycle?.onAccountConfigChanged) {
    await params.beforePersistentEffect?.();
    await plugin.lifecycle.onAccountConfigChanged({
      prevCfg: params.cfg,
      nextCfg: nextConfig,
      accountId,
      runtime: params.runtime,
    });
  }

  return {
    nextConfig,
    accountId,
    input,
    ...(setup.afterAccountConfigWritten
      ? { afterAccountConfigWritten: setup.afterAccountConfigWritten }
      : {}),
  };
}

type ChannelAccountRemovalAction = "delete" | "disable";

type PreparedChannelAccountRemoval = {
  plugin: ChannelAccountMutationPlugin;
  action: ChannelAccountRemovalAction;
  accountId: string;
  accountKey: string;
  shouldStopRuntime: boolean;
};

type ChannelAccountRemovalError = {
  kind: "unsupported-action";
  action: ChannelAccountRemovalAction;
};

export function prepareChannelAccountRemoval(params: {
  plugin: ChannelAccountMutationPlugin;
  accountId?: string;
  action: ChannelAccountRemovalAction;
}): PreparedChannelAccountRemoval {
  // normalizeAccountId maps omitted values to the literal default account, so
  // the command's former nullish plugin-default fallback was unreachable.
  const accountId = normalizeAccountId(params.accountId);
  return {
    plugin: params.plugin,
    action: params.action,
    accountId,
    accountKey: accountId || DEFAULT_ACCOUNT_ID,
    shouldStopRuntime: Boolean(
      params.plugin.gateway?.startAccount || params.plugin.gateway?.logoutAccount,
    ),
  };
}

export async function applyPreparedChannelAccountRemoval(params: {
  cfg: OpenClawConfig;
  prepared: PreparedChannelAccountRemoval;
  runtime: RuntimeEnv;
}): Promise<Result<{ nextConfig: OpenClawConfig }, ChannelAccountRemovalError>> {
  const { accountId, action, plugin } = params.prepared;
  // Capability validation stays in apply: callers must preserve the historical
  // runtime-stop ordering before reporting an unsupported mutation.
  if (action === "delete") {
    if (!plugin.config.deleteAccount) {
      return resultError({ kind: "unsupported-action", action });
    }
    const nextConfig = plugin.config.deleteAccount({
      cfg: { ...params.cfg },
      accountId,
    });
    await plugin.lifecycle?.onAccountRemoved?.({
      prevCfg: params.cfg,
      accountId,
      runtime: params.runtime,
    });
    return ok({ nextConfig });
  }

  if (!plugin.config.setAccountEnabled) {
    return resultError({ kind: "unsupported-action", action });
  }
  const nextConfig = plugin.config.setAccountEnabled({
    cfg: { ...params.cfg },
    accountId,
    enabled: false,
  });
  await plugin.lifecycle?.onAccountConfigChanged?.({
    prevCfg: params.cfg,
    nextCfg: nextConfig,
    accountId,
    runtime: params.runtime,
  });
  return ok({ nextConfig });
}
