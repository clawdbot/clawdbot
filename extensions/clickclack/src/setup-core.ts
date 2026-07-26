// ClickClack plugin module implements non-interactive setup behavior.
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import {
  defineChannelSetupContract,
  type ChannelSetupAdapter,
  type ChannelSetupInput,
} from "openclaw/plugin-sdk/channel-setup";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  applyAccountNameToChannelSection,
  applySetupAccountConfigPatch,
  migrateBaseNameToDefaultAccount,
  moveSingleAccountChannelSectionToDefaultAccount,
} from "openclaw/plugin-sdk/setup";
import { createSetupInputPresenceValidator } from "openclaw/plugin-sdk/setup-runtime";
import { resolveClickClackAccountConfig } from "./accounts.js";
import {
  buildClickClackSetupClaimUrl,
  CLICKCLACK_SETUP_CODE_CLAIM_PATH,
  requireClickClackSetupClaimUrl,
} from "./setup-contract.js";
import type { CoreConfig } from "./types.js";

const channel = "clickclack" as const;
const SETUP_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const SETUP_CODE_LENGTH = 12;
const REQUIRED_INPUT_ERROR =
  "ClickClack requires --token, --base-url, and --workspace (or --use-env).";
const INVALID_BASE_URL_ERROR = "ClickClack base URL must be a valid http(s) URL.";
const SETUP_CODE_CONFLICT_ERROR =
  "ClickClack --code cannot be combined with --token, --token-file, or --use-env.";

type ClickClackSetupInput = ChannelSetupInput & {
  baseUrl?: string;
  code?: string;
  workspace?: string;
  agentActivity?: boolean;
};

export function normalizeClickClackBaseUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}

function normalizeClickClackSetupCode(value: string): string | undefined {
  const normalized = value.trim().toUpperCase().replaceAll("-", "").replaceAll(" ", "");
  if (
    normalized.length !== SETUP_CODE_LENGTH ||
    Array.from(normalized).some((character) => !SETUP_CODE_ALPHABET.includes(character))
  ) {
    return undefined;
  }
  return normalized;
}

function requireClickClackSetupCodeBaseUrl(value: string | undefined): string {
  const baseUrl = normalizeClickClackBaseUrl(value);
  if (!baseUrl) {
    throw new Error("ClickClack setup codes require a valid HTTP(S) base URL.");
  }
  return baseUrl;
}

function parseClickClackSetupCodeInput(params: { code: string; baseUrl?: string }): {
  code: string;
  baseUrl: string;
  exactClaimUrl?: string;
} {
  const rawCode = params.code.trim();
  if (!rawCode) {
    throw new Error("ClickClack --code must not be empty.");
  }

  let code = rawCode;
  let baseUrl: string;
  if (/^[a-z][a-z\d+.-]*:\/\//iu.test(rawCode)) {
    let setupUrl: URL;
    try {
      setupUrl = new URL(rawCode);
    } catch {
      throw new Error("ClickClack --code must be a valid HTTP(S) setup URL or a bare setup code.");
    }
    if (setupUrl.protocol !== "http:" && setupUrl.protocol !== "https:") {
      throw new Error("ClickClack setup codes require an HTTP(S) URL.");
    }
    if (setupUrl.username || setupUrl.password) {
      throw new Error("ClickClack setup URLs must not include credentials.");
    }
    if (setupUrl.search) {
      throw new Error("ClickClack setup URLs must not include a query.");
    }
    code = setupUrl.hash.slice(1);
    if (!code) {
      throw new Error("ClickClack setup URL is missing its #CODE fragment.");
    }
    setupUrl.hash = "";
    let exactClaimUrl: string | undefined;
    if (setupUrl.pathname.endsWith(CLICKCLACK_SETUP_CODE_CLAIM_PATH)) {
      const exactEndpoint = requireClickClackSetupClaimUrl(setupUrl.toString());
      baseUrl = exactEndpoint.apiBaseUrl;
      exactClaimUrl = exactEndpoint.claimUrl;
    } else {
      baseUrl = requireClickClackSetupCodeBaseUrl(setupUrl.toString());
    }
    if (params.baseUrl) {
      const suppliedBaseUrl = requireClickClackSetupCodeBaseUrl(params.baseUrl);
      if (suppliedBaseUrl !== baseUrl) {
        throw new Error("ClickClack --base-url does not match the server in the setup-code URL.");
      }
    }
    const normalizedCode = normalizeClickClackSetupCode(code);
    if (!normalizedCode) {
      throw new Error("ClickClack setup code must contain 12 valid base32 characters.");
    }
    return { code: normalizedCode, baseUrl, ...(exactClaimUrl ? { exactClaimUrl } : {}) };
  }

  code = code.startsWith("#") ? code.slice(1) : code;
  if (!params.baseUrl) {
    throw new Error("A bare ClickClack setup code requires --base-url.");
  }
  baseUrl = requireClickClackSetupCodeBaseUrl(params.baseUrl);

  const normalizedCode = normalizeClickClackSetupCode(code);
  if (!normalizedCode) {
    throw new Error("ClickClack setup code must contain 12 valid base32 characters.");
  }
  return { code: normalizedCode, baseUrl };
}

