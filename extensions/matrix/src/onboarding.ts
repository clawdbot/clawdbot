import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import type { DmPolicy } from "openclaw/plugin-sdk/config-types";
import {
  type ChannelSetupDmPolicy,
  type ChannelSetupWizardAdapter,
  formatDocsLink,
  hasConfiguredSecretInput,
  mergeAllowFromEntries,
  normalizeAccountId,
  promptAccountId,
  promptChannelAccessConfig,
  splitSetupEntries,
} from "openclaw/plugin-sdk/setup";
import { isPrivateNetworkOptInEnabled } from "openclaw/plugin-sdk/ssrf-policy";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
  normalizeStringifiedOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { requiresExplicitMatrixDefaultAccount } from "./account-selection.js";
import {
  listMatrixAccountIds,
  resolveDefaultMatrixAccountId,
  resolveMatrixAccount,
  resolveMatrixAccountConfig,
} from "./matrix/accounts.js";
import { resolveMatrixEnvAuthReadiness } from "./matrix/client/env-auth.js";
import { isPrivateOrLoopbackHost } from "./matrix/client/private-network-host.js";
import {
  resolveValidatedMatrixHomeserverUrl,
  validateMatrixHomeserverUrl,
} from "./matrix/client/url-validation.js";
import { resolveMatrixConfigFieldPath, updateMatrixAccountConfig } from "./matrix/config-update.js";
import { ensureMatrixSdkInstalled, isMatrixSdkAvailable } from "./matrix/deps.js";
import type { RuntimeEnv, WizardPrompter } from "./runtime-api.js";
import { moveSingleMatrixAccountConfigToNamedAccount } from "./setup-config.js";
import { resolveMatrixSetupDmAllowFrom } from "./setup-dm-policy.js";
import type { CoreConfig, MatrixConfig } from "./types.js";

const channel = "matrix" as const;
type MatrixInviteAutoJoinPolicy = NonNullable<MatrixConfig["autoJoin"]>;

const matrixInviteAutoJoinOptions: Array<{
  value: MatrixInviteAutoJoinPolicy;
  label: string;
}> = [
  { value: "allowlist", label: "Allowlist (recommended)" },
  { value: "always", label: "Always (join every invite)" },
  { value: "off", label: "Off (do not auto-join invites)" },
];

function isMatrixInviteAutoJoinPolicy(value: string): value is MatrixInviteAutoJoinPolicy {
  return value === "allowlist" || value === "always" || value === "off";
}

function isMatrixInviteAutoJoinTarget(entry: string): boolean {
  return (
    entry === "*" ||
    (entry.startsWith("!") && entry.includes(":")) ||
    (entry.startsWith("#") && entry.includes(":"))
  );
}

function normalizeMatrixInviteAutoJoinTargets(entries: string[]): string[] {
  return [
    ...new Set(
      entries
        .map((entry) => normalizeOptionalString(entry))
        .filter((entry): entry is string => Boolean(entry)),
    ),
  ];
}

function resolveMatrixOnboardingAccountId(cfg: CoreConfig, accountId?: string): string {
  return normalizeAccountId(
    normalizeOptionalString(accountId) || resolveDefaultMatrixAccountId(cfg) || DEFAULT_ACCOUNT_ID,
  );
}

function setMatrixDmPolicy(cfg: CoreConfig, policy: DmPolicy, accountId?: string) {
  const resolvedAccountId = resolveMatrixOnboardingAccountId(cfg, accountId);
  const existing = resolveMatrixAccountConfig({
    cfg,
    accountId: resolvedAccountId,
  });
  const allowFrom = resolveMatrixSetupDmAllowFrom(policy, existing.dm?.allowFrom);
  return updateMatrixAccountConfig(cfg, resolvedAccountId, {
    dm: {
      ...existing.dm,
      policy,
      allowFrom,
    },
  });
}

