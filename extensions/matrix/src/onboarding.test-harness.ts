import type { OutputRuntimeEnv } from "openclaw/plugin-sdk/runtime";
import type { ChannelSetupWizardAdapter } from "openclaw/plugin-sdk/setup";
import { afterEach, vi } from "vitest";
import type { RuntimeEnv, WizardPrompter } from "../runtime-api.js";
import type { CoreConfig } from "./types.js";

type MatrixInteractiveOptions = Parameters<
  NonNullable<ChannelSetupWizardAdapter["configureInteractive"]>
>[0]["options"];

const MATRIX_ENV_KEYS = [
  "MATRIX_HOMESERVER",
  "MATRIX_USER_ID",
  "MATRIX_ACCESS_TOKEN",
  "MATRIX_PASSWORD",
  "MATRIX_DEVICE_ID",
  "MATRIX_DEVICE_NAME",
  "MATRIX_OPS_HOMESERVER",
  "MATRIX_OPS_ACCESS_TOKEN",
] as const;

const previousMatrixEnv = Object.fromEntries(
  MATRIX_ENV_KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof MATRIX_ENV_KEYS)[number], string | undefined>;

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Test helper lets callers ascribe plugin runtime shape.
function createNonExitingTypedRuntimeEnv<TRuntime>(): TRuntime {
  return {
    log: vi.fn(),
    error: vi.fn(),
    writeStdout: vi.fn(),
    writeJson: vi.fn(),
    exit: vi.fn(),
  } as OutputRuntimeEnv as TRuntime;
}

