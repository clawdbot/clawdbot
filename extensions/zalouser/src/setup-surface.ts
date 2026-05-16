import {
  addWildcardAllowFrom,
  DEFAULT_ACCOUNT_ID,
  formatCliCommand,
  formatDocsLink,
  formatResolvedUnresolvedNote,
  mergeAllowFromEntries,
  normalizeAccountId,
  patchScopedAccountConfig,
  createSetupTranslator,
  type ChannelSetupDmPolicy,
  type ChannelSetupWizard,
  type DmPolicy,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/setup";
import {
  checkZcaAuthenticated,
  listZalouserAccountIds,
  resolveDefaultZalouserAccountId,
  resolveZalouserAccountSync,
} from "./accounts.js";
import { writeQrDataUrlToTempFile } from "./qr-temp-file.js";
import {
  logoutZaloProfile,
  resolveZaloAllowFromEntries,
  resolveZaloGroupsByEntries,
  startZaloQrLogin,
  waitForZaloQrLogin,
} from "./zalo-js.js";

const t = createSetupTranslator();

const channel = "zalouser" as const;
const ZALOUSER_ALLOW_FROM_PLACEHOLDER = t("wizard.zalouser.allowFromPlaceholder");
const ZALOUSER_GROUPS_PLACEHOLDER = t("wizard.zalouser.groupsPlaceholder");
const ZALOUSER_DM_ACCESS_TITLE = t("wizard.zalouser.dmAccessTitle");
const ZALOUSER_ALLOWLIST_TITLE = t("wizard.zalouser.allowlistTitle");
const ZALOUSER_GROUPS_TITLE = t("wizard.zalouser.groupsTitle");

function parseZalouserEntries(raw: string): string[] {
  return raw
    .split(/[\n,;]+/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function setZalouserAccountScopedConfig(
  cfg: OpenClawConfig,
  accountId: string,
  defaultPatch: Record<string, unknown>,
  accountPatch: Record<string, unknown> = defaultPatch,
): OpenClawConfig {
  return patchScopedAccountConfig({
    cfg,
    channelKey: channel,
    accountId,
    patch: defaultPatch,
    accountPatch,
  });
}

function setZalouserDmPolicy(
  cfg: OpenClawConfig,
  accountId: string,
  policy: DmPolicy,
): OpenClawConfig {
  const resolvedAccountId = normalizeAccountId(accountId) ?? DEFAULT_ACCOUNT_ID;
  const resolved = resolveZalouserAccountSync({ cfg, accountId: resolvedAccountId });
  return setZalouserAccountScopedConfig(
    cfg,
    resolvedAccountId,
    {
      dmPolicy: policy,
      ...(policy === "open" ? { allowFrom: addWildcardAllowFrom(resolved.config.allowFrom) } : {}),
    },
    {
      dmPolicy: policy,
      ...(policy === "open" ? { allowFrom: addWildcardAllowFrom(resolved.config.allowFrom) } : {}),
    },
  );
}

function setZalouserGroupPolicy(
  cfg: OpenClawConfig,
  accountId: string,
  groupPolicy: "open" | "allowlist" | "disabled",
): OpenClawConfig {
  return setZalouserAccountScopedConfig(cfg, accountId, {
    groupPolicy,
  });
}

function setZalouserGroupAllowlist(
  cfg: OpenClawConfig,
  accountId: string,
  groupKeys: string[],
): OpenClawConfig {
  const groups = Object.fromEntries(
    groupKeys.map((key) => [key, { enabled: true, requireMention: true }]),
  );
  return setZalouserAccountScopedConfig(cfg, accountId, {
    groups,
  });
}

function ensureZalouserPluginEnabled(cfg: OpenClawConfig): OpenClawConfig {
  const next: OpenClawConfig = {
    ...cfg,
    plugins: {
      ...cfg.plugins,
      entries: {
        ...cfg.plugins?.entries,
        zalouser: {
          ...cfg.plugins?.entries?.zalouser,
          enabled: true,
        },
      },
    },
  };
  const allow = next.plugins?.allow;
  if (!Array.isArray(allow) || allow.includes(channel)) {
    return next;
  }
  return {
    ...next,
    plugins: {
      ...next.plugins,
      allow: [...allow, channel],
    },
  };
}

async function noteZalouserHelp(
  prompter: Parameters<NonNullable<ChannelSetupWizard["prepare"]>>[0]["prompter"],
): Promise<void> {
  await prompter.note(
    [
      t("wizard.zalouser.helpQrLogin"),
      "",
      t("wizard.zalouser.helpZcaJs"),
      "",
      `Docs: ${formatDocsLink("/channels/zalouser", "zalouser")}`,
    ].join("\n"),
    t("wizard.zalouser.setupTitle"),
  );
}

async function promptZalouserAllowFrom(params: {
  cfg: OpenClawConfig;
  prompter: Parameters<NonNullable<ChannelSetupDmPolicy["promptAllowFrom"]>>[0]["prompter"];
  accountId: string;
}): Promise<OpenClawConfig> {
  const { cfg, prompter, accountId } = params;
  const resolved = resolveZalouserAccountSync({ cfg, accountId });
  const existingAllowFrom = resolved.config.allowFrom ?? [];

  while (true) {
    const entry = await prompter.text({
      message: t("wizard.zalouser.allowFromPrompt"),
      placeholder: ZALOUSER_ALLOW_FROM_PLACEHOLDER,
      initialValue: existingAllowFrom.length > 0 ? existingAllowFrom.join(", ") : undefined,
    });
    const parts = parseZalouserEntries(entry);
    if (parts.length === 0) {
      await prompter.note(
        [
          t("wizard.zalouser.noDmAllowlist"),
          t("wizard.zalouser.directChatsBlocked"),
          t("wizard.zalouser.peersLookupTip", {
            command: formatCliCommand("openclaw directory peers list --channel zalouser"),
          }),
        ].join("\n"),
        ZALOUSER_ALLOWLIST_TITLE,
      );
      return setZalouserAccountScopedConfig(cfg, accountId, {
        dmPolicy: "allowlist",
        allowFrom: [],
      });
    }
    const resolvedEntries = await resolveZaloAllowFromEntries({
      profile: resolved.profile,
      entries: parts,
    });

    const unresolved = resolvedEntries.filter((item) => !item.resolved).map((item) => item.input);
    if (unresolved.length > 0) {
      await prompter.note(
        t("wizard.zalouser.couldNotResolve", { entries: unresolved.join(", ") }),
        ZALOUSER_ALLOWLIST_TITLE,
      );
      continue;
    }

    const resolvedIds = resolvedEntries
      .filter((item) => item.resolved && item.id)
      .map((item) => item.id as string);
    const unique = mergeAllowFromEntries(existingAllowFrom, resolvedIds);

    const notes = resolvedEntries
      .filter((item) => item.note)
      .map((item) => `${item.input} -> ${item.id} (${item.note})`);
    if (notes.length > 0) {
      await prompter.note(notes.join("\n"), ZALOUSER_ALLOWLIST_TITLE);
    }

    return setZalouserAccountScopedConfig(cfg, accountId, {
      dmPolicy: "allowlist",
      allowFrom: unique,
    });
  }
}

const zalouserDmPolicy: ChannelSetupDmPolicy = {
  label: "Zalo Personal",
  channel,
  policyKey: "channels.zalouser.dmPolicy",
  allowFromKey: "channels.zalouser.allowFrom",
  resolveConfigKeys: (cfg, accountId) =>
    (accountId ?? resolveDefaultZalouserAccountId(cfg)) !== DEFAULT_ACCOUNT_ID
      ? {
          policyKey: `channels.zalouser.accounts.${accountId ?? resolveDefaultZalouserAccountId(cfg)}.dmPolicy`,
          allowFromKey: `channels.zalouser.accounts.${accountId ?? resolveDefaultZalouserAccountId(cfg)}.allowFrom`,
        }
      : {
          policyKey: "channels.zalouser.dmPolicy",
          allowFromKey: "channels.zalouser.allowFrom",
        },
  getCurrent: (cfg, accountId) =>
    resolveZalouserAccountSync({
      cfg,
      accountId: accountId ?? resolveDefaultZalouserAccountId(cfg),
    }).config.dmPolicy ?? "pairing",
  setPolicy: (cfg, policy, accountId) =>
    setZalouserDmPolicy(cfg, accountId ?? resolveDefaultZalouserAccountId(cfg), policy),
  promptAllowFrom: async ({ cfg, prompter, accountId }) => {
    const id =
      accountId && normalizeAccountId(accountId)
        ? (normalizeAccountId(accountId) ?? DEFAULT_ACCOUNT_ID)
        : resolveDefaultZalouserAccountId(cfg);
    return await promptZalouserAllowFrom({
      cfg: cfg,
      prompter,
      accountId: id,
    });
  },
};

async function promptZalouserQuickstartDmPolicy(params: {
  cfg: OpenClawConfig;
  prompter: Parameters<NonNullable<ChannelSetupWizard["prepare"]>>[0]["prompter"];
  accountId: string;
}): Promise<OpenClawConfig> {
  const { cfg, prompter, accountId } = params;
  const resolved = resolveZalouserAccountSync({ cfg, accountId });
  const existingPolicy = resolved.config.dmPolicy ?? "pairing";
  const existingAllowFrom = resolved.config.allowFrom ?? [];
  const existingLabel = existingAllowFrom.length > 0 ? existingAllowFrom.join(", ") : "unset";

  await prompter.note(
    [
      t("wizard.zalouser.dmHelpSeparate"),
      t("wizard.zalouser.dmHelpPairing"),
      t("wizard.zalouser.dmHelpAllowlist"),
      t("wizard.zalouser.dmHelpOpen"),
      t("wizard.zalouser.dmHelpDisabled"),
      "",
      `Current: dmPolicy=${existingPolicy}, allowFrom=${existingLabel}`,
      t("wizard.zalouser.dmHelpAllowlistEmpty"),
    ].join("\n"),
    ZALOUSER_DM_ACCESS_TITLE,
  );

  const policy = (await prompter.select({
    message: t("wizard.zalouser.dmPolicyPrompt"),
    options: [
      { value: "pairing", label: t("wizard.channels.dmPolicyPairing") },
      { value: "allowlist", label: t("wizard.channels.dmPolicyAllowlistOption") },
      { value: "open", label: t("wizard.channels.dmPolicyOpenOption") },
      { value: "disabled", label: t("wizard.channels.dmPolicyDisabledOption") },
    ],
    initialValue: existingPolicy,
  })) as DmPolicy;

  if (policy === "allowlist") {
    return await promptZalouserAllowFrom({
      cfg,
      prompter,
      accountId,
    });
  }
  return setZalouserDmPolicy(cfg, accountId, policy);
}

export { zalouserSetupAdapter } from "./setup-core.js";

export const zalouserSetupWizard: ChannelSetupWizard = {
  channel,
  status: {
    configuredLabel: t("wizard.channels.statusLoggedIn"),
    unconfiguredLabel: t("wizard.channels.statusNeedsQrLogin"),
    configuredHint: t("wizard.channels.statusRecommendedLoggedIn"),
    unconfiguredHint: t("wizard.channels.statusRecommendedQrLogin"),
    configuredScore: 1,
    unconfiguredScore: 15,
    resolveConfigured: async ({ cfg, accountId }) => {
      const ids = accountId ? [accountId] : listZalouserAccountIds(cfg);
      for (const resolvedAccountId of ids) {
        const account = resolveZalouserAccountSync({ cfg, accountId: resolvedAccountId });
        if (await checkZcaAuthenticated(account.profile)) {
          return true;
        }
      }
      return false;
    },
    resolveStatusLines: async ({ cfg, accountId, configured }) => {
      void cfg;
      const label =
        accountId && accountId !== DEFAULT_ACCOUNT_ID
          ? `Zalo Personal (${accountId})`
          : "Zalo Personal";
      return [`${label}: ${configured ? "logged in" : "needs QR login"}`];
    },
  },
  prepare: async ({ cfg, accountId, prompter, options }) => {
    let next = cfg;
    const account = resolveZalouserAccountSync({ cfg: next, accountId });
    const alreadyAuthenticated = await checkZcaAuthenticated(account.profile);

    if (!alreadyAuthenticated) {
      await noteZalouserHelp(prompter);
      const wantsLogin = await prompter.confirm({
        message: t("wizard.zalouser.loginQrPrompt"),
        initialValue: true,
      });

      if (wantsLogin) {
        const start = await startZaloQrLogin({ profile: account.profile, timeoutMs: 35_000 });
        if (start.qrDataUrl) {
          const qrPath = await writeQrDataUrlToTempFile(start.qrDataUrl, account.profile);
          await prompter.note(
            [
              start.message,
              qrPath
                ? t("wizard.zalouser.qrImageSaved", { path: qrPath })
                : t("wizard.zalouser.qrImageWriteFailed"),
              t("wizard.zalouser.scanApproveContinue"),
            ].join("\n"),
            t("wizard.zalouser.qrLoginTitle"),
          );
          const scanned = await prompter.confirm({
            message: t("wizard.zalouser.qrScannedPrompt"),
            initialValue: true,
          });
          if (scanned) {
            const waited = await waitForZaloQrLogin({
              profile: account.profile,
              timeoutMs: 120_000,
            });
            await prompter.note(
              waited.message,
              waited.connected ? t("common.done") : t("wizard.zalouser.loginPendingTitle"),
            );
          }
        } else {
          await prompter.note(start.message, t("wizard.zalouser.loginPendingTitle"));
        }
      }
    } else {
      const keepSession = await prompter.confirm({
        message: t("wizard.zalouser.keepSessionPrompt"),
        initialValue: true,
      });
      if (!keepSession) {
        await logoutZaloProfile(account.profile);
        const start = await startZaloQrLogin({
          profile: account.profile,
          force: true,
          timeoutMs: 35_000,
        });
        if (start.qrDataUrl) {
          const qrPath = await writeQrDataUrlToTempFile(start.qrDataUrl, account.profile);
          await prompter.note(
            [
              start.message,
              qrPath ? t("wizard.zalouser.qrImageSaved", { path: qrPath }) : undefined,
            ]
              .filter(Boolean)
              .join("\n"),
            t("wizard.zalouser.qrLoginTitle"),
          );
          const waited = await waitForZaloQrLogin({ profile: account.profile, timeoutMs: 120_000 });
          await prompter.note(
            waited.message,
            waited.connected ? t("common.done") : t("wizard.zalouser.loginPendingTitle"),
          );
        }
      }
    }

    next = setZalouserAccountScopedConfig(
      next,
      accountId,
      { profile: account.profile !== "default" ? account.profile : undefined },
      { profile: account.profile, enabled: true },
    );

    if (options?.quickstartDefaults) {
      next = await promptZalouserQuickstartDmPolicy({
        cfg: next,
        prompter,
        accountId,
      });
    }

    return { cfg: next };
  },
  credentials: [],
  groupAccess: {
    label: "Zalo groups",
    placeholder: ZALOUSER_GROUPS_PLACEHOLDER,
    currentPolicy: ({ cfg, accountId }) =>
      resolveZalouserAccountSync({ cfg, accountId }).config.groupPolicy ?? "allowlist",
    currentEntries: ({ cfg, accountId }) =>
      Object.keys(resolveZalouserAccountSync({ cfg, accountId }).config.groups ?? {}),
    updatePrompt: ({ cfg, accountId }) =>
      Boolean(resolveZalouserAccountSync({ cfg, accountId }).config.groups),
    setPolicy: ({ cfg, accountId, policy }) => setZalouserGroupPolicy(cfg, accountId, policy),
    resolveAllowlist: async ({ cfg, accountId, entries, prompter }) => {
      if (entries.length === 0) {
        await prompter.note(
          [
            t("wizard.zalouser.noGroupAllowlist"),
            t("wizard.zalouser.groupChatsBlocked"),
            t("wizard.zalouser.groupsLookupTip", {
              command: formatCliCommand("openclaw directory groups list --channel zalouser"),
            }),
            t("wizard.zalouser.groupMentionRequirement"),
          ].join("\n"),
          ZALOUSER_GROUPS_TITLE,
        );
        return [];
      }
      const updatedAccount = resolveZalouserAccountSync({ cfg: cfg, accountId });
      try {
        const resolved = await resolveZaloGroupsByEntries({
          profile: updatedAccount.profile,
          entries,
        });
        const resolvedIds = resolved
          .filter((entry) => entry.resolved && entry.id)
          .map((entry) => entry.id as string);
        const unresolved = resolved.filter((entry) => !entry.resolved).map((entry) => entry.input);
        const keys = [...resolvedIds, ...unresolved.map((entry) => entry.trim()).filter(Boolean)];
        const resolution = formatResolvedUnresolvedNote({
          resolved: resolvedIds,
          unresolved,
        });
        if (resolution) {
          await prompter.note(resolution, ZALOUSER_GROUPS_TITLE);
        }
        return keys;
      } catch (err) {
        await prompter.note(
          t("wizard.zalouser.groupLookupFailed", { error: String(err) }),
          ZALOUSER_GROUPS_TITLE,
        );
        return entries.map((entry) => entry.trim()).filter(Boolean);
      }
    },
    applyAllowlist: ({ cfg, accountId, resolved }) =>
      setZalouserGroupAllowlist(cfg, accountId, resolved as string[]),
  },
  finalize: async ({ cfg, accountId, forceAllowFrom, options, prompter }) => {
    let next = cfg;
    if (forceAllowFrom && !options?.quickstartDefaults) {
      next = await promptZalouserAllowFrom({
        cfg: next,
        prompter,
        accountId,
      });
    }
    return { cfg: ensureZalouserPluginEnabled(next) };
  },
  dmPolicy: zalouserDmPolicy,
};