async function noteMatrixAuthHelp(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      "Matrix requires a homeserver URL.",
      "Use an access token (recommended) or password login to an existing account.",
      "With access token: user ID is fetched automatically.",
      "Env vars supported: MATRIX_HOMESERVER, MATRIX_USER_ID, MATRIX_ACCESS_TOKEN, MATRIX_PASSWORD, MATRIX_DEVICE_ID, MATRIX_DEVICE_NAME.",
      "Per-account env vars: MATRIX_<ACCOUNT_ID>_HOMESERVER, MATRIX_<ACCOUNT_ID>_USER_ID, MATRIX_<ACCOUNT_ID>_ACCESS_TOKEN, MATRIX_<ACCOUNT_ID>_PASSWORD, MATRIX_<ACCOUNT_ID>_DEVICE_ID, MATRIX_<ACCOUNT_ID>_DEVICE_NAME.",
      `Docs: ${formatDocsLink("/channels/matrix", "channels/matrix")}`,
    ].join("\n"),
    "Matrix setup",
  );
}

function requiresMatrixPrivateNetworkOptIn(homeserver: string): boolean {
  try {
    const parsed = new URL(homeserver);
    return parsed.protocol === "http:" && !isPrivateOrLoopbackHost(parsed.hostname);
  } catch {
    return false;
  }
}

async function promptMatrixAllowFrom(params: {
  cfg: CoreConfig;
  prompter: WizardPrompter;
  accountId?: string;
}): Promise<CoreConfig> {
  const { cfg, prompter } = params;
  const accountId = resolveMatrixOnboardingAccountId(cfg, params.accountId);
  const existingConfig = resolveMatrixAccountConfig({ cfg, accountId });
  const existingAllowFrom = existingConfig.dm?.allowFrom ?? [];
  const account = resolveMatrixAccount({ cfg, accountId });
  const canResolve = account.configured;

  const isFullUserId = (value: string) => value.startsWith("@") && value.includes(":");

  while (true) {
    const entry = await prompter.text({
      message: "Matrix allowFrom (full @user:server; display name only if unique)",
      placeholder: "@user:server",
      initialValue: existingAllowFrom[0] ? String(existingAllowFrom[0]) : undefined,
      validate: (value) => (normalizeOptionalString(value) ? undefined : "Required"),
    });
    const parts = splitSetupEntries(entry);
    const resolvedIds: string[] = [];
    const pending: string[] = [];
    const unresolved: string[] = [];
    const unresolvedNotes: string[] = [];

    for (const part of parts) {
      if (isFullUserId(part)) {
        resolvedIds.push(part);
        continue;
      }
      if (!canResolve) {
        unresolved.push(part);
        continue;
      }
      pending.push(part);
    }

    if (pending.length > 0) {
      const { resolveMatrixTargets } = await import("./resolve-targets.js");
      const results = await resolveMatrixTargets({
        cfg,
        accountId,
        inputs: pending,
        kind: "user",
      }).catch(() => []);
      for (const result of results) {
        if (result?.resolved && result.id) {
          resolvedIds.push(result.id);
          continue;
        }
        if (result?.input) {
          unresolved.push(result.input);
          if (result.note) {
            unresolvedNotes.push(`${result.input}: ${result.note}`);
          }
        }
      }
    }

    if (unresolved.length > 0) {
      const details = unresolvedNotes.length > 0 ? unresolvedNotes : unresolved;
      await prompter.note(
        `Could not resolve:\n${details.join("\n")}\nUse full @user:server IDs.`,
        "Matrix allowlist",
      );
      continue;
    }

    const unique = mergeAllowFromEntries(existingAllowFrom, resolvedIds);
    return updateMatrixAccountConfig(cfg, accountId, {
      dm: {
        ...existingConfig.dm,
        policy: "allowlist",
        allowFrom: unique,
      },
    });
  }
}

function setMatrixGroupPolicy(
  cfg: CoreConfig,
  groupPolicy: "open" | "allowlist" | "disabled",
  accountId?: string,
) {
  return updateMatrixAccountConfig(cfg, resolveMatrixOnboardingAccountId(cfg, accountId), {
    groupPolicy,
  });
}