export function installMatrixOnboardingEnvRestoreHooks() {
  afterEach(() => {
    for (const [key, value] of Object.entries(previousMatrixEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
}

type PromptHandler<T> = (message: string) => T;

export function createMatrixWizardPrompter(params: {
  notes?: string[];
  select?: Record<string, string>;
  text?: Record<string, string>;
  confirm?: Record<string, boolean>;
  onNote?: PromptHandler<void | Promise<void>>;
  onSelect?: PromptHandler<string | Promise<string>>;
  onText?: PromptHandler<string | Promise<string>>;
  onConfirm?: PromptHandler<boolean | Promise<boolean>>;
}): WizardPrompter {
  const resolvePromptValue = async <T>(
    kind: string,
    message: string,
    values: Record<string, T> | undefined,
    fallback: PromptHandler<T | Promise<T>> | undefined,
  ): Promise<T> => {
    if (values && message in values) {
      return values[message];
    }
    if (fallback) {
      return await fallback(message);
    }
    throw new Error(`unexpected ${kind} prompt: ${message}`);
  };

  return {
    note: vi.fn(async (message: unknown) => {
      const text = String(message);
      params.notes?.push(text);
      await params.onNote?.(text);
    }),
    select: vi.fn(async ({ message }: { message: string }) => {
      return await resolvePromptValue("select", message, params.select, params.onSelect);
    }),
    text: vi.fn(async ({ message }: { message: string }) => {
      return await resolvePromptValue("text", message, params.text, params.onText);
    }),
    confirm: vi.fn(async ({ message }: { message: string }) => {
      return await resolvePromptValue("confirm", message, params.confirm, params.onConfirm);
    }),
  } as unknown as WizardPrompter;
}

export function installMatrixScopedEnvShortcut() {
  process.env.MATRIX_HOMESERVER = "https://matrix.env.example.org";
  process.env.MATRIX_USER_ID = "@env:example.org";
  process.env.MATRIX_PASSWORD = "env-password"; // pragma: allowlist secret
  process.env.MATRIX_ACCESS_TOKEN = "";
  process.env.MATRIX_OPS_HOMESERVER = "https://matrix.ops.env.example.org";
  process.env.MATRIX_OPS_ACCESS_TOKEN = "ops-env-token";
}

export async function runMatrixInteractiveConfigure(params: {
  cfg: CoreConfig;
  prompter: WizardPrompter;
  options?: MatrixInteractiveOptions;
  accountOverrides?: Record<string, string>;
  shouldPromptAccountIds?: boolean;
  forceAllowFrom?: boolean;
  configured?: boolean;
}) {
  const { matrixOnboardingAdapter } = await import("./onboarding.js");
  return await matrixOnboardingAdapter.configureInteractive!({
    cfg: params.cfg,
    runtime: createNonExitingTypedRuntimeEnv<RuntimeEnv>(),
    prompter: params.prompter,
    options: params.options,
    accountOverrides: params.accountOverrides ?? {},
    shouldPromptAccountIds: params.shouldPromptAccountIds ?? false,
    forceAllowFrom: params.forceAllowFrom ?? false,
    configured: params.configured ?? false,
    label: "Matrix",
  });
}

export async function runMatrixAddAccountAllowlistConfigure(params: {
  cfg: CoreConfig;
  allowFromInput: string;
  roomsAllowlistInput: string;
  autoJoinPolicy?: "always" | "allowlist" | "off";
  autoJoinAllowlistInput?: string;
  deviceName?: string;
  notes?: string[];
}) {
  const prompter = createMatrixWizardPrompter({
    notes: params.notes,
    select: {
      "Matrix already configured. What do you want to do?": "add-account",
      "Matrix auth method": "token",
      "Matrix rooms access": "allowlist",
      "Matrix invite auto-join": params.autoJoinPolicy ?? "allowlist",
    },
    text: {
      "Matrix account name": "ops",
      "Matrix homeserver URL": "https://matrix.ops.example.org",
      "Matrix access token": "ops-token",
      "Matrix device name (optional)": params.deviceName ?? "",
      "Matrix allowFrom (full @user:server; display name only if unique)": params.allowFromInput,
      "Matrix rooms allowlist (comma-separated)": params.roomsAllowlistInput,
      "Matrix invite auto-join allowlist (comma-separated)":
        params.autoJoinAllowlistInput ?? "#ops-invites:example.org",
    },
    confirm: {
      "Enable end-to-end encryption (E2EE)?": false,
      "Configure Matrix rooms access?": true,
      "Configure Matrix invite auto-join?": true,
    },
    onConfirm: async () => false,
  });

  return await runMatrixInteractiveConfigure({
    cfg: params.cfg,
    prompter,
    shouldPromptAccountIds: true,
    forceAllowFrom: true,
    configured: true,
  });
}

export function createConfiguredMatrixDefaultAccountConfig(): CoreConfig {
  return {
    channels: {
      matrix: {
        accounts: {
          default: {
            homeserver: "https://matrix.main.example.org",
            accessToken: "main-token",
          },
        },
      },
    },
  } as CoreConfig;
}

export function createLegacyMatrixTopLevelConfig(): CoreConfig {
  return {
    channels: {
      matrix: {
        homeserver: "https://matrix.main.example.org",
        userId: "@main:example.org",
        accessToken: "main-token",
        avatarUrl: "mxc://matrix.main.example.org/main-avatar",
      },
    },
  } as CoreConfig;
}

export function createMatrixTokenAddAccountPrompter(params?: {
  accountName?: string;
  homeserver?: string;
  accessToken?: string;
  deviceName?: string;
}) {
  return createMatrixWizardPrompter({
    select: {
      "Matrix already configured. What do you want to do?": "add-account",
      "Matrix auth method": "token",
    },
    text: {
      "Matrix account name": params?.accountName ?? "ops",
      "Matrix homeserver URL": params?.homeserver ?? "https://matrix.ops.example.org",
      "Matrix access token": params?.accessToken ?? "ops-token",
      "Matrix device name (optional)": params?.deviceName ?? "",
    },
    onConfirm: async () => false,
  });
}

export function createMatrixEnvShortcutAddAccountPrompter(params?: {
  notes?: string[];
  select?: Record<string, string>;
  text?: Record<string, string>;
  confirm?: Record<string, boolean>;
  onConfirm?: PromptHandler<boolean | Promise<boolean>>;
}) {
  return createMatrixWizardPrompter({
    ...(params?.notes ? { notes: params.notes } : {}),
    select: {
      "Matrix already configured. What do you want to do?": "add-account",
      "Matrix auth method": "token",
      ...params?.select,
    },
    text: {
      "Matrix account name": "ops",
      ...params?.text,
    },
    ...(params?.confirm ? { confirm: params.confirm } : {}),
    ...(params?.onConfirm ? { onConfirm: params.onConfirm } : {}),
  });
}

export function createConfiguredMatrixTopLevelConfig(params?: {
  homeserver?: string;
  accessToken?: string | { source: "env"; provider: "default"; id: string };
  autoJoin?: "allowlist" | "off";
  autoJoinAllowlist?: string[];
}): CoreConfig {
  return {
    channels: {
      matrix: {
        homeserver: params?.homeserver ?? "https://matrix.example.org",
        accessToken: params?.accessToken ?? "matrix-token",
        ...(params?.autoJoin ? { autoJoin: params.autoJoin } : {}),
        ...(params?.autoJoinAllowlist ? { autoJoinAllowlist: params.autoJoinAllowlist } : {}),
      },
    },
  } as CoreConfig;
}

export function createMatrixUpdateKeepCredentialsPrompter(params?: {
  notes?: string[];
  inviteAutoJoin?: "off" | "allowlist";
  updateAutoJoin?: boolean;
  homeserver?: string;
  deviceName?: string;
  onText?: PromptHandler<string | Promise<string>>;
}) {
  return createMatrixWizardPrompter({
    notes: params?.notes,
    select: {
      "Matrix already configured. What do you want to do?": "update",
      ...(params?.inviteAutoJoin ? { "Matrix invite auto-join": params.inviteAutoJoin } : {}),
    },
    text: {
      "Matrix homeserver URL": params?.homeserver ?? "https://matrix.example.org",
      "Matrix device name (optional)": params?.deviceName ?? "OpenClaw Gateway",
    },
    confirm: {
      "Matrix credentials already configured. Keep them?": true,
      "Enable end-to-end encryption (E2EE)?": false,
      "Configure Matrix rooms access?": false,
      "Configure Matrix invite auto-join?": params?.inviteAutoJoin !== undefined,
      ...(params?.inviteAutoJoin !== undefined
        ? { "Update Matrix invite auto-join?": params?.updateAutoJoin ?? true }
        : {}),
    },
    ...(params?.onText ? { onText: params.onText } : {}),
  });
}

export function createMatrixNamedAccountsConfig(params: {
  defaultAccount?: string;
  accounts: Record<
    string,
    {
      homeserver: string;
      accessToken?: string;
    }
  >;
}): CoreConfig {
  return {
    channels: {
      matrix: {
        ...(params.defaultAccount ? { defaultAccount: params.defaultAccount } : {}),
        accounts: params.accounts,
      },
    },
  } as CoreConfig;
}