function formatClickClackSetupCodeClaimError(error: unknown): Error {
  if (typeof error === "object" && error !== null && "status" in error) {
    const status = (error as { status?: unknown }).status;
    if (status === 404) {
      return new Error(
        "ClickClack setup code is invalid, expired, or already used. Generate a new code and try again.",
      );
    }
    if (status === 429) {
      return new Error("Too many ClickClack setup code attempts. Wait and try again.");
    }
  }
  return new Error(`Could not claim ClickClack setup code: ${formatErrorMessage(error)}`);
}

export function applyClickClackSetupConfigPatch(params: {
  cfg: OpenClawConfig;
  accountId: string;
  name?: string;
  patch: Record<string, unknown>;
}): OpenClawConfig {
  const accountId = normalizeAccountId(params.accountId);
  const scopedConfig =
    accountId === DEFAULT_ACCOUNT_ID
      ? params.cfg
      : moveSingleAccountChannelSectionToDefaultAccount({
          cfg: params.cfg,
          channelKey: channel,
          setupSurface: clickClackSetupAdapter,
        });
  const namedConfig = applyAccountNameToChannelSection({
    cfg: scopedConfig,
    channelKey: channel,
    accountId,
    name: params.name,
  });
  const next =
    accountId !== DEFAULT_ACCOUNT_ID
      ? migrateBaseNameToDefaultAccount({
          cfg: namedConfig,
          channelKey: channel,
        })
      : namedConfig;
  return applySetupAccountConfigPatch({
    cfg: next,
    channelKey: channel,
    accountId,
    patch: params.patch,
  });
}

function clearClickClackSetupConfigFields(params: {
  cfg: OpenClawConfig;
  accountId: string;
  fields: string[];
}): OpenClawConfig {
  const clickclack = (params.cfg.channels as Record<string, unknown> | undefined)?.clickclack as
    | (Record<string, unknown> & { accounts?: Record<string, Record<string, unknown>> })
    | undefined;
  if (!clickclack) {
    return params.cfg;
  }
  const accountId = normalizeAccountId(params.accountId);
  if (accountId === DEFAULT_ACCOUNT_ID) {
    const nextClickClack = { ...clickclack };
    for (const field of params.fields) {
      delete nextClickClack[field];
    }
    return {
      ...params.cfg,
      channels: {
        ...params.cfg.channels,
        clickclack: nextClickClack,
      },
    } as OpenClawConfig;
  }
  const currentAccount = clickclack.accounts?.[accountId];
  if (!currentAccount) {
    return params.cfg;
  }
  const nextAccount = { ...currentAccount };
  for (const field of params.fields) {
    delete nextAccount[field];
  }
  return {
    ...params.cfg,
    channels: {
      ...params.cfg.channels,
      clickclack: {
        ...clickclack,
        accounts: {
          ...clickclack.accounts,
          [accountId]: nextAccount,
        },
      },
    },
  } as OpenClawConfig;
}

