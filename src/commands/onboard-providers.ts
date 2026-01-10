import fs from "node:fs/promises";
import path from "node:path";
import type { ClawdbotConfig } from "../config/config.js";
import { mergeWhatsAppConfig } from "../config/merge-config.js";
import type { DmPolicy } from "../config/types.js";
import {
  listDiscordAccountIds,
  resolveDefaultDiscordAccountId,
  resolveDiscordAccount,
} from "../discord/accounts.js";
import {
  listIMessageAccountIds,
  resolveDefaultIMessageAccountId,
  resolveIMessageAccount,
} from "../imessage/accounts.js";
import { loginWeb } from "../provider-web.js";
import {
  formatProviderPrimerLine,
  formatProviderSelectionLine,
  listChatProviders,
} from "../providers/registry.js";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
} from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  listSignalAccountIds,
  resolveDefaultSignalAccountId,
  resolveSignalAccount,
} from "../signal/accounts.js";
import {
  listSlackAccountIds,
  resolveDefaultSlackAccountId,
  resolveSlackAccount,
} from "../slack/accounts.js";
import {
  listTelegramAccountIds,
  resolveDefaultTelegramAccountId,
  resolveTelegramAccount,
} from "../telegram/accounts.js";
import { formatDocsLink } from "../terminal/links.js";
import { normalizeE164 } from "../utils.js";
import {
  listWhatsAppAccountIds,
  resolveDefaultWhatsAppAccountId,
  resolveWhatsAppAuthDir,
} from "../web/accounts.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { detectBinary } from "./onboard-helpers.js";
import type { ProviderChoice } from "./onboard-types.js";
import { installSignalCli } from "./signal-install.js";

async function promptAccountId(params: {
  cfg: ClawdbotConfig;
  prompter: WizardPrompter;
  label: string;
  currentId?: string;
  listAccountIds: (cfg: ClawdbotConfig) => string[];
  defaultAccountId: string;
}): Promise<string> {
  const existingIds = params.listAccountIds(params.cfg);
  const initial =
    params.currentId?.trim() || params.defaultAccountId || DEFAULT_ACCOUNT_ID;
  const choice = (await params.prompter.select({
    message: `${params.label} account`,
    options: [
      ...existingIds.map((id) => ({
        value: id,
        label: id === DEFAULT_ACCOUNT_ID ? "default (primary)" : id,
      })),
      { value: "__new__", label: "Add a new account" },
    ],
    initialValue: initial,
  })) as string;

  if (choice !== "__new__") return normalizeAccountId(choice);

  const entered = await params.prompter.text({
    message: `New ${params.label} account id`,
    validate: (value) => (value?.trim() ? undefined : "Required"),
  });
  const normalized = normalizeAccountId(String(entered));
  if (String(entered).trim() !== normalized) {
    await params.prompter.note(
      `Normalized account id to "${normalized}".`,
      `${params.label} account`,
    );
  }
  return normalized;
}

function addWildcardAllowFrom(
  allowFrom?: Array<string | number> | null,
): Array<string | number> {
  const next = (allowFrom ?? []).map((v) => String(v).trim()).filter(Boolean);
  if (!next.includes("*")) next.push("*");
  return next;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function detectWhatsAppLinked(
  cfg: ClawdbotConfig,
  accountId: string,
): Promise<boolean> {
  const { authDir } = resolveWhatsAppAuthDir({ cfg, accountId });
  const credsPath = path.join(authDir, "creds.json");
  return await pathExists(credsPath);
}

async function noteProviderPrimer(prompter: WizardPrompter): Promise<void> {
  const providerLines = listChatProviders().map((meta) =>
    formatProviderPrimerLine(meta),
  );
  await prompter.note(
    [
      "DM security: default is pairing; unknown DMs get a pairing code.",
      "Approve with: clawdbot pairing approve <provider> <code>",
      'Public DMs require dmPolicy="open" + allowFrom=["*"].',
      `Docs: ${formatDocsLink("/start/pairing", "start/pairing")}`,
      "",
      ...providerLines,
    ].join("\n"),
    "How providers work",
  );
}

async function noteTelegramTokenHelp(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      "1) Open Telegram and chat with @BotFather",
      "2) Run /newbot (or /mybots)",
      "3) Copy the token (looks like 123456:ABC...)",
      "Tip: you can also set TELEGRAM_BOT_TOKEN in your env.",
      `Docs: ${formatDocsLink("/telegram")}`,
      "Website: https://clawd.bot",
    ].join("\n"),
    "Telegram bot token",
  );
}

async function noteDiscordTokenHelp(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      "1) Discord Developer Portal → Applications → New Application",
      "2) Bot → Add Bot → Reset Token → copy token",
      "3) OAuth2 → URL Generator → scope 'bot' → invite to your server",
      "Tip: enable Message Content Intent if you need message text.",
      `Docs: ${formatDocsLink("/discord", "discord")}`,
    ].join("\n"),
    "Discord bot token",
  );
}

function buildSlackManifest(botName: string) {
  const safeName = botName.trim() || "Clawdbot";
  const manifest = {
    display_information: {
      name: safeName,
      description: `${safeName} connector for Clawdbot`,
    },
    features: {
      bot_user: {
        display_name: safeName,
        always_online: false,
      },
      app_home: {
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
      },
      slash_commands: [
        {
          command: "/clawd",
          description: "Send a message to Clawdbot",
          should_escape: false,
        },
      ],
    },
    oauth_config: {
      scopes: {
        bot: [
          "chat:write",
          "channels:history",
          "channels:read",
          "groups:history",
          "im:history",
          "mpim:history",
          "users:read",
          "app_mentions:read",
          "reactions:read",
          "reactions:write",
          "pins:read",
          "pins:write",
          "emoji:read",
          "commands",
          "files:read",
          "files:write",
        ],
      },
    },
    settings: {
      socket_mode_enabled: true,
      event_subscriptions: {
        bot_events: [
          "app_mention",
          "message.channels",
          "message.groups",
          "message.im",
          "message.mpim",
          "reaction_added",
          "reaction_removed",
          "member_joined_channel",
          "member_left_channel",
          "channel_rename",
          "pin_added",
          "pin_removed",
        ],
      },
    },
  };
  return JSON.stringify(manifest, null, 2);
}

