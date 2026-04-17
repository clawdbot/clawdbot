import path from "node:path";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAllowFromEntries,
  normalizeE164,
  pathExists,
  splitSetupEntries,
  type DmPolicy,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/setup";
import type { ChannelSetupWizard } from "openclaw/plugin-sdk/setup";
import { formatCliCommand, formatDocsLink } from "openclaw/plugin-sdk/setup-tools";
import {
  resolveDefaultWhatsAppAccountId,
  resolveWhatsAppAccount,
  resolveWhatsAppAuthDir,
} from "./accounts.js";
import { loginWeb } from "./login.js";
import { whatsappSetupAdapter } from "./setup-core.js";

type SetupPrompter = Parameters<NonNullable<ChannelSetupWizard["finalize"]>>[0]["prompter"];
type SetupRuntime = Parameters<NonNullable<ChannelSetupWizard["finalize"]>>[0]["runtime"];
type WhatsAppConfig = NonNullable<NonNullable<OpenClawConfig["channels"]>["whatsapp"]>;
type WhatsAppAccountConfig = NonNullable<NonNullable<WhatsAppConfig["accounts"]>[string]>;

function trimPromptText(value: string | null | undefined): string {
  return value?.trim() ?? "";
}

function mergeWhatsAppConfig(
  cfg: OpenClawConfig,
  accountId: string,
  patch: Partial<WhatsAppAccountConfig>,
  options?: { unsetOnUndefined?: string[] },
): OpenClawConfig {
  const channelConfig: WhatsAppConfig = { ...cfg.channels?.whatsapp };
  const mutableChannelConfig = channelConfig as Record<string, unknown>;
  if (accountId === DEFAULT_ACCOUNT_ID) {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) {
        if (options?.unsetOnUndefined?.includes(key)) {
          delete mutableChannelConfig[key];
        }
        continue;
      }
      mutableChannelConfig[key] = value;
    }
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        whatsapp: channelConfig,
      },
    };
  }
  const accounts = {
    ...(channelConfig.accounts as Record<string, WhatsAppAccountConfig> | undefined),
  };
  const nextAccount: WhatsAppAccountConfig = { ...accounts[accountId] };
  const mutableNextAccount = nextAccount as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      if (options?.unsetOnUndefined?.includes(key)) {
        delete mutableNextAccount[key];
      }
      continue;
    }
    mutableNextAccount[key] = value;
  }
  accounts[accountId] = nextAccount;
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      whatsapp: {
        ...channelConfig,
        accounts,
      },
    },
  };
}

function setWhatsAppDmPolicy(
  cfg: OpenClawConfig,
  accountId: string,
  dmPolicy: DmPolicy,
): OpenClawConfig {
  return mergeWhatsAppConfig(cfg, accountId, { dmPolicy });
}

function setWhatsAppAllowFrom(
  cfg: OpenClawConfig,
  accountId: string,
  allowFrom?: string[],
): OpenClawConfig {
  return mergeWhatsAppConfig(cfg, accountId, { allowFrom }, { unsetOnUndefined: ["allowFrom"] });
}

function setWhatsAppSelfChatMode(
  cfg: OpenClawConfig,
  accountId: string,
  selfChatMode: boolean,
): OpenClawConfig {
  return mergeWhatsAppConfig(cfg, accountId, { selfChatMode });
}

export async function detectWhatsAppLinked(
  cfg: OpenClawConfig,
  accountId: string,
): Promise<boolean> {
  const { authDir } = resolveWhatsAppAuthDir({ cfg, accountId });
  const credsPath = path.join(authDir, "creds.json");
  return await pathExists(credsPath);
}

async function promptWhatsAppOwnerAllowFrom(params: {
  existingAllowFrom: string[];
  prompter: SetupPrompter;
}): Promise<{ normalized: string; allowFrom: string[] }> {
  const { prompter, existingAllowFrom } = params;

  await prompter.note(
    "We need the sender/owner number so OpenClaw can allowlist you.",
    "WhatsApp number",
  );
  const entry = await prompter.text({
    message: "Your personal WhatsApp number (the phone you will message from)",
    placeholder: "+15555550123",
    initialValue: existingAllowFrom[0],
    validate: (value) => {
      const raw = trimPromptText(value);
      if (!raw) {
        return "Required";
      }
      const normalized = normalizeE164(raw);
      if (!normalized) {
        return `Invalid number: ${raw}`;
      }
      return undefined;
    },
  });

  const normalized = normalizeE164(trimPromptText(entry));
  if (!normalized) {
    throw new Error("Invalid WhatsApp owner number (expected E.164 after validation).");
  }
  const allowFrom = normalizeAllowFromEntries(
    [...existingAllowFrom.filter((item) => item !== "*"), normalized],
    normalizeE164,
  );
  return { normalized, allowFrom };
}