export function applyClickClackCredentialConfig(params: {
  cfg: OpenClawConfig;
  accountId: string;
  token?: unknown;
  tokenFile?: string;
  useEnv?: boolean;
}): OpenClawConfig {
  const fieldsToClear = params.useEnv
    ? ["token", "tokenFile"]
    : params.tokenFile
      ? ["token"]
      : params.token !== undefined
        ? ["tokenFile"]
        : [];
  const next = applyClickClackSetupConfigPatch({
    cfg: params.cfg,
    accountId: params.accountId,
    patch: params.useEnv
      ? {}
      : params.tokenFile
        ? { tokenFile: params.tokenFile }
        : params.token !== undefined
          ? { token: params.token }
          : {},
  });
  return clearClickClackSetupConfigFields({
    cfg: next,
    accountId: params.accountId,
    fields: fieldsToClear,
  });
}

export const clickClackSetupAdapter: ChannelSetupAdapter = {
  resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
  prepareAccountConfigInput: async ({ cfg, accountId, input }) => {
    const setupInput = input as ClickClackSetupInput;
    if (!setupInput.code?.trim()) {
      return setupInput;
    }
    if (setupInput.token?.trim() || setupInput.tokenFile?.trim() || setupInput.useEnv) {
      throw new Error(SETUP_CODE_CONFLICT_ERROR);
    }
    let setup = parseClickClackSetupCodeInput({
      code: setupInput.code,
      baseUrl: setupInput.baseUrl,
    });
    const existing = resolveClickClackAccountConfig(cfg as CoreConfig, accountId);
    const privateApiBaseUrl = normalizeClickClackBaseUrl(existing.apiBaseUrl);
    const claimUrl =
      setup.exactClaimUrl && !privateApiBaseUrl
        ? setup.exactClaimUrl
        : buildClickClackSetupClaimUrl(privateApiBaseUrl ?? setup.baseUrl);
    let claim;
    try {
      const { claimClickClackSetupCode } = await import("./setup-claim.js");
      claim = await claimClickClackSetupCode({
        claimUrl,
        code: setup.code,
        ...(setup.exactClaimUrl ? { expectedClaimUrl: setup.exactClaimUrl } : {}),
      });
    } catch (error) {
      throw formatClickClackSetupCodeClaimError(error);
    }
    setup = { ...setup, baseUrl: claim.api_base_url ?? setup.baseUrl };
    const { code: _code, tokenFile: _tokenFile, useEnv: _useEnv, ...remainingInput } = setupInput;
    return {
      ...remainingInput,
      baseUrl: setup.baseUrl,
      token: claim.token,
      workspace: claim.workspace.id,
      ...(claim.defaults.defaultTo !== undefined ? { defaultTo: claim.defaults.defaultTo } : {}),
      ...(claim.defaults.allowFrom !== undefined
        ? { allowFrom: [...claim.defaults.allowFrom] }
        : {}),
      ...(claim.defaults.agentActivity !== undefined
        ? { agentActivity: claim.defaults.agentActivity }
        : {}),
    };
  },
  applyAccountName: ({ cfg, accountId, name }) =>
    applyAccountNameToChannelSection({
      cfg,
      channelKey: channel,
      accountId,
      name,
    }),
  validateInput: createSetupInputPresenceValidator({
    defaultAccountOnlyEnvError: "CLICKCLACK_BOT_TOKEN can only be used for the default account.",
    whenNotUseEnv: [
      { someOf: ["token", "tokenFile"], message: REQUIRED_INPUT_ERROR },
      { someOf: ["baseUrl"], message: REQUIRED_INPUT_ERROR },
      { someOf: ["workspace"], message: REQUIRED_INPUT_ERROR },
    ],
    validate: ({ cfg, accountId, input }) => {
      const setupInput = input as ClickClackSetupInput;
      const baseUrl = normalizeClickClackBaseUrl(setupInput.baseUrl);
      if (setupInput.baseUrl && !baseUrl) {
        return INVALID_BASE_URL_ERROR;
      }
      if (!setupInput.useEnv) {
        return null;
      }
      const existing = resolveClickClackAccountConfig(cfg as CoreConfig, accountId);
      const existingBaseUrl = normalizeClickClackBaseUrl(existing.baseUrl);
      if (!baseUrl && existing.baseUrl?.trim() && !existingBaseUrl) {
        return INVALID_BASE_URL_ERROR;
      }
      if (!baseUrl && !existingBaseUrl) {
        return REQUIRED_INPUT_ERROR;
      }
      if (!setupInput.workspace?.trim() && !existing.workspace?.trim()) {
        return REQUIRED_INPUT_ERROR;
      }
      return null;
    },
  }),
  applyAccountConfig: ({ cfg, accountId, input }) => {
    const setupInput = input as ClickClackSetupInput;
    const existing = setupInput.useEnv
      ? resolveClickClackAccountConfig(cfg as CoreConfig, accountId)
      : undefined;
    const baseUrl = normalizeClickClackBaseUrl(setupInput.baseUrl ?? existing?.baseUrl);
    const workspace = setupInput.workspace?.trim() || existing?.workspace?.trim();
    const tokenFile = setupInput.tokenFile?.trim();
    const token = setupInput.token?.trim();
    const next = applyClickClackSetupConfigPatch({
      cfg,
      accountId,
      name: setupInput.name,
      patch: {
        ...(baseUrl ? { baseUrl } : {}),
        ...(workspace ? { workspace } : {}),
        ...(setupInput.defaultTo?.trim() ? { defaultTo: setupInput.defaultTo.trim() } : {}),
        ...(setupInput.allowFrom ? { allowFrom: [...setupInput.allowFrom] } : {}),
        ...(setupInput.agentActivity !== undefined
          ? { agentActivity: setupInput.agentActivity }
          : {}),
      },
    });
    return applyClickClackCredentialConfig({
      cfg: next,
      accountId,
      token,
      tokenFile,
      useEnv: setupInput.useEnv,
    });
  },
  afterAccountConfigWritten: async ({ cfg, accountId, runtime }) => {
    const { verifyClickClackAccountAfterSetup } = await import("./setup-verify.js");
    await verifyClickClackAccountAfterSetup({
      cfg: cfg as CoreConfig,
      accountId,
      runtime,
    });
  },
};