async function noteSlackTokenHelp(
  prompter: WizardPrompter,
  botName: string,
): Promise<void> {
  const manifest = buildSlackManifest(botName);
  await prompter.note(
    [
      "1) Slack API → Create App → From scratch",
      "2) Add Socket Mode + enable it to get the app-level token (xapp-...)",
      "3) OAuth & Permissions → install app to workspace (xoxb- bot token)",
      "4) Enable Event Subscriptions (socket) for message events",
      "5) App Home → enable the Messages tab for DMs",
      "Tip: set SLACK_BOT_TOKEN + SLACK_APP_TOKEN in your env.",
      `Docs: ${formatDocsLink("/slack", "slack")}`,
      "",
      "Manifest (JSON):",
      manifest,
    ].join("\n"),
    "Slack socket mode tokens",
  );
}

export { mergeWhatsAppConfig };

export function setWhatsAppDmPolicy(
  cfg: ClawdbotConfig,
  dmPolicy: DmPolicy,
): ClawdbotConfig {
  return mergeWhatsAppConfig(cfg, { dmPolicy });
}

export function setWhatsAppAllowFrom(
  cfg: ClawdbotConfig,
  allowFrom?: string[],
): ClawdbotConfig {
  return mergeWhatsAppConfig(
    cfg,
    { allowFrom },
    { unsetOnUndefined: ["allowFrom"] },
  );
}

function setMessagesResponsePrefix(
  cfg: ClawdbotConfig,
  responsePrefix?: string,
): ClawdbotConfig {
  return {
    ...cfg,
    messages: {
      ...cfg.messages,
      responsePrefix,
    },
  };
}

export function setWhatsAppSelfChatMode(
  cfg: ClawdbotConfig,
  selfChatMode: boolean,
): ClawdbotConfig {
  return mergeWhatsAppConfig(cfg, { selfChatMode });
}

function setTelegramDmPolicy(cfg: ClawdbotConfig, dmPolicy: DmPolicy) {
  const allowFrom =
    dmPolicy === "open"
      ? addWildcardAllowFrom(cfg.telegram?.allowFrom)
      : undefined;
  return {
    ...cfg,
    telegram: {
      ...cfg.telegram,
      dmPolicy,
      ...(allowFrom ? { allowFrom } : {}),
    },
  };
}

function setDiscordDmPolicy(cfg: ClawdbotConfig, dmPolicy: DmPolicy) {
  const allowFrom =
    dmPolicy === "open"
      ? addWildcardAllowFrom(cfg.discord?.dm?.allowFrom)
      : undefined;
  return {
    ...cfg,
    discord: {
      ...cfg.discord,
      dm: {
        ...cfg.discord?.dm,
        enabled: cfg.discord?.dm?.enabled ?? true,
        policy: dmPolicy,
        ...(allowFrom ? { allowFrom } : {}),
      },
    },
  };
}

function setSlackDmPolicy(cfg: ClawdbotConfig, dmPolicy: DmPolicy) {
  const allowFrom =
    dmPolicy === "open"
      ? addWildcardAllowFrom(cfg.slack?.dm?.allowFrom)
      : undefined;
  return {
    ...cfg,
    slack: {
      ...cfg.slack,
      dm: {
        ...cfg.slack?.dm,
        enabled: cfg.slack?.dm?.enabled ?? true,
        policy: dmPolicy,
        ...(allowFrom ? { allowFrom } : {}),
      },
    },
  };
}

function setSignalDmPolicy(cfg: ClawdbotConfig, dmPolicy: DmPolicy) {
  const allowFrom =
    dmPolicy === "open"
      ? addWildcardAllowFrom(cfg.signal?.allowFrom)
      : undefined;
  return {
    ...cfg,
    signal: {
      ...cfg.signal,
      dmPolicy,
      ...(allowFrom ? { allowFrom } : {}),
    },
  };
}

function setIMessageDmPolicy(cfg: ClawdbotConfig, dmPolicy: DmPolicy) {
  const allowFrom =
    dmPolicy === "open"
      ? addWildcardAllowFrom(cfg.imessage?.allowFrom)
      : undefined;
  return {
    ...cfg,
    imessage: {
      ...cfg.imessage,
      dmPolicy,
      ...(allowFrom ? { allowFrom } : {}),
    },
  };
}

async function maybeConfigureDmPolicies(params: {
  cfg: ClawdbotConfig;
  selection: ProviderChoice[];
  prompter: WizardPrompter;
}): Promise<ClawdbotConfig> {
  const { selection, prompter } = params;
  const supportsDmPolicy = selection.some((p) =>
    ["telegram", "discord", "slack", "signal", "imessage"].includes(p),
  );
  if (!supportsDmPolicy) return params.cfg;

  const wants = await prompter.confirm({
    message: "Configure DM access policies now? (default: pairing)",
    initialValue: false,
  });
  if (!wants) return params.cfg;

  let cfg = params.cfg;
  const selectPolicy = async (params: {
    label: string;
    provider: ProviderChoice;
    policyKey: string;
    allowFromKey: string;
  }) => {
    await prompter.note(
      [
        "Default: pairing (unknown DMs get a pairing code).",
        `Approve: clawdbot pairing approve ${params.provider} <code>`,
        `Public DMs: ${params.policyKey}="open" + ${params.allowFromKey} includes "*".`,
        `Docs: ${formatDocsLink("/start/pairing", "start/pairing")}`,
      ].join("\n"),
      `${params.label} DM access`,
    );
    return (await prompter.select({
      message: `${params.label} DM policy`,
      options: [
        { value: "pairing", label: "Pairing (recommended)" },
        { value: "open", label: "Open (public inbound DMs)" },
        { value: "disabled", label: "Disabled (ignore DMs)" },
      ],
    })) as DmPolicy;
  };

  if (selection.includes("telegram")) {
    const current = cfg.telegram?.dmPolicy ?? "pairing";
    const policy = await selectPolicy({
      label: "Telegram",
      provider: "telegram",
      policyKey: "telegram.dmPolicy",
      allowFromKey: "telegram.allowFrom",
    });
    if (policy !== current) cfg = setTelegramDmPolicy(cfg, policy);
  }
  if (selection.includes("discord")) {
    const current = cfg.discord?.dm?.policy ?? "pairing";
    const policy = await selectPolicy({
      label: "Discord",
      provider: "discord",
      policyKey: "discord.dm.policy",
      allowFromKey: "discord.dm.allowFrom",
    });
    if (policy !== current) cfg = setDiscordDmPolicy(cfg, policy);
  }
  if (selection.includes("slack")) {
    const current = cfg.slack?.dm?.policy ?? "pairing";
    const policy = await selectPolicy({
      label: "Slack",
      provider: "slack",
      policyKey: "slack.dm.policy",
      allowFromKey: "slack.dm.allowFrom",
    });
    if (policy !== current) cfg = setSlackDmPolicy(cfg, policy);
  }
  if (selection.includes("signal")) {
    const current = cfg.signal?.dmPolicy ?? "pairing";
    const policy = await selectPolicy({
      label: "Signal",
      provider: "signal",
      policyKey: "signal.dmPolicy",
      allowFromKey: "signal.allowFrom",
    });
    if (policy !== current) cfg = setSignalDmPolicy(cfg, policy);
  }
  if (selection.includes("imessage")) {
    const current = cfg.imessage?.dmPolicy ?? "pairing";
    const policy = await selectPolicy({
      label: "iMessage",
      provider: "imessage",
      policyKey: "imessage.dmPolicy",
      allowFromKey: "imessage.allowFrom",
    });
    if (policy !== current) cfg = setIMessageDmPolicy(cfg, policy);
  }
  return cfg;
}