async function applyWhatsAppOwnerAllowlist(params: {
  cfg: OpenClawConfig;
  accountId: string;
  existingAllowFrom: string[];
  messageLines: string[];
  prompter: SetupPrompter;
  title: string;
}): Promise<OpenClawConfig> {
  const { normalized, allowFrom } = await promptWhatsAppOwnerAllowFrom({
    prompter: params.prompter,
    existingAllowFrom: params.existingAllowFrom,
  });
  let next = setWhatsAppSelfChatMode(params.cfg, params.accountId, true);
  next = setWhatsAppDmPolicy(next, params.accountId, "allowlist");
  next = setWhatsAppAllowFrom(next, params.accountId, allowFrom);
  await params.prompter.note(
    [...params.messageLines, `- allowFrom includes ${normalized}`].join("\n"),
    params.title,
  );
  return next;
}

function parseWhatsAppAllowFromEntries(raw: string): { entries: string[]; invalidEntry?: string } {
  const parts = splitSetupEntries(raw);
  if (parts.length === 0) {
    return { entries: [] };
  }
  const entries: string[] = [];
  for (const part of parts) {
    if (part === "*") {
      entries.push("*");
      continue;
    }
    const normalized = normalizeE164(part);
    if (!normalized) {
      return { entries: [], invalidEntry: part };
    }
    entries.push(normalized);
  }
  return { entries: normalizeAllowFromEntries(entries, normalizeE164) };
}