function setMatrixGroupRooms(cfg: CoreConfig, roomKeys: string[], accountId?: string) {
  const groups = Object.fromEntries(roomKeys.map((key) => [key, { enabled: true }]));
  return updateMatrixAccountConfig(cfg, resolveMatrixOnboardingAccountId(cfg, accountId), {
    groups,
    rooms: null,
  });
}

function setMatrixAutoJoin(
  cfg: CoreConfig,
  autoJoin: MatrixInviteAutoJoinPolicy,
  autoJoinAllowlist: string[],
  accountId?: string,
) {
  return updateMatrixAccountConfig(cfg, resolveMatrixOnboardingAccountId(cfg, accountId), {
    autoJoin,
    autoJoinAllowlist: autoJoin === "allowlist" ? autoJoinAllowlist : null,
  });
}

async function configureMatrixInviteAutoJoin(params: {
  cfg: CoreConfig;
  prompter: WizardPrompter;
  accountId?: string;
}): Promise<CoreConfig> {
  const accountId = resolveMatrixOnboardingAccountId(params.cfg, params.accountId);
  const existingConfig = resolveMatrixAccountConfig({ cfg: params.cfg, accountId });
  const currentPolicy = existingConfig.autoJoin ?? "off";
  const currentAllowlist = (existingConfig.autoJoinAllowlist ?? []).map((entry) => String(entry));
  const hasExistingConfig = existingConfig.autoJoin !== undefined || currentAllowlist.length > 0;

  await params.prompter.note(
    [
      "WARNING: Matrix invite auto-join defaults to off.",
      "OpenClaw agents will not join invited rooms or fresh DM-style invites unless you set autoJoin.",
      'Choose "allowlist" to restrict joins or "always" to join every invite.',
    ].join("\n"),
    "Matrix invite auto-join",
  );

  const wants = await params.prompter.confirm({
    message: hasExistingConfig
      ? "Update Matrix invite auto-join?"
      : "Configure Matrix invite auto-join?",
    initialValue: hasExistingConfig ? currentPolicy !== "off" : true,
  });
  if (!wants) {
    return params.cfg;
  }

  const selectedPolicy = await params.prompter.select({
    message: "Matrix invite auto-join",
    options: matrixInviteAutoJoinOptions,
    initialValue: currentPolicy,
  });
  if (!isMatrixInviteAutoJoinPolicy(selectedPolicy)) {
    throw new Error(`Unsupported Matrix invite auto-join policy: ${String(selectedPolicy)}`);
  }
  const policy = selectedPolicy;

  if (policy === "off") {
    await params.prompter.note(
      [
        "Matrix invite auto-join remains off.",
        "Agents will not join invited rooms or fresh DM-style invites until you change autoJoin.",
      ].join("\n"),
      "Matrix invite auto-join",
    );
    return setMatrixAutoJoin(params.cfg, policy, [], accountId);
  }

  if (policy === "always") {
    return setMatrixAutoJoin(params.cfg, policy, [], accountId);
  }

  while (true) {
    const rawAllowlist = await params.prompter.text({
      message: "Matrix invite auto-join allowlist (comma-separated)",
      placeholder: "!roomId:server, #alias:server, *",
      initialValue: currentAllowlist[0] ? currentAllowlist.join(", ") : undefined,
      validate: (value) => {
        const entries = splitSetupEntries(value);
        return entries.length > 0 ? undefined : "Required";
      },
    });
    const allowlist = normalizeMatrixInviteAutoJoinTargets(splitSetupEntries(rawAllowlist));
    const invalidEntries = allowlist.filter((entry) => !isMatrixInviteAutoJoinTarget(entry));
    if (allowlist.length === 0 || invalidEntries.length > 0) {
      await params.prompter.note(
        [
          "Use only stable Matrix invite targets for auto-join: !roomId:server, #alias:server, or *.",
          invalidEntries.length > 0 ? `Invalid: ${invalidEntries.join(", ")}` : undefined,
        ]
          .filter(Boolean)
          .join("\n"),
        "Matrix invite auto-join",
      );
      continue;
    }
    return setMatrixAutoJoin(params.cfg, "allowlist", allowlist, accountId);
  }
}