export const clickClackSetupContract = defineChannelSetupContract({
  fields: {
    code: {
      kind: "string",
      sensitive: true,
      cli: { flags: "--code <code>", description: "ClickClack one-time setup code or setup URL" },
    },
    token: {
      kind: "string",
      sensitive: true,
      cli: { flags: "--token <token>", description: "ClickClack bot token" },
    },
    tokenFile: {
      kind: "string",
      sensitive: true,
      cli: { flags: "--token-file <path>", description: "ClickClack bot token file" },
    },
    baseUrl: {
      kind: "string",
      cli: { flags: "--base-url <url>", description: "ClickClack API base URL" },
    },
    workspace: {
      kind: "string",
      cli: {
        flags: "--workspace <workspace>",
        description: "ClickClack workspace id, slug, or name",
      },
    },
    defaultTo: {
      kind: "string",
      cli: { flags: "--default-to <target>", description: "Default ClickClack target" },
    },
    allowFrom: {
      kind: "string-list",
      cli: { flags: "--allow-from <ids>", description: "Allowed ClickClack senders" },
    },
    agentActivity: {
      kind: "boolean",
      cli: { flags: "--agent-activity", description: "Enable ClickClack agent activity" },
    },
    useEnv: {
      kind: "boolean",
      cli: { flags: "--use-env", description: "Use CLICKCLACK_BOT_TOKEN" },
    },
  },
  legacyAdapter: clickClackSetupAdapter,
});