async function promptTelegramAllowFrom(params: {
  cfg: ClawdbotConfig;
  prompter: WizardPrompter;
  accountId: string;
}): Promise<ClawdbotConfig> {
  const { cfg, prompter, accountId } = params;
  const resolved = resolveTelegramAccount({ cfg, accountId });
  const existingAllowFrom = resolved.config.allowFrom ?? [];
  const entry = await prompter.text({
    message: "Telegram allowFrom (user id)",
    placeholder: "123456789",
    initialValue: existingAllowFrom[0]
      ? String(existingAllowFrom[0])
      : undefined,
    validate: (value) => {
      const raw = String(value ?? "").trim();
      if (!raw) return "Required";
      if (!/^\d+$/.test(raw)) return "Use a numeric Telegram user id";
      return undefined;
    },
  });
  const normalized = String(entry).trim();
  const merged = [
    ...existingAllowFrom.map((item) => String(item).trim()).filter(Boolean),
    normalized,
  ];
  const unique = [...new Set(merged)];

  if (accountId === DEFAULT_ACCOUNT_ID) {
    return {
      ...cfg,
      telegram: {
        ...cfg.telegram,
        enabled: true,
        dmPolicy: "allowlist",
        allowFrom: unique,
      },
    };
  }

  return {
    ...cfg,
    telegram: {
      ...cfg.telegram,
      enabled: true,
      accounts: {
        ...cfg.telegram?.accounts,
        [accountId]: {
          ...cfg.telegram?.accounts?.[accountId],
          enabled: cfg.telegram?.accounts?.[accountId]?.enabled ?? true,
          dmPolicy: "allowlist",
          allowFrom: unique,
        },
      },
    },
  };
}

