import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/routing";
import type {
  ChannelSetupDmPolicy,
  ChannelSetupWizard,
  WizardPrompter,
} from "openclaw/plugin-sdk/setup";
import {
  createAllowFromSection,
  createPromptParsedAllowFromForAccount,
  createStandardChannelSetupStatus,
  formatDocsLink,
  setSetupChannelEnabled,
} from "openclaw/plugin-sdk/setup";
import {
  normalizeOptionalString,
  normalizeStringifiedOptionalString,
} from "openclaw/plugin-sdk/text-runtime";
import { resolveDefaultIrcAccountId, resolveIrcAccount } from "./accounts.js";
import {
  isChannelTarget,
  normalizeIrcAllowEntry,
  normalizeIrcMessagingTarget,
} from "./normalize.js";
import {
  ircSetupAdapter,
  parsePort,
  setIrcAllowFrom,
  setIrcDmPolicy,
  setIrcGroupAccess,
  setIrcNickServ,
  updateIrcAccountConfig,
} from "./setup-core.js";
import type { CoreConfig } from "./types.js";

const channel = "irc" as const;
const USE_ENV_FLAG = "__ircUseEnv";
const TLS_FLAG = "__ircTls";

function parseListInput(raw: string): string[] {
  return raw
    .split(/[\n,;]+/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeGroupEntry(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed === "*") {
    return "*";
  }
  const normalized = normalizeIrcMessagingTarget(trimmed) ?? trimmed;
  if (isChannelTarget(normalized)) {
    return normalized;
  }
  return `#${normalized.replace(/^#+/, "")}`;
}

const promptIrcAllowFrom = createPromptParsedAllowFromForAccount<CoreConfig>({
  defaultAccountId: (cfg) => resolveDefaultIrcAccountId(cfg),
  noteTitle: "IRC allowlist",
  noteLines: [
    "Allowlist IRC DMs by sender.",
    "Examples:",
    "- alice",
    "- alice!ident@example.org",
    "Multiple entries: comma-separated.",
  ],
  message: "IRC allowFrom (nick or nick!user@host)",
  placeholder: "alice, bob!ident@example.org",
  parseEntries: (raw) => ({
    entries: parseListInput(raw)
      .map((entry) => normalizeIrcAllowEntry(entry))
      .map((entry) => entry.trim())
      .filter(Boolean),
  }),
  getExistingAllowFrom: ({ cfg }) => cfg.channels?.irc?.allowFrom ?? [],
  applyAllowFrom: ({ cfg, allowFrom }) => setIrcAllowFrom(cfg, allowFrom),
});

async function promptIrcNickServConfig(params: {
  cfg: CoreConfig;
  prompter: WizardPrompter;
  accountId: string;
}): Promise<CoreConfig> {
  const resolved = resolveIrcAccount({ cfg: params.cfg, accountId: params.accountId });
  const existing = resolved.config.nickserv;
  const hasExisting = Boolean(existing?.password || existing?.passwordFile);
  const wants = await params.prompter.confirm({
    message: hasExisting ? "Update NickServ settings?" : "Configure NickServ identify/register?",
    initialValue: hasExisting,
  });
  if (!wants) {
    return params.cfg;
  }

  const service = (
    await params.prompter.text({
      message: "NickServ service nick",
      initialValue: existing?.service || "NickServ",
      validate: (value) => (normalizeStringifiedOptionalString(value) ? undefined : "Required"),
    })
  ).trim();

  const useEnvPassword =
    params.accountId === DEFAULT_ACCOUNT_ID &&
    Boolean(process.env.IRC_NICKSERV_PASSWORD?.trim()) &&
    !(existing?.password || existing?.passwordFile)
      ? await params.prompter.confirm({
          message: "IRC_NICKSERV_PASSWORD detected. Use env var?",
          initialValue: true,
        })
      : false;

  const password = useEnvPassword
    ? undefined
    : (
        await params.prompter.text({
          message: "NickServ password (blank to disable NickServ auth)",
          validate: () => undefined,
        })
      ).trim();

  if (!password && !useEnvPassword) {
    return setIrcNickServ(params.cfg, params.accountId, {
      enabled: false,
      service,
    });
  }

  const register = await params.prompter.confirm({
    message: "Send NickServ REGISTER on connect?",
    initialValue: existing?.register ?? false,
  });
  const registerEmail = register
    ? (
        await params.prompter.text({
          message: "NickServ register email",
          initialValue:
            existing?.registerEmail ||
            (params.accountId === DEFAULT_ACCOUNT_ID
              ? process.env.IRC_NICKSERV_REGISTER_EMAIL
              : undefined),
          validate: (value) => (normalizeStringifiedOptionalString(value) ? undefined : "Required"),
        })
      ).trim()
    : undefined;

  return setIrcNickServ(params.cfg, params.accountId, {
    enabled: true,
    service,
    ...(password ? { password } : {}),
    register,
    ...(registerEmail ? { registerEmail } : {}),
  });
}

const ircDmPolicy: ChannelSetupDmPolicy = {
  label: "IRC",
  channel,
  policyKey: "channels.irc.dmPolicy",
  allowFromKey: "channels.irc.allowFrom",
  getCurrent: (cfg) => (cfg as CoreConfig).channels?.irc?.dmPolicy ?? "pairing",
  setPolicy: (cfg, policy) => setIrcDmPolicy(cfg as CoreConfig, policy),
  promptAllowFrom: async ({ cfg, prompter, accountId }) =>
    await promptIrcAllowFrom({
      cfg: cfg as CoreConfig,
      prompter,
      accountId,
    }),
};

export const ircSetupWizard: ChannelSetupWizard = {
  channel,
  status: createStandardChannelSetupStatus({
    channelLabel: "IRC",
    configuredLabel: "configured",
    unconfiguredLabel: "needs host + nick",
    configuredHint: "configured",
    unconfiguredHint: "needs host + nick",
    configuredScore: 1,
    unconfiguredScore: 0,
    includeStatusLine: true,
    resolveConfigured: ({ cfg, accountId }) =>
      resolveIrcAccount({ cfg: cfg as CoreConfig, accountId }).configured,
  }),
  introNote: {
    title: "IRC setup",
    lines: [
      "IRC needs server host + bot nick.",
      "Recommended: TLS on port 6697.",
      "Optional: NickServ identify/register can be configured after the basic account fields.",
      'Set channels.irc.groupPolicy="allowlist" and channels.irc.groups for tighter channel control.',
      'Note: IRC channels are mention-gated by default. To allow unmentioned replies, set channels.irc.groups["#channel"].requireMention=false (or "*" for all).',
      "Env vars supported: IRC_HOST, IRC_PORT, IRC_TLS, IRC_NICK, IRC_USERNAME, IRC_REALNAME, IRC_PASSWORD, IRC_CHANNELS, IRC_NICKSERV_PASSWORD, IRC_NICKSERV_REGISTER_EMAIL.",
      `Docs: ${formatDocsLink("/channels/irc", "channels/irc")}`,
    ],
    shouldShow: ({ cfg, accountId }) =>
      !resolveIrcAccount({ cfg: cfg as CoreConfig, accountId }).configured,
  },
  prepare: async ({ cfg, accountId, credentialValues, prompter }) => {
    const resolved = resolveIrcAccount({ cfg: cfg as CoreConfig, accountId });
    const isDefaultAccount = accountId === DEFAULT_ACCOUNT_ID;
    const envHost = isDefaultAccount ? (normalizeOptionalString(process.env.IRC_HOST) ?? "") : "";
    const envNick = isDefaultAccount ? (normalizeOptionalString(process.env.IRC_NICK) ?? "") : "";
    const envReady = Boolean(envHost && envNick && !resolved.config.host && !resolved.config.nick);

    if (envReady) {
      const useEnv = await prompter.confirm({
        message: "IRC_HOST and IRC_NICK detected. Use env vars?",
        initialValue: true,
      });
      if (useEnv) {
        return {
          cfg: updateIrcAccountConfig(cfg as CoreConfig, accountId, { enabled: true }),
          credentialValues: {
            ...credentialValues,
            [USE_ENV_FLAG]: "1",
          },
        };
      }
    }

    const tls = await prompter.confirm({
      message: "Use TLS for IRC?",
      initialValue: resolved.config.tls ?? true,
    });
    return {
      cfg: updateIrcAccountConfig(cfg as CoreConfig, accountId, {
        enabled: true,
        tls,
      }),
      credentialValues: {
        ...credentialValues,
        [USE_ENV_FLAG]: "0",
        [TLS_FLAG]: tls ? "1" : "0",
      },
    };
  },
  credentials: [],
  textInputs: [
    {
      inputKey: "httpHost",
      message: "IRC server host",
      currentValue: ({ cfg, accountId }) =>
        resolveIrcAccount({ cfg: cfg as CoreConfig, accountId }).config.host || undefined,
      shouldPrompt: ({ credentialValues }) => credentialValues[USE_ENV_FLAG] !== "1",
      validate: ({ value }) => (normalizeStringifiedOptionalString(value) ? undefined : "Required"),
      normalizeValue: ({ value }) => normalizeStringifiedOptionalString(value) ?? "",
      applySet: async ({ cfg, accountId, value }) =>
        updateIrcAccountConfig(cfg as CoreConfig, accountId, {
          enabled: true,
          host: value,
        }),
    },
    {
      inputKey: "httpPort",
      message: "IRC server port",
      currentValue: ({ cfg, accountId }) =>
        String(resolveIrcAccount({ cfg: cfg as CoreConfig, accountId }).config.port ?? ""),
      shouldPrompt: ({ credentialValues }) => credentialValues[USE_ENV_FLAG] !== "1",
      initialValue: ({ cfg, accountId, credentialValues }) => {
        const resolved = resolveIrcAccount({ cfg: cfg as CoreConfig, accountId });
        const tls = credentialValues[TLS_FLAG] !== "0";
        const defaultPort = resolved.config.port ?? (tls ? 6697 : 6667);
        return String(defaultPort);
      },
      validate: ({ value }) => {
        const parsed = Number.parseInt(normalizeStringifiedOptionalString(value) ?? "", 10);
        return Number.isFinite(parsed) && parsed >= 1 && parsed <= 65535
          ? undefined
          : "Use a port between 1 and 65535";
      },
      normalizeValue: ({ value }) => String(parsePort(value, 6697)),
      applySet: async ({ cfg, accountId, value }) =>
        updateIrcAccountConfig(cfg as CoreConfig, accountId, {
          enabled: true,
          port: parsePort(value, 6697),
        }),
    },
    {
      inputKey: "token",
      message: "IRC nick",
      currentValue: ({ cfg, accountId }) =>
        resolveIrcAccount({ cfg: cfg as CoreConfig, accountId }).config.nick || undefined,
      shouldPrompt: ({ credentialValues }) => credentialValues[USE_ENV_FLAG] !== "1",
      validate: ({ value }) => (normalizeStringifiedOptionalString(value) ? undefined : "Required"),
      normalizeValue: ({ value }) => normalizeStringifiedOptionalString(value) ?? "",
      applySet: async ({ cfg, accountId, value }) =>
        updateIrcAccountConfig(cfg as CoreConfig, accountId, {
          enabled: true,
          nick: value,
        }),
    },
    {
      inputKey: "userId",
      message: "IRC username",
      currentValue: ({ cfg, accountId }) =>
        resolveIrcAccount({ cfg: cfg as CoreConfig, accountId }).config.username || undefined,
      shouldPrompt: ({ credentialValues }) => credentialValues[USE_ENV_FLAG] !== "1",
      initialValue: ({ cfg, accountId, credentialValues }) =>
        resolveIrcAccount({ cfg: cfg as CoreConfig, accountId }).config.username ||
        credentialValues.token ||
        "openclaw",
      validate: ({ value }) => (normalizeStringifiedOptionalString(value) ? undefined : "Required"),
      normalizeValue: ({ value }) => normalizeStringifiedOptionalString(value) ?? "",
      applySet: async ({ cfg, accountId, value }) =>
        updateIrcAccountConfig(cfg as CoreConfig, accountId, {
          enabled: true,
          username: value,
        }),
    },
    {
      inputKey: "deviceName",
      message: "IRC real name",
      currentValue: ({ cfg, accountId }) =>
        resolveIrcAccount({ cfg: cfg as CoreConfig, accountId }).config.realname || undefined,
      shouldPrompt: ({ credentialValues }) => credentialValues[USE_ENV_FLAG] !== "1",
      initialValue: ({ cfg, accountId }) =>
        resolveIrcAccount({ cfg: cfg as CoreConfig, accountId }).config.realname || "OpenClaw",
      validate: ({ value }) => (normalizeStringifiedOptionalString(value) ? undefined : "Required"),
      normalizeValue: ({ value }) => normalizeStringifiedOptionalString(value) ?? "",
      applySet: async ({ cfg, accountId, value }) =>
        updateIrcAccountConfig(cfg as CoreConfig, accountId, {
          enabled: true,
          realname: value,
        }),
    },
    {
      inputKey: "groupChannels",
      message: "Auto-join IRC channels (optional, comma-separated)",
      placeholder: "#openclaw, #ops",
      required: false,
      applyEmptyValue: true,
      currentValue: ({ cfg, accountId }) =>
        resolveIrcAccount({ cfg: cfg as CoreConfig, accountId }).config.channels?.join(", "),
      shouldPrompt: ({ credentialValues }) => credentialValues[USE_ENV_FLAG] !== "1",
      normalizeValue: ({ value }) =>
        parseListInput(value)
          .map((entry) => normalizeGroupEntry(entry))
          .filter((entry): entry is string => Boolean(entry && entry !== "*"))
          .filter((entry) => isChannelTarget(entry))
          .join(", "),
      applySet: async ({ cfg, accountId, value }) => {
        const channels = parseListInput(value)
          .map((entry) => normalizeGroupEntry(entry))
          .filter((entry): entry is string => Boolean(entry && entry !== "*"))
          .filter((entry) => isChannelTarget(entry));
        return updateIrcAccountConfig(cfg as CoreConfig, accountId, {
          enabled: true,
          channels: channels.length > 0 ? channels : undefined,
        });
      },
    },
  ],
  groupAccess: {
    label: "IRC channels",
    placeholder: "#openclaw, #ops, *",
    currentPolicy: ({ cfg, accountId }) =>
      resolveIrcAccount({ cfg: cfg as CoreConfig, accountId }).config.groupPolicy ?? "allowlist",
    currentEntries: ({ cfg, accountId }) =>
      Object.keys(resolveIrcAccount({ cfg: cfg as CoreConfig, accountId }).config.groups ?? {}),
    updatePrompt: ({ cfg, accountId }) =>
      Boolean(resolveIrcAccount({ cfg: cfg as CoreConfig, accountId }).config.groups),
    setPolicy: ({ cfg, accountId, policy }) =>
      setIrcGroupAccess(cfg as CoreConfig, accountId, policy, [], normalizeGroupEntry),
    resolveAllowlist: async ({ entries }) =>
      [...new Set(entries.map((entry) => normalizeGroupEntry(entry)).filter(Boolean))] as string[],
    applyAllowlist: ({ cfg, accountId, resolved }) =>
      setIrcGroupAccess(
        cfg as CoreConfig,
        accountId,
        "allowlist",
        resolved as string[],
        normalizeGroupEntry,
      ),
  },
  allowFrom: createAllowFromSection({
    helpTitle: "IRC allowlist",
    helpLines: [
      "Allowlist IRC DMs by sender.",
      "Examples:",
      "- alice",
      "- alice!ident@example.org",
      "Multiple entries: comma-separated.",
    ],
    message: "IRC allowFrom (nick or nick!user@host)",
    placeholder: "alice, bob!ident@example.org",
    invalidWithoutCredentialNote: "Use an IRC nick or nick!user@host entry.",
    parseId: (raw) => {
      const normalized = normalizeIrcAllowEntry(raw);
      return normalized || null;
    },
    apply: async ({ cfg, allowFrom }) => setIrcAllowFrom(cfg as CoreConfig, allowFrom),
  }),
  finalize: async ({ cfg, accountId, prompter }) => {
    let next = cfg as CoreConfig;

    const resolvedAfterGroups = resolveIrcAccount({ cfg: next, accountId });
    if (resolvedAfterGroups.config.groupPolicy === "allowlist") {
      const groupKeys = Object.keys(resolvedAfterGroups.config.groups ?? {});
      if (groupKeys.length > 0) {
        const wantsMentions = await prompter.confirm({
          message: "Require @mention to reply in IRC channels?",
          initialValue: true,
        });
        if (!wantsMentions) {
          const groups = resolvedAfterGroups.config.groups ?? {};
          const patched = Object.fromEntries(
            Object.entries(groups).map(([key, value]) => [
              key,
              { ...value, requireMention: false },
            ]),
          );
          next = updateIrcAccountConfig(next, accountId, { groups: patched });
        }
      }
    }

    next = await promptIrcNickServConfig({
      cfg: next,
      prompter,
      accountId,
    });
    return { cfg: next };
  },
  completionNote: {
    title: "IRC next steps",
    lines: [
      "Next: restart gateway and verify status.",
      "Command: openclaw channels status --probe",
      `Docs: ${formatDocsLink("/channels/irc", "channels/irc")}`,
    ],
  },
  dmPolicy: ircDmPolicy,
  disable: (cfg) => setSetupChannelEnabled(cfg, channel, false),
};

export { ircSetupAdapter };