async function configureMatrixAccessPrompts(params: {
  cfg: CoreConfig;
  prompter: WizardPrompter;
  forceAllowFrom: boolean;
  accountId: string;
}): Promise<CoreConfig> {
  let next = params.cfg;

  if (params.forceAllowFrom) {
    next = await promptMatrixAllowFrom({
      cfg: next,
      prompter: params.prompter,
      accountId: params.accountId,
    });
  }

  const existingAccountConfig = resolveMatrixAccountConfig({
    cfg: next,
    accountId: params.accountId,
  });
  const existingGroups = existingAccountConfig.groups ?? existingAccountConfig.rooms;
  const accessConfig = await promptChannelAccessConfig({
    prompter: params.prompter,
    label: "Matrix rooms",
    currentPolicy: existingAccountConfig.groupPolicy ?? "allowlist",
    currentEntries: Object.keys(existingGroups ?? {}),
    placeholder: "!roomId:server, #alias:server, Project Room",
    updatePrompt: Boolean(existingGroups),
  });
  if (accessConfig) {
    if (accessConfig.policy !== "allowlist") {
      next = setMatrixGroupPolicy(next, accessConfig.policy, params.accountId);
    } else {
      let roomKeys = accessConfig.entries;
      if (accessConfig.entries.length > 0) {
        try {
          const resolvedIds: string[] = [];
          const unresolved: string[] = [];
          for (const entry of accessConfig.entries) {
            const trimmed = normalizeOptionalString(entry) ?? "";
            if (!trimmed) {
              continue;
            }
            const cleaned = trimmed.replace(/^(room|channel):/i, "").trim();
            if (cleaned.startsWith("!") && cleaned.includes(":")) {
              resolvedIds.push(cleaned);
              continue;
            }
            const { listMatrixDirectoryGroupsLive } = await import("./directory-live.js");
            const matches = await listMatrixDirectoryGroupsLive({
              cfg: next,
              accountId: params.accountId,
              query: trimmed,
              limit: 10,
            });
            const exact = matches.find(
              (match) =>
                normalizeLowercaseStringOrEmpty(match.name) ===
                normalizeLowercaseStringOrEmpty(trimmed),
            );
            const best = exact ?? matches[0];
            if (best?.id) {
              resolvedIds.push(best.id);
            } else {
              unresolved.push(entry);
            }
          }
          roomKeys = [
            ...resolvedIds,
            ...unresolved
              .map((entry) => normalizeOptionalString(entry))
              .filter((entry): entry is string => Boolean(entry)),
          ];
          if (resolvedIds.length > 0 || unresolved.length > 0) {
            await params.prompter.note(
              [
                resolvedIds.length > 0 ? `Resolved: ${resolvedIds.join(", ")}` : undefined,
                unresolved.length > 0
                  ? `Unresolved (kept as typed): ${unresolved.join(", ")}`
                  : undefined,
              ]
                .filter(Boolean)
                .join("\n"),
              "Matrix rooms",
            );
          }
        } catch (err) {
          await params.prompter.note(
            `Room lookup failed; keeping entries as typed. ${String(err)}`,
            "Matrix rooms",
          );
        }
      }
      next = setMatrixGroupPolicy(next, "allowlist", params.accountId);
      next = setMatrixGroupRooms(next, roomKeys, params.accountId);
    }
  }

  return await configureMatrixInviteAutoJoin({
    cfg: next,
    prompter: params.prompter,
    accountId: params.accountId,
  });
}

