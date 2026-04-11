import {
  addWildcardAllowFrom,
  DEFAULT_ACCOUNT_ID,
  formatCliCommand,
  formatDocsLink,
  formatResolvedUnresolvedNote,
  mergeAllowFromEntries,
  normalizeAccountId,
  patchScopedAccountConfig,
  type ChannelSetupDmPolicy,
  type ChannelSetupWizard,
  type DmPolicy,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/setup";
import {
  listZalouserAccountIds,
  resolveDefaultZalouserAccountId,
  resolveZalouserAccountSync,
  checkZcaAuthenticated,
} from "./accounts.js";
import { writeQrDataUrlToTempFile } from "./qr-temp-file.js";
import { zalouserSetupAdapter } from "./setup-core.js";
import {
  logoutZaloProfile,
  resolveZaloAllowFromEntries,
  resolveZaloGroupsByEntries,
  startZaloQrLogin,
  waitForZaloQrLogin,
} from "./zalo-js.js";

const channel = "zalouser" as const;
const ZALOUSER_ALLOW_FROM_PLACEHOLDER = "Alice, 123456789, or leave empty to configure later";
const ZALOUSER_GROUPS_PLACEHOLDER = "Family, Work, 123456789, or leave empty for now";
const ZALOUSER_DM_ACCESS_TITLE = "Zalo Personal DM access";
const ZALOUSER_ALLOWLIST_TITLE = "Zalo Personal allowlist";
const ZALOUSER_GROUPS_TITLE = "Zalo groups";

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
      "Zalo Personal Account login via QR code.",
      "",
      "This plugin uses zca-js directly (no external CLI dependency).",
      "",
      `Docs: ${formatDocsLink("/channels/zalouser", "zalouser")}`,
    ].join("\n"),
    "Zalo Personal Setup",
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
      message: "Zalouser allowFrom (name or user id)",
      placeholder: ZALOUSER_ALLOW_FROM_PLACEHOLDER,
      initialValue: existingAllowFrom.length > 0 ? existingAllowFrom.join(", ") : undefined,
    });
    const parts = parseZalouserEntries(entry);
    if (parts.length === 0) {
      await prompter.note(
        [
          "No DM allowlist entries added yet.",
          "Direct chats will stay blocked until you add people later.",
          `Tip: use \`${formatCliCommand("openclaw directory peers list --channel zalouser")}\` to look up people after onboarding.`,
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
        `Could not resolve: ${unresolved.join(", ")}. Use numeric user ids or exact friend names.`,
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
      "Direct chats are configured separately from group chats.",
      "- pairing (default): unknown people get a pairing code",
      "- allowlist: only listed people can DM",
      "- open: anyone can DM",
      "- disabled: ignore DMs",
      "",
      `Current: dmPolicy=${existingPolicy}, allowFrom=${existingLabel}`,
      "If you choose allowlist now, you can leave it empty and add people later.",
    ].join("\n"),
    ZALOUSER_DM_ACCESS_TITLE,
  );

  const policy = (await prompter.select({
    message: "Zalo Personal DM policy",
    options: [
      { value: "pairing", label: "Pairing (recommended)" },
      { value: "allowlist", label: "Allowlist (specific users only)" },
      { value: "open", label: "Open (public inbound DMs)" },
      { value: "disabled", label: "Disabled (ignore DMs)" },
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
    configuredLabel: "logged in",
    unconfiguredLabel: "needs QR login",
    configuredHint: "recommended · logged in",
    unconfiguredHint: "recommended · QR login",
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
        message: "Login via QR code now?",
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
                ? `QR image saved to: ${qrPath}`
                : "Could not write QR image file; use gateway web login UI instead.",
              "Scan + approve on phone, then continue.",
            ].join("\n"),
            "QR Login",
          );
          const scanned = await prompter.confirm({
            message: "Did you scan and approve the QR on your phone?",
            initialValue: true,
          });
          if (scanned) {
            const waited = await waitForZaloQrLogin({
              profile: account.profile,
              timeoutMs: 120_000,
            });
            await prompter.note(waited.message, waited.connected ? "Success" : "Login pending");
          }
        } else {
          await prompter.note(start.message, "Login pending");
        }
      }
    } else {
      const keepSession = await prompter.confirm({
        message: "Zalo Personal already logged in. Keep session?",
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
            [start.message, qrPath ? `QR image saved to: ${qrPath}` : undefined]
              .filter(Boolean)
              .join("\n"),
            "QR Login",
          );
          const waited = await waitForZaloQrLogin({ profile: account.profile, timeoutMs: 120_000 });
          await prompter.note(waited.message, waited.connected ? "Success" : "Login pending");
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
            "No group allowlist entries added yet.",
            "Group chats will stay blocked until you add groups later.",
            `Tip: use \`${formatCliCommand("openclaw directory groups list --channel zalouser")}\` after onboarding to find group IDs.`,
            "Mention requirement stays on by default for groups you allow later.",
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
          `Group lookup failed; keeping entries as typed. ${String(err)}`,
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