async function promptWhatsAppAllowFrom(
  cfg: ClawdbotConfig,
  _runtime: RuntimeEnv,
  prompter: WizardPrompter,
  options?: { forceAllowlist?: boolean },
): Promise<ClawdbotConfig> {
  const existingPolicy = cfg.whatsapp?.dmPolicy ?? "pairing";
  const existingAllowFrom = cfg.whatsapp?.allowFrom ?? [];
  const existingLabel =
    existingAllowFrom.length > 0 ? existingAllowFrom.join(", ") : "unset";
  const existingResponsePrefix = cfg.messages?.responsePrefix;

  if (options?.forceAllowlist) {
    await prompter.note(
      "We need the sender/owner number so Clawdbot can allowlist you.",
      "WhatsApp number",
    );
    const entry = await prompter.text({
      message:
        "Your personal WhatsApp number (the phone you will message from)",
      placeholder: "+15555550123",
      initialValue: existingAllowFrom[0],
      validate: (value) => {
        const raw = String(value ?? "").trim();
        if (!raw) return "Required";
        const normalized = normalizeE164(raw);
        if (!normalized) return `Invalid number: ${raw}`;
        return undefined;
      },
    });
    const normalized = normalizeE164(String(entry).trim());
    const merged = [
      ...existingAllowFrom
        .filter((item) => item !== "*")
        .map((item) => normalizeE164(item))
        .filter(Boolean),
      normalized,
    ];
    const unique = [...new Set(merged.filter(Boolean))];
    let next = setWhatsAppSelfChatMode(cfg, true);
    next = setWhatsAppDmPolicy(next, "allowlist");
    next = setWhatsAppAllowFrom(next, unique);
    if (existingResponsePrefix === undefined) {
      next = setMessagesResponsePrefix(next, "[clawdbot]");
    }
    await prompter.note(
      [
        "Allowlist mode enabled.",
        `- allowFrom includes ${normalized}`,
        existingResponsePrefix === undefined
          ? "- responsePrefix set to [clawdbot]"
          : "- responsePrefix left unchanged",
      ].join("\n"),
      "WhatsApp allowlist",
    );
    return next;
  }

  await prompter.note(
    [
      "WhatsApp direct chats are gated by `whatsapp.dmPolicy` + `whatsapp.allowFrom`.",
      "- pairing (default): unknown senders get a pairing code; owner approves",
      "- allowlist: unknown senders are blocked",
      '- open: public inbound DMs (requires allowFrom to include "*")',
      "- disabled: ignore WhatsApp DMs",
      "",
      `Current: dmPolicy=${existingPolicy}, allowFrom=${existingLabel}`,
      `Docs: ${formatDocsLink("/whatsapp", "whatsapp")}`,
    ].join("\n"),
    "WhatsApp DM access",
  );

  const phoneMode = (await prompter.select({
    message: "WhatsApp phone setup",
    options: [
      { value: "personal", label: "This is my personal phone number" },
      { value: "separate", label: "Separate phone just for Clawdbot" },
    ],
  })) as "personal" | "separate";

  if (phoneMode === "personal") {
    await prompter.note(
      "We need the sender/owner number so Clawdbot can allowlist you.",
      "WhatsApp number",
    );
    const entry = await prompter.text({
      message:
        "Your personal WhatsApp number (the phone you will message from)",
      placeholder: "+15555550123",
      initialValue: existingAllowFrom[0],
      validate: (value) => {
        const raw = String(value ?? "").trim();
        if (!raw) return "Required";
        const normalized = normalizeE164(raw);
        if (!normalized) return `Invalid number: ${raw}`;
        return undefined;
      },
    });
    const normalized = normalizeE164(String(entry).trim());
    const merged = [
      ...existingAllowFrom
        .filter((item) => item !== "*")
        .map((item) => normalizeE164(item))
        .filter(Boolean),
      normalized,
    ];
    const unique = [...new Set(merged.filter(Boolean))];
    let next = setWhatsAppSelfChatMode(cfg, true);
    next = setWhatsAppDmPolicy(next, "allowlist");
    next = setWhatsAppAllowFrom(next, unique);
    if (existingResponsePrefix === undefined) {
      next = setMessagesResponsePrefix(next, "[clawdbot]");
    }
    await prompter.note(
      [
        "Personal phone mode enabled.",
        "- dmPolicy set to allowlist (pairing skipped)",
        `- allowFrom includes ${normalized}`,
        existingResponsePrefix === undefined
          ? "- responsePrefix set to [clawdbot]"
          : "- responsePrefix left unchanged",
      ].join("\n"),
      "WhatsApp personal phone",
    );
    return next;
  }

  const policy = (await prompter.select({
    message: "WhatsApp DM policy",
    options: [
      { value: "pairing", label: "Pairing (recommended)" },
      { value: "allowlist", label: "Allowlist only (block unknown senders)" },
      { value: "open", label: "Open (public inbound DMs)" },
      { value: "disabled", label: "Disabled (ignore WhatsApp DMs)" },
    ],
  })) as DmPolicy;

  let next = setWhatsAppSelfChatMode(cfg, false);
  next = setWhatsAppDmPolicy(next, policy);
  if (policy === "open") {
    next = setWhatsAppAllowFrom(next, ["*"]);
  }
  if (policy === "disabled") return next;

  const allowOptions =
    existingAllowFrom.length > 0
      ? ([
          { value: "keep", label: "Keep current allowFrom" },
          {
            value: "unset",
            label: "Unset allowFrom (use pairing approvals only)",
          },
          { value: "list", label: "Set allowFrom to specific numbers" },
        ] as const)
      : ([
          { value: "unset", label: "Unset allowFrom (default)" },
          { value: "list", label: "Set allowFrom to specific numbers" },
        ] as const);

  const mode = (await prompter.select({
    message: "WhatsApp allowFrom (optional pre-allowlist)",
    options: allowOptions.map((opt) => ({
      value: opt.value,
      label: opt.label,
    })),
  })) as (typeof allowOptions)[number]["value"];

  if (mode === "keep") {
    // Keep allowFrom as-is.
  } else if (mode === "unset") {
    next = setWhatsAppAllowFrom(next, undefined);
  } else {
    const allowRaw = await prompter.text({
      message: "Allowed sender numbers (comma-separated, E.164)",
      placeholder: "+15555550123, +447700900123",
      validate: (value) => {
        const raw = String(value ?? "").trim();
        if (!raw) return "Required";
        const parts = raw
          .split(/[\n,;]+/g)
          .map((p) => p.trim())
          .filter(Boolean);
        if (parts.length === 0) return "Required";
        for (const part of parts) {
          if (part === "*") continue;
          const normalized = normalizeE164(part);
          if (!normalized) return `Invalid number: ${part}`;
        }
        return undefined;
      },
    });

    const parts = String(allowRaw)
      .split(/[\n,;]+/g)
      .map((p) => p.trim())
      .filter(Boolean);
    const normalized = parts.map((part) =>
      part === "*" ? "*" : normalizeE164(part),
    );
    const unique = [...new Set(normalized.filter(Boolean))];
    next = setWhatsAppAllowFrom(next, unique);
  }

  return next;
}

type SetupProvidersOptions = {
  allowDisable?: boolean;
  allowSignalInstall?: boolean;
  onSelection?: (selection: ProviderChoice[]) => void;
  accountIds?: Partial<Record<ProviderChoice, string>>;
  onAccountId?: (provider: ProviderChoice, accountId: string) => void;
  promptAccountIds?: boolean;
  whatsappAccountId?: string;
  promptWhatsAppAccountId?: boolean;
  onWhatsAppAccountId?: (accountId: string) => void;
  forceAllowFromProviders?: ProviderChoice[];
  skipDmPolicyPrompt?: boolean;
  skipConfirm?: boolean;
  quickstartDefaults?: boolean;
  initialSelection?: ProviderChoice[];
};