const dmPolicy: ChannelSetupDmPolicy = {
  label: "Matrix",
  channel,
  policyKey: "channels.matrix.dm.policy",
  allowFromKey: "channels.matrix.dm.allowFrom",
  resolveConfigKeys: (cfg, accountId) => {
    const effectiveAccountId = resolveMatrixOnboardingAccountId(cfg as CoreConfig, accountId);
    return {
      policyKey: resolveMatrixConfigFieldPath(cfg as CoreConfig, effectiveAccountId, "dm.policy"),
      allowFromKey: resolveMatrixConfigFieldPath(
        cfg as CoreConfig,
        effectiveAccountId,
        "dm.allowFrom",
      ),
    };
  },
  getCurrent: (cfg, accountId) =>
    resolveMatrixAccountConfig({
      cfg: cfg as CoreConfig,
      accountId: resolveMatrixOnboardingAccountId(cfg as CoreConfig, accountId),
    }).dm?.policy ?? "pairing",
  setPolicy: (cfg, policy, accountId) => setMatrixDmPolicy(cfg as CoreConfig, policy, accountId),
  promptAllowFrom: promptMatrixAllowFrom,
};

type MatrixConfigureIntent = "update" | "add-account";

async function runMatrixConfigure(params: {
  cfg: CoreConfig;
  runtime: RuntimeEnv;
  prompter: WizardPrompter;
  forceAllowFrom: boolean;
  accountOverrides?: Partial<Record<string, string>>;
  shouldPromptAccountIds?: boolean;
  intent: MatrixConfigureIntent;
}): Promise<{ cfg: CoreConfig; accountId: string }> {
  let next = params.cfg;
  await ensureMatrixSdkInstalled({
    runtime: params.runtime,
    confirm: async (message) =>
      await params.prompter.confirm({
        message,
        initialValue: true,
      }),
  });
  const defaultAccountId = resolveDefaultMatrixAccountId(next);
  let accountId = defaultAccountId || DEFAULT_ACCOUNT_ID;
  if (params.intent === "add-account") {
    const enteredName =
      normalizeStringifiedOptionalString(
        await params.prompter.text({
          message: "Matrix account name",
          validate: (value) => (normalizeOptionalString(value) ? undefined : "Required"),
        }),
      ) ?? "";
    accountId = normalizeAccountId(enteredName);
    if (enteredName !== accountId) {
      await params.prompter.note(`Account id will be "${accountId}".`, "Matrix account");
    }
    if (accountId !== DEFAULT_ACCOUNT_ID) {
      next = moveSingleMatrixAccountConfigToNamedAccount(next);
    }
    next = updateMatrixAccountConfig(next, accountId, { name: enteredName, enabled: true });
  } else {
    const override = normalizeOptionalString(params.accountOverrides?.[channel]);
    if (override) {
      accountId = normalizeAccountId(override);
    } else if (params.shouldPromptAccountIds) {
      accountId = await promptAccountId({
        cfg: next,
        prompter: params.prompter,
        label: "Matrix",
        currentId: accountId,
        listAccountIds: (inputCfg) => listMatrixAccountIds(inputCfg as CoreConfig),
        defaultAccountId,
      });
    }
  }

  const existing = resolveMatrixAccountConfig({ cfg: next, accountId });
  const account = resolveMatrixAccount({ cfg: next, accountId });
  if (!account.configured) {
    await noteMatrixAuthHelp(params.prompter);
  }

  const envReadiness = resolveMatrixEnvAuthReadiness(accountId, process.env);
  const envReady = envReadiness.ready;
  const envHomeserver = envReadiness.homeserver;
  const envUserId = envReadiness.userId;

  if (
    envReady &&
    !existing.homeserver &&
    !existing.userId &&
    !existing.accessToken &&
    !existing.password
  ) {
    const useEnv = await params.prompter.confirm({
      message: `Matrix env vars detected (${envReadiness.sourceHint}). Use env values?`,
      initialValue: true,
    });
    if (useEnv) {
      next = updateMatrixAccountConfig(next, accountId, { enabled: true });
      next = await configureMatrixAccessPrompts({
        cfg: next,
        prompter: params.prompter,
        forceAllowFrom: params.forceAllowFrom,
        accountId,
      });
      return { cfg: next, accountId };
    }
  }

  const homeserver =
    normalizeStringifiedOptionalString(
      await params.prompter.text({
        message: "Matrix homeserver URL",
        initialValue: existing.homeserver ?? envHomeserver,
        validate: (value) => {
          try {
            validateMatrixHomeserverUrl(value, {
              allowPrivateNetwork: true,
            });
            return undefined;
          } catch (error) {
            return error instanceof Error ? error.message : "Invalid Matrix homeserver URL";
          }
        },
      }),
    ) ?? "";
  const requiresAllowPrivateNetwork = requiresMatrixPrivateNetworkOptIn(homeserver);
  const shouldPromptAllowPrivateNetwork =
    requiresAllowPrivateNetwork || isPrivateNetworkOptInEnabled(existing);
  const allowPrivateNetwork = shouldPromptAllowPrivateNetwork
    ? await params.prompter.confirm({
        message: "Allow private/internal Matrix homeserver traffic for this account?",
        initialValue: isPrivateNetworkOptInEnabled(existing) || requiresAllowPrivateNetwork,
      })
    : false;
  if (requiresAllowPrivateNetwork && !allowPrivateNetwork) {
    throw new Error("Matrix homeserver requires explicit private-network opt-in");
  }
  await resolveValidatedMatrixHomeserverUrl(homeserver, {
    dangerouslyAllowPrivateNetwork: allowPrivateNetwork,
  });

  let accessToken = existing.accessToken;
  let password = existing.password;
  let userId = existing.userId ?? "";

  if (hasConfiguredSecretInput(accessToken) || hasConfiguredSecretInput(password)) {
    const keep = await params.prompter.confirm({
      message: "Matrix credentials already configured. Keep them?",
      initialValue: true,
    });
    if (!keep) {
      accessToken = undefined;
      password = undefined;
      userId = "";
    }
  }

  if (!hasConfiguredSecretInput(accessToken) && !hasConfiguredSecretInput(password)) {
    const authMode = await params.prompter.select({
      message: "Matrix auth method",
      options: [
        { value: "token", label: "Access token (user ID fetched automatically)" },
        { value: "password", label: "Password (requires user ID)" },
      ],
    });

    if (authMode === "token") {
      accessToken =
        normalizeStringifiedOptionalString(
          await params.prompter.text({
            message: "Matrix access token",
            validate: (value) => (normalizeOptionalString(value) ? undefined : "Required"),
          }),
        ) ?? "";
      password = undefined;
      userId = "";
    } else {
      userId =
        normalizeStringifiedOptionalString(
          await params.prompter.text({
            message: "Matrix user ID",
            initialValue: existing.userId ?? envUserId,
            validate: (value) => {
              const raw = normalizeOptionalString(value) ?? "";
              if (!raw) {
                return "Required";
              }
              if (!raw.startsWith("@")) {
                return "Matrix user IDs should start with @";
              }
              if (!raw.includes(":")) {
                return "Matrix user IDs should include a server (:server)";
              }
              return undefined;
            },
          }),
        ) ?? "";
      password =
        normalizeStringifiedOptionalString(
          await params.prompter.text({
            message: "Matrix password",
            validate: (value) => (normalizeOptionalString(value) ? undefined : "Required"),
          }),
        ) ?? "";
      accessToken = undefined;
    }
  }

  const deviceName =
    normalizeStringifiedOptionalString(
      await params.prompter.text({
        message: "Matrix device name (optional)",
        initialValue: existing.deviceName ?? "OpenClaw Gateway",
      }),
    ) ?? "";

  const enableEncryption = await params.prompter.confirm({
    message: "Enable end-to-end encryption (E2EE)?",
    initialValue: existing.encryption ?? false,
  });

  next = updateMatrixAccountConfig(next, accountId, {
    enabled: true,
    homeserver,
    ...(shouldPromptAllowPrivateNetwork
      ? { allowPrivateNetwork: allowPrivateNetwork ? true : null }
      : {}),
    userId: userId || null,
    accessToken: accessToken ?? null,
    password: password ?? null,
    deviceName: deviceName || null,
    encryption: enableEncryption,
  });

  next = await configureMatrixAccessPrompts({
    cfg: next,
    prompter: params.prompter,
    forceAllowFrom: params.forceAllowFrom,
    accountId,
  });

  return { cfg: next, accountId };
}