async function promptWhatsAppDmAccess(params: {
  cfg: OpenClawConfig;
  accountId: string;
  forceAllowFrom: boolean;
  prompter: SetupPrompter;
}): Promise<OpenClawConfig> {
  const accountId = params.accountId.trim() || DEFAULT_ACCOUNT_ID;
  const account = resolveWhatsAppAccount({ cfg: params.cfg, accountId });
  const existingPolicy = account.dmPolicy ?? "pairing";
  const existingAllowFrom = account.allowFrom ?? [];
  const existingLabel = existingAllowFrom.length > 0 ? existingAllowFrom.join(", ") : "unset";
  const policyKey =
    accountId === DEFAULT_ACCOUNT_ID
      ? "channels.whatsapp.dmPolicy"
      : `channels.whatsapp.accounts.${accountId}.dmPolicy`;
  const allowFromKey =
    accountId === DEFAULT_ACCOUNT_ID
      ? "channels.whatsapp.allowFrom"
      : `channels.whatsapp.accounts.${accountId}.allowFrom`;

  if (params.forceAllowFrom) {
    return await applyWhatsAppOwnerAllowlist({
      cfg: params.cfg,
      accountId,
      prompter: params.prompter,
      existingAllowFrom,
      title: "WhatsApp allowlist",
      messageLines: ["Allowlist mode enabled."],
    });
  }

  await params.prompter.note(
    [
      `WhatsApp direct chats are gated by \`${policyKey}\` + \`${allowFromKey}\`.`,
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

  const phoneMode = await params.prompter.select({
    message: "WhatsApp phone setup",
    options: [
      { value: "personal", label: "This is my personal phone number" },
      { value: "separate", label: "Separate phone just for OpenClaw" },
    ],
  });

  if (phoneMode === "personal") {
    return await applyWhatsAppOwnerAllowlist({
      cfg: params.cfg,
      accountId,
      prompter: params.prompter,
      existingAllowFrom,
      title: "WhatsApp personal phone",
      messageLines: [
        "Personal phone mode enabled.",
        "- dmPolicy set to allowlist (pairing skipped)",
      ],
    });
  }

  const policy = (await params.prompter.select({
    message: "WhatsApp DM policy",
    options: [
      { value: "pairing", label: "Pairing (recommended)" },
      { value: "allowlist", label: "Allowlist only (block unknown senders)" },
      { value: "open", label: "Open (public inbound DMs)" },
      { value: "disabled", label: "Disabled (ignore WhatsApp DMs)" },
    ],
  })) as DmPolicy;

  let next = setWhatsAppSelfChatMode(params.cfg, accountId, false);
  next = setWhatsAppDmPolicy(next, accountId, policy);
  if (policy === "open") {
    const allowFrom = normalizeAllowFromEntries(["*", ...existingAllowFrom], normalizeE164);
    next = setWhatsAppAllowFrom(next, accountId, allowFrom.length > 0 ? allowFrom : ["*"]);
    return next;
  }
  if (policy === "disabled") {
    return next;
  }

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

  const mode = await params.prompter.select({
    message: "WhatsApp allowFrom (optional pre-allowlist)",
    options: allowOptions.map((opt) => ({
      value: opt.value,
      label: opt.label,
    })),
  });

  if (mode === "keep") {
    return next;
  }
  if (mode === "unset") {
    return setWhatsAppAllowFrom(next, accountId, undefined);
  }

  const allowRaw = await params.prompter.text({
    message: "Allowed sender numbers (comma-separated, E.164)",
    placeholder: "+15555550123, +447700900123",
    validate: (value) => {
      const raw = trimPromptText(value);
      if (!raw) {
        return "Required";
      }
      const parsed = parseWhatsAppAllowFromEntries(raw);
      if (parsed.entries.length === 0 && !parsed.invalidEntry) {
        return "Required";
      }
      if (parsed.invalidEntry) {
        return `Invalid number: ${parsed.invalidEntry}`;
      }
      return undefined;
    },
  });

  const parsed = parseWhatsAppAllowFromEntries(trimPromptText(allowRaw));
  if (parsed.invalidEntry) {
    throw new Error(`Invalid number: ${parsed.invalidEntry}`);
  }
  if (parsed.entries.length === 0) {
    throw new Error("Invalid WhatsApp allowFrom list (expected at least one E.164 number).");
  }
  return setWhatsAppAllowFrom(next, accountId, parsed.entries);
}

export async function finalizeWhatsAppSetup(params: {
  cfg: OpenClawConfig;
  accountId: string;
  forceAllowFrom: boolean;
  prompter: SetupPrompter;
  runtime: SetupRuntime;
}) {
  const accountId = params.accountId.trim() || resolveDefaultWhatsAppAccountId(params.cfg);
  let next =
    accountId === DEFAULT_ACCOUNT_ID
      ? params.cfg
      : whatsappSetupAdapter.applyAccountConfig({
          cfg: params.cfg,
          accountId,
          input: {},
        });

  const linked = await detectWhatsAppLinked(next, accountId);
  const { authDir } = resolveWhatsAppAuthDir({
    cfg: next,
    accountId,
  });

  if (!linked) {
    await params.prompter.note(
      [
        "Scan the QR with WhatsApp on your phone.",
        `Credentials are stored under ${authDir}/ for future runs.`,
        `Docs: ${formatDocsLink("/whatsapp", "whatsapp")}`,
      ].join("\n"),
      "WhatsApp linking",
    );
  }

  const wantsLink = await params.prompter.confirm({
    message: linked ? "WhatsApp already linked. Re-link now?" : "Link WhatsApp now (QR)?",
    initialValue: !linked,
  });
  if (wantsLink) {
    try {
      await loginWeb(false, undefined, params.runtime, accountId);
    } catch (error) {
      params.runtime.error(`WhatsApp login failed: ${String(error)}`);
      await params.prompter.note(
        `Docs: ${formatDocsLink("/whatsapp", "whatsapp")}`,
        "WhatsApp help",
      );
    }
  } else if (!linked) {
    await params.prompter.note(
      `Run \`${formatCliCommand("openclaw channels login")}\` later to link WhatsApp.`,
      "WhatsApp",
    );
  }

  next = await promptWhatsAppDmAccess({
    cfg: next,
    accountId,
    forceAllowFrom: params.forceAllowFrom,
    prompter: params.prompter,
  });
  return { cfg: next };
}