export async function setupProviders(
  cfg: ClawdbotConfig,
  runtime: RuntimeEnv,
  prompter: WizardPrompter,
  options?: SetupProvidersOptions,
): Promise<ClawdbotConfig> {
  const forceAllowFromProviders = new Set(
    options?.forceAllowFromProviders ?? [],
  );
  const forceTelegramAllowFrom = forceAllowFromProviders.has("telegram");
  const forceWhatsAppAllowFrom = forceAllowFromProviders.has("whatsapp");

  let whatsappAccountId =
    options?.whatsappAccountId?.trim() || resolveDefaultWhatsAppAccountId(cfg);
  let whatsappLinked = await detectWhatsAppLinked(cfg, whatsappAccountId);
  const telegramEnv = Boolean(process.env.TELEGRAM_BOT_TOKEN?.trim());
  const discordEnv = Boolean(process.env.DISCORD_BOT_TOKEN?.trim());
  const slackBotEnv = Boolean(process.env.SLACK_BOT_TOKEN?.trim());
  const slackAppEnv = Boolean(process.env.SLACK_APP_TOKEN?.trim());
  const telegramConfigured = listTelegramAccountIds(cfg).some((accountId) =>
    Boolean(resolveTelegramAccount({ cfg, accountId }).token),
  );
  const discordConfigured = listDiscordAccountIds(cfg).some((accountId) =>
    Boolean(resolveDiscordAccount({ cfg, accountId }).token),
  );
  const slackConfigured = listSlackAccountIds(cfg).some((accountId) => {
    const account = resolveSlackAccount({ cfg, accountId });
    return Boolean(account.botToken && account.appToken);
  });
  const signalConfigured = listSignalAccountIds(cfg).some(
    (accountId) => resolveSignalAccount({ cfg, accountId }).configured,
  );
  const signalCliPath = cfg.signal?.cliPath ?? "signal-cli";
  const signalCliDetected = await detectBinary(signalCliPath);
  const imessageConfigured = listIMessageAccountIds(cfg).some((accountId) => {
    const account = resolveIMessageAccount({ cfg, accountId });
    return Boolean(
      account.config.cliPath ||
        account.config.dbPath ||
        account.config.allowFrom ||
        account.config.service ||
        account.config.region,
    );
  });
  const imessageCliPath = cfg.imessage?.cliPath ?? "imsg";
  const imessageCliDetected = await detectBinary(imessageCliPath);

  const waAccountLabel =
    whatsappAccountId === DEFAULT_ACCOUNT_ID ? "default" : whatsappAccountId;
  await prompter.note(
    [
      `Telegram: ${telegramConfigured ? "configured" : "needs token"}`,
      `WhatsApp (${waAccountLabel}): ${whatsappLinked ? "linked" : "not linked"}`,
      `Discord: ${discordConfigured ? "configured" : "needs token"}`,
      `Slack: ${slackConfigured ? "configured" : "needs tokens"}`,
      `Signal: ${signalConfigured ? "configured" : "needs setup"}`,
      `iMessage: ${imessageConfigured ? "configured" : "needs setup"}`,
      `signal-cli: ${signalCliDetected ? "found" : "missing"} (${signalCliPath})`,
      `imsg: ${imessageCliDetected ? "found" : "missing"} (${imessageCliPath})`,
    ].join("\n"),
    "Provider status",
  );

  const shouldConfigure = options?.skipConfirm
    ? true
    : await prompter.confirm({
        message: "Configure chat providers now?",
        initialValue: true,
      });
  if (!shouldConfigure) return cfg;

  await noteProviderPrimer(prompter);

  const selectionOptions = listChatProviders().map((meta) => {
    switch (meta.id) {
      case "telegram":
        return {
          value: meta.id,
          label: meta.selectionLabel,
          hint: telegramConfigured
            ? "recommended · configured"
            : "recommended · newcomer-friendly",
        };
      case "whatsapp":
        return {
          value: meta.id,
          label: meta.selectionLabel,
          hint: whatsappLinked ? "linked" : "not linked",
        };
      case "discord":
        return {
          value: meta.id,
          label: meta.selectionLabel,
          hint: discordConfigured ? "configured" : "needs token",
        };
      case "slack":
        return {
          value: meta.id,
          label: meta.selectionLabel,
          hint: slackConfigured ? "configured" : "needs tokens",
        };
      case "signal":
        return {
          value: meta.id,
          label: meta.selectionLabel,
          hint: signalCliDetected ? "signal-cli found" : "signal-cli missing",
        };
      case "imessage":
        return {
          value: meta.id,
          label: meta.selectionLabel,
          hint: imessageCliDetected ? "imsg found" : "imsg missing",
        };
      default:
        return {
          value: meta.id,
          label: meta.selectionLabel,
        };
    }
  });

  let selection: ProviderChoice[];
  if (options?.quickstartDefaults) {
    const choice = (await prompter.select({
      message: "Select provider (QuickStart)",
      options: [
        ...selectionOptions,
        {
          value: "__skip__",
          label: "Skip for now",
          hint: "You can add providers later via `clawdbot providers add`",
        },
      ],
      initialValue:
        options?.initialSelection?.[0] ??
        (!telegramConfigured ? "telegram" : "whatsapp"),
    })) as ProviderChoice | "__skip__";
    selection = choice === "__skip__" ? [] : [choice];
  } else {
    const initialSelection = options?.initialSelection ?? [];
    selection = (await prompter.multiselect({
      message: "Select providers (Space to toggle, Enter to continue)",
      options: selectionOptions,
      initialValues: initialSelection.length ? initialSelection : undefined,
    })) as ProviderChoice[];
  }

  options?.onSelection?.(selection);
  const accountOverrides: Partial<Record<ProviderChoice, string>> = {
    ...options?.accountIds,
  };
  if (options?.whatsappAccountId?.trim()) {
    accountOverrides.whatsapp = options.whatsappAccountId.trim();
  }
  const recordAccount = (provider: ProviderChoice, accountId: string) => {
    options?.onAccountId?.(provider, accountId);
    if (provider === "whatsapp") {
      options?.onWhatsAppAccountId?.(accountId);
    }
  };

  const selectionNotes = new Map(
    listChatProviders().map((meta) => [
      meta.id,
      formatProviderSelectionLine(meta, formatDocsLink),
    ]),
  );
  const selectedLines = selection
    .map((provider) => selectionNotes.get(provider))
    .filter((line): line is string => Boolean(line));
  if (selectedLines.length > 0) {
    await prompter.note(selectedLines.join("\n"), "Selected providers");
  }

  const shouldPromptAccountIds = options?.promptAccountIds === true;

  let next = cfg;

  if (selection.includes("whatsapp")) {
    const overrideId = accountOverrides.whatsapp?.trim();
    if (overrideId) {
      whatsappAccountId = normalizeAccountId(overrideId);
    } else if (shouldPromptAccountIds || options?.promptWhatsAppAccountId) {
      whatsappAccountId = await promptAccountId({
        cfg: next,
        prompter,
        label: "WhatsApp",
        currentId: whatsappAccountId,
        listAccountIds: listWhatsAppAccountIds,
        defaultAccountId: resolveDefaultWhatsAppAccountId(next),
      });
    }

    if (whatsappAccountId !== DEFAULT_ACCOUNT_ID) {
      next = {
        ...next,
        whatsapp: {
          ...next.whatsapp,
          accounts: {
            ...next.whatsapp?.accounts,
            [whatsappAccountId]: {
              ...next.whatsapp?.accounts?.[whatsappAccountId],
              enabled:
                next.whatsapp?.accounts?.[whatsappAccountId]?.enabled ?? true,
            },
          },
        },
      };
    }

    recordAccount("whatsapp", whatsappAccountId);
    whatsappLinked = await detectWhatsAppLinked(next, whatsappAccountId);
    const { authDir } = resolveWhatsAppAuthDir({
      cfg: next,
      accountId: whatsappAccountId,
    });

    if (!whatsappLinked) {
      await prompter.note(
        [
          "Scan the QR with WhatsApp on your phone.",
          `Credentials are stored under ${authDir}/ for future runs.`,
          `Docs: ${formatDocsLink("/whatsapp", "whatsapp")}`,
        ].join("\n"),
        "WhatsApp linking",
      );
    }
    const wantsLink = await prompter.confirm({
      message: whatsappLinked
        ? "WhatsApp already linked. Re-link now?"
        : "Link WhatsApp now (QR)?",
      initialValue: !whatsappLinked,
    });
    if (wantsLink) {
      try {
        await loginWeb(false, "web", undefined, runtime, whatsappAccountId);
      } catch (err) {
        runtime.error(`WhatsApp login failed: ${String(err)}`);
        await prompter.note(
          `Docs: ${formatDocsLink("/whatsapp", "whatsapp")}`,
          "WhatsApp help",
        );
      }
    } else if (!whatsappLinked) {
      await prompter.note(
        "Run `clawdbot providers login` later to link WhatsApp.",
        "WhatsApp",
      );
    }

    next = await promptWhatsAppAllowFrom(next, runtime, prompter, {
      forceAllowlist: forceWhatsAppAllowFrom,
    });
  }

  if (selection.includes("telegram")) {
    const telegramOverride = accountOverrides.telegram?.trim();
    const defaultTelegramAccountId = resolveDefaultTelegramAccountId(next);
    let telegramAccountId = telegramOverride
      ? normalizeAccountId(telegramOverride)
      : defaultTelegramAccountId;
    if (shouldPromptAccountIds && !telegramOverride) {
      telegramAccountId = await promptAccountId({
        cfg: next,
        prompter,
        label: "Telegram",
        currentId: telegramAccountId,
        listAccountIds: listTelegramAccountIds,
        defaultAccountId: defaultTelegramAccountId,
      });
    }
    recordAccount("telegram", telegramAccountId);

    const resolvedAccount = resolveTelegramAccount({
      cfg: next,
      accountId: telegramAccountId,
    });
    const accountConfigured = Boolean(resolvedAccount.token);
    const allowEnv = telegramAccountId === DEFAULT_ACCOUNT_ID;
    const canUseEnv = allowEnv && telegramEnv;
    const hasConfigToken = Boolean(
      resolvedAccount.config.botToken || resolvedAccount.config.tokenFile,
    );

    let token: string | null = null;
    if (!accountConfigured) {
      await noteTelegramTokenHelp(prompter);
    }
    if (canUseEnv && !resolvedAccount.config.botToken) {
      const keepEnv = await prompter.confirm({
        message: "TELEGRAM_BOT_TOKEN detected. Use env var?",
        initialValue: true,
      });
      if (keepEnv) {
        next = {
          ...next,
          telegram: {
            ...next.telegram,
            enabled: true,
          },
        };
      } else {
        token = String(
          await prompter.text({
            message: "Enter Telegram bot token",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
      }
    } else if (hasConfigToken) {
      const keep = await prompter.confirm({
        message: "Telegram token already configured. Keep it?",
        initialValue: true,
      });
      if (!keep) {
        token = String(
          await prompter.text({
            message: "Enter Telegram bot token",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
      }
    } else {
      token = String(
        await prompter.text({
          message: "Enter Telegram bot token",
          validate: (value) => (value?.trim() ? undefined : "Required"),
        }),
      ).trim();
    }

    if (token) {
      if (telegramAccountId === DEFAULT_ACCOUNT_ID) {
        next = {
          ...next,
          telegram: {
            ...next.telegram,
            enabled: true,
            botToken: token,
          },
        };
      } else {
        next = {
          ...next,
          telegram: {
            ...next.telegram,
            enabled: true,
            accounts: {
              ...next.telegram?.accounts,
              [telegramAccountId]: {
                ...next.telegram?.accounts?.[telegramAccountId],
                enabled:
                  next.telegram?.accounts?.[telegramAccountId]?.enabled ?? true,
                botToken: token,
              },
            },
          },
        };
      }
    }

    if (forceTelegramAllowFrom) {
      next = await promptTelegramAllowFrom({
        cfg: next,
        prompter,
        accountId: telegramAccountId,
      });
    }
  }

  if (selection.includes("discord")) {
    const discordOverride = accountOverrides.discord?.trim();
    const defaultDiscordAccountId = resolveDefaultDiscordAccountId(next);
    let discordAccountId = discordOverride
      ? normalizeAccountId(discordOverride)
      : defaultDiscordAccountId;
    if (shouldPromptAccountIds && !discordOverride) {
      discordAccountId = await promptAccountId({
        cfg: next,
        prompter,
        label: "Discord",
        currentId: discordAccountId,
        listAccountIds: listDiscordAccountIds,
        defaultAccountId: defaultDiscordAccountId,
      });
    }
    recordAccount("discord", discordAccountId);

    const resolvedAccount = resolveDiscordAccount({
      cfg: next,
      accountId: discordAccountId,
    });
    const accountConfigured = Boolean(resolvedAccount.token);
    const allowEnv = discordAccountId === DEFAULT_ACCOUNT_ID;
    const canUseEnv = allowEnv && discordEnv;
    const hasConfigToken = Boolean(resolvedAccount.config.token);

    let token: string | null = null;
    if (!accountConfigured) {
      await noteDiscordTokenHelp(prompter);
    }
    if (canUseEnv && !resolvedAccount.config.token) {
      const keepEnv = await prompter.confirm({
        message: "DISCORD_BOT_TOKEN detected. Use env var?",
        initialValue: true,
      });
      if (keepEnv) {
        next = {
          ...next,
          discord: {
            ...next.discord,
            enabled: true,
          },
        };
      } else {
        token = String(
          await prompter.text({
            message: "Enter Discord bot token",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
      }
    } else if (hasConfigToken) {
      const keep = await prompter.confirm({
        message: "Discord token already configured. Keep it?",
        initialValue: true,
      });
      if (!keep) {
        token = String(
          await prompter.text({
            message: "Enter Discord bot token",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
      }
    } else {
      token = String(
        await prompter.text({
          message: "Enter Discord bot token",
          validate: (value) => (value?.trim() ? undefined : "Required"),
        }),
      ).trim();
    }

    if (token) {
      if (discordAccountId === DEFAULT_ACCOUNT_ID) {
        next = {
          ...next,
          discord: {
            ...next.discord,
            enabled: true,
            token,
          },
        };
      } else {
        next = {
          ...next,
          discord: {
            ...next.discord,
            enabled: true,
            accounts: {
              ...next.discord?.accounts,
              [discordAccountId]: {
                ...next.discord?.accounts?.[discordAccountId],
                enabled:
                  next.discord?.accounts?.[discordAccountId]?.enabled ?? true,
                token,
              },
            },
          },
        };
      }
    }
  }

  if (selection.includes("slack")) {
    const slackOverride = accountOverrides.slack?.trim();
    const defaultSlackAccountId = resolveDefaultSlackAccountId(next);
    let slackAccountId = slackOverride
      ? normalizeAccountId(slackOverride)
      : defaultSlackAccountId;
    if (shouldPromptAccountIds && !slackOverride) {
      slackAccountId = await promptAccountId({
        cfg: next,
        prompter,
        label: "Slack",
        currentId: slackAccountId,
        listAccountIds: listSlackAccountIds,
        defaultAccountId: defaultSlackAccountId,
      });
    }
    recordAccount("slack", slackAccountId);

    const resolvedAccount = resolveSlackAccount({
      cfg: next,
      accountId: slackAccountId,
    });
    const accountConfigured = Boolean(
      resolvedAccount.botToken && resolvedAccount.appToken,
    );
    const allowEnv = slackAccountId === DEFAULT_ACCOUNT_ID;
    const canUseEnv = allowEnv && slackBotEnv && slackAppEnv;
    const hasConfigTokens = Boolean(
      resolvedAccount.config.botToken && resolvedAccount.config.appToken,
    );

    let botToken: string | null = null;
    let appToken: string | null = null;
    const slackBotName = String(
      await prompter.text({
        message: "Slack bot display name (used for manifest)",
        initialValue: "Clawdbot",
      }),
    ).trim();
    if (!accountConfigured) {
      await noteSlackTokenHelp(prompter, slackBotName);
    }
    if (
      canUseEnv &&
      (!resolvedAccount.config.botToken || !resolvedAccount.config.appToken)
    ) {
      const keepEnv = await prompter.confirm({
        message: "SLACK_BOT_TOKEN + SLACK_APP_TOKEN detected. Use env vars?",
        initialValue: true,
      });
      if (keepEnv) {
        next = {
          ...next,
          slack: {
            ...next.slack,
            enabled: true,
          },
        };
      } else {
        botToken = String(
          await prompter.text({
            message: "Enter Slack bot token (xoxb-...)",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
        appToken = String(
          await prompter.text({
            message: "Enter Slack app token (xapp-...)",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
      }
    } else if (hasConfigTokens) {
      const keep = await prompter.confirm({
        message: "Slack tokens already configured. Keep them?",
        initialValue: true,
      });
      if (!keep) {
        botToken = String(
          await prompter.text({
            message: "Enter Slack bot token (xoxb-...)",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
        appToken = String(
          await prompter.text({
            message: "Enter Slack app token (xapp-...)",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
      }
    } else {
      botToken = String(
        await prompter.text({
          message: "Enter Slack bot token (xoxb-...)",
          validate: (value) => (value?.trim() ? undefined : "Required"),
        }),
      ).trim();
      appToken = String(
        await prompter.text({
          message: "Enter Slack app token (xapp-...)",
          validate: (value) => (value?.trim() ? undefined : "Required"),
        }),
      ).trim();
    }

    if (botToken && appToken) {
      if (slackAccountId === DEFAULT_ACCOUNT_ID) {
        next = {
          ...next,
          slack: {
            ...next.slack,
            enabled: true,
            botToken,
            appToken,
          },
        };
      } else {
        next = {
          ...next,
          slack: {
            ...next.slack,
            enabled: true,
            accounts: {
              ...next.slack?.accounts,
              [slackAccountId]: {
                ...next.slack?.accounts?.[slackAccountId],
                enabled:
                  next.slack?.accounts?.[slackAccountId]?.enabled ?? true,
                botToken,
                appToken,
              },
            },
          },
        };
      }
    }
  }

  if (selection.includes("signal")) {
    const signalOverride = accountOverrides.signal?.trim();
    const defaultSignalAccountId = resolveDefaultSignalAccountId(next);
    let signalAccountId = signalOverride
      ? normalizeAccountId(signalOverride)
      : defaultSignalAccountId;
    if (shouldPromptAccountIds && !signalOverride) {
      signalAccountId = await promptAccountId({
        cfg: next,
        prompter,
        label: "Signal",
        currentId: signalAccountId,
        listAccountIds: listSignalAccountIds,
        defaultAccountId: defaultSignalAccountId,
      });
    }
    recordAccount("signal", signalAccountId);

    const resolvedAccount = resolveSignalAccount({
      cfg: next,
      accountId: signalAccountId,
    });
    const accountConfig = resolvedAccount.config;
    let resolvedCliPath = accountConfig.cliPath ?? signalCliPath;
    let cliDetected = await detectBinary(resolvedCliPath);
    if (options?.allowSignalInstall) {
      const wantsInstall = await prompter.confirm({
        message: cliDetected
          ? "signal-cli detected. Reinstall/update now?"
          : "signal-cli not found. Install now?",
        initialValue: !cliDetected,
      });
      if (wantsInstall) {
        try {
          const result = await installSignalCli(runtime);
          if (result.ok && result.cliPath) {
            cliDetected = true;
            resolvedCliPath = result.cliPath;
            await prompter.note(
              `Installed signal-cli at ${result.cliPath}`,
              "Signal",
            );
          } else if (!result.ok) {
            await prompter.note(
              result.error ?? "signal-cli install failed.",
              "Signal",
            );
          }
        } catch (err) {
          await prompter.note(
            `signal-cli install failed: ${String(err)}`,
            "Signal",
          );
        }
      }
    }

    if (!cliDetected) {
      await prompter.note(
        "signal-cli not found. Install it, then rerun this step or set signal.cliPath.",
        "Signal",
      );
    }

    let account = accountConfig.account ?? "";
    if (account) {
      const keep = await prompter.confirm({
        message: `Signal account set (${account}). Keep it?`,
        initialValue: true,
      });
      if (!keep) account = "";
    }

    if (!account) {
      account = String(
        await prompter.text({
          message: "Signal bot number (E.164)",
          validate: (value) => (value?.trim() ? undefined : "Required"),
        }),
      ).trim();
    }

    if (account) {
      if (signalAccountId === DEFAULT_ACCOUNT_ID) {
        next = {
          ...next,
          signal: {
            ...next.signal,
            enabled: true,
            account,
            cliPath: resolvedCliPath ?? "signal-cli",
          },
        };
      } else {
        next = {
          ...next,
          signal: {
            ...next.signal,
            enabled: true,
            accounts: {
              ...next.signal?.accounts,
              [signalAccountId]: {
                ...next.signal?.accounts?.[signalAccountId],
                enabled:
                  next.signal?.accounts?.[signalAccountId]?.enabled ?? true,
                account,
                cliPath: resolvedCliPath ?? "signal-cli",
              },
            },
          },
        };
      }
    }

    await prompter.note(
      [
        'Link device with: signal-cli link -n "Clawdbot"',
        "Scan QR in Signal → Linked Devices",
        "Then run: clawdbot gateway call providers.status --params '{\"probe\":true}'",
        `Docs: ${formatDocsLink("/signal", "signal")}`,
      ].join("\n"),
      "Signal next steps",
    );
  }

  if (selection.includes("imessage")) {
    const imessageOverride = accountOverrides.imessage?.trim();
    const defaultIMessageAccountId = resolveDefaultIMessageAccountId(next);
    let imessageAccountId = imessageOverride
      ? normalizeAccountId(imessageOverride)
      : defaultIMessageAccountId;
    if (shouldPromptAccountIds && !imessageOverride) {
      imessageAccountId = await promptAccountId({
        cfg: next,
        prompter,
        label: "iMessage",
        currentId: imessageAccountId,
        listAccountIds: listIMessageAccountIds,
        defaultAccountId: defaultIMessageAccountId,
      });
    }
    recordAccount("imessage", imessageAccountId);

    const resolvedAccount = resolveIMessageAccount({
      cfg: next,
      accountId: imessageAccountId,
    });
    let resolvedCliPath = resolvedAccount.config.cliPath ?? imessageCliPath;
    const cliDetected = await detectBinary(resolvedCliPath);
    if (!cliDetected) {
      const entered = await prompter.text({
        message: "imsg CLI path",
        initialValue: resolvedCliPath,
        validate: (value) => (value?.trim() ? undefined : "Required"),
      });
      resolvedCliPath = String(entered).trim();
      if (!resolvedCliPath) {
        await prompter.note(
          "imsg CLI path required to enable iMessage.",
          "iMessage",
        );
      }
    }

    if (resolvedCliPath) {
      if (imessageAccountId === DEFAULT_ACCOUNT_ID) {
        next = {
          ...next,
          imessage: {
            ...next.imessage,
            enabled: true,
            cliPath: resolvedCliPath,
          },
        };
      } else {
        next = {
          ...next,
          imessage: {
            ...next.imessage,
            enabled: true,
            accounts: {
              ...next.imessage?.accounts,
              [imessageAccountId]: {
                ...next.imessage?.accounts?.[imessageAccountId],
                enabled:
                  next.imessage?.accounts?.[imessageAccountId]?.enabled ?? true,
                cliPath: resolvedCliPath,
              },
            },
          },
        };
      }
    }

    await prompter.note(
      [
        "This is still a work in progress.",
        "Ensure Clawdbot has Full Disk Access to Messages DB.",
        "Grant Automation permission for Messages when prompted.",
        "List chats with: imsg chats --limit 20",
        `Docs: ${formatDocsLink("/imessage", "imessage")}`,
      ].join("\n"),
      "iMessage next steps",
    );
  }

  if (!options?.skipDmPolicyPrompt) {
    next = await maybeConfigureDmPolicies({ cfg: next, selection, prompter });
  }

  if (options?.allowDisable) {
    if (!selection.includes("telegram") && telegramConfigured) {
      const disable = await prompter.confirm({
        message: "Disable Telegram provider?",
        initialValue: false,
      });
      if (disable) {
        next = {
          ...next,
          telegram: { ...next.telegram, enabled: false },
        };
      }
    }

    if (!selection.includes("discord") && discordConfigured) {
      const disable = await prompter.confirm({
        message: "Disable Discord provider?",
        initialValue: false,
      });
      if (disable) {
        next = {
          ...next,
          discord: { ...next.discord, enabled: false },
        };
      }
    }

    if (!selection.includes("slack") && slackConfigured) {
      const disable = await prompter.confirm({
        message: "Disable Slack provider?",
        initialValue: false,
      });
      if (disable) {
        next = {
          ...next,
          slack: { ...next.slack, enabled: false },
        };
      }
    }

    if (!selection.includes("signal") && signalConfigured) {
      const disable = await prompter.confirm({
        message: "Disable Signal provider?",
        initialValue: false,
      });
      if (disable) {
        next = {
          ...next,
          signal: { ...next.signal, enabled: false },
        };
      }
    }

    if (!selection.includes("imessage") && imessageConfigured) {
      const disable = await prompter.confirm({
        message: "Disable iMessage provider?",
        initialValue: false,
      });
      if (disable) {
        next = {
          ...next,
          imessage: { ...next.imessage, enabled: false },
        };
      }
    }
  }

  return next;
}