export const matrixOnboardingAdapter: ChannelSetupWizardAdapter = {
  channel,
  getStatus: async ({ cfg, accountOverrides }) => {
    const resolvedCfg = cfg as CoreConfig;
    const sdkReady = isMatrixSdkAvailable();
    if (!accountOverrides[channel] && requiresExplicitMatrixDefaultAccount(resolvedCfg)) {
      return {
        channel,
        configured: false,
        statusLines: ['Matrix: set "channels.matrix.defaultAccount" to select a named account'],
        selectionHint: !sdkReady ? "install Matrix deps" : "set defaultAccount",
      };
    }
    const account = resolveMatrixAccount({
      cfg: resolvedCfg,
      accountId: resolveMatrixOnboardingAccountId(resolvedCfg, accountOverrides[channel]),
    });
    const configured = account.configured;
    return {
      channel,
      configured,
      statusLines: [
        `Matrix: ${configured ? "configured" : "needs homeserver + access token or password"}`,
      ],
      selectionHint: !sdkReady ? "install Matrix deps" : configured ? "configured" : "needs auth",
    };
  },
  configure: async ({
    cfg,
    runtime,
    prompter,
    forceAllowFrom,
    accountOverrides,
    shouldPromptAccountIds,
  }) =>
    await runMatrixConfigure({
      cfg: cfg as CoreConfig,
      runtime,
      prompter,
      forceAllowFrom,
      accountOverrides,
      shouldPromptAccountIds,
      intent: "update",
    }),
  configureInteractive: async ({
    cfg,
    runtime,
    prompter,
    forceAllowFrom,
    accountOverrides,
    shouldPromptAccountIds,
    configured,
  }) => {
    if (!configured) {
      return await runMatrixConfigure({
        cfg: cfg as CoreConfig,
        runtime,
        prompter,
        forceAllowFrom,
        accountOverrides,
        shouldPromptAccountIds,
        intent: "update",
      });
    }
    const action = await prompter.select({
      message: "Matrix already configured. What do you want to do?",
      options: [
        { value: "update", label: "Modify settings" },
        { value: "add-account", label: "Add account" },
        { value: "skip", label: "Skip (leave as-is)" },
      ],
      initialValue: "update",
    });
    if (action === "skip") {
      return "skip";
    }
    return await runMatrixConfigure({
      cfg: cfg as CoreConfig,
      runtime,
      prompter,
      forceAllowFrom,
      accountOverrides,
      shouldPromptAccountIds,
      intent: action === "add-account" ? "add-account" : "update",
    });
  },
  afterConfigWritten: async ({ previousCfg, cfg, accountId, runtime }) => {
    const { runMatrixSetupBootstrapAfterConfigWrite } = await import("./setup-bootstrap.js");
    await runMatrixSetupBootstrapAfterConfigWrite({
      previousCfg: previousCfg as CoreConfig,
      cfg: cfg as CoreConfig,
      accountId,
      runtime,
    });
  },
  dmPolicy,
  disable: (cfg) => ({
    ...(cfg as CoreConfig),
    channels: {
      ...(cfg as CoreConfig).channels,
      matrix: { ...(cfg as CoreConfig).channels?.["matrix"], enabled: false },
    },
  }),
};

export const __testing = {
  promptMatrixAllowFrom,
};
