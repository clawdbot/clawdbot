import fs from "node:fs/promises";
import path from "node:path";
import { loginWeb } from "../../../channel-web.js";
import type { MoltbotConfig } from "../../../config/config.js";
import { mergeWhatsAppConfig } from "../../../config/merge-config.js";
import type { DmPolicy } from "../../../config/types.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../../routing/session-key.js";
import type { RuntimeEnv } from "../../../runtime.js";
import { formatDocsLink } from "../../../terminal/links.js";
import { formatCliCommand } from "../../../cli/command-format.js";
import { normalizeE164 } from "../../../utils.js";
import {
  listWhatsAppAccountIds,
  resolveDefaultWhatsAppAccountId,
  resolveWhatsAppAuthDir,
} from "../../../web/accounts.js";
import type { WizardPrompter } from "../../../wizard/prompts.js";
import type { ChannelOnboardingAdapter } from "../onboarding-types.js";
import { promptAccountId } from "./helpers.js";

const channel = "whatsapp" as const;

function setWhatsAppDmPolicy(cfg: MoltbotConfig, dmPolicy: DmPolicy): MoltbotConfig {
  return mergeWhatsAppConfig(cfg, { dmPolicy });
}

function setWhatsAppAllowFrom(cfg: MoltbotConfig, allowFrom?: string[]): MoltbotConfig {
  return mergeWhatsAppConfig(cfg, { allowFrom }, { unsetOnUndefined: ["allowFrom"] });
}

function setWhatsAppSelfChatMode(cfg: MoltbotConfig, selfChatMode: boolean): MoltbotConfig {
  return mergeWhatsAppConfig(cfg, { selfChatMode });
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function detectWhatsAppLinked(cfg: MoltbotConfig, accountId: string): Promise<boolean> {
  const { authDir } = resolveWhatsAppAuthDir({ cfg, accountId });
  const credsPath = path.join(authDir, "creds.json");
  return await pathExists(credsPath);
}

async function promptWhatsAppAllowFrom(
  cfg: MoltbotConfig,
  _runtime: RuntimeEnv,
  prompter: WizardPrompter,
  options?: { forceAllowlist?: boolean },
): Promise<MoltbotConfig> {
  const existingPolicy = cfg.channels?.whatsapp?.dmPolicy ?? "pairing";
  const existingAllowFrom = cfg.channels?.whatsapp?.allowFrom ?? [];
  const existingLabel = existingAllowFrom.length > 0 ? existingAllowFrom.join(", ") : "unset";

  if (options?.forceAllowlist) {
    await prompter.note(
      "We need the sender/owner number so Moltbot can allowlist you.",
      "WhatsApp number",
    );
    const entry = await prompter.text({
      message: "Your personal WhatsApp number (the phone you will message from)",
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
    await prompter.note(
      ["Allowlist mode enabled.", `- allowFrom includes ${normalized}`].join("\n"),
      "WhatsApp allowlist",
    );
    return next;
  }

  await prompter.note(
    [
      "WhatsApp direct chats are gated by `channels.whatsapp.dmPolicy` + `channels.whatsapp.allowFrom`.",
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
      { value: "separate", label: "Separate phone just for Moltbot" },
    ],
  })) as "personal" | "separate";

  if (phoneMode === "personal") {
    await prompter.note(
      "We need the sender/owner number so Moltbot can allowlist you.",
      "WhatsApp number",
    );
    const entry = await prompter.text({
      message: "Your personal WhatsApp number (the phone you will message from)",
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
    await prompter.note(
      [
        "Personal phone mode enabled.",
        "- dmPolicy set to allowlist (pairing skipped)",
        `- allowFrom includes ${normalized}`,
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
    const normalized = parts.map((part) => (part === "*" ? "*" : normalizeE164(part)));
    const unique = [...new Set(normalized.filter(Boolean))];
    next = setWhatsAppAllowFrom(next, unique);
  }

  return next;
}

export const whatsappOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,
  getStatus: async ({ cfg, accountOverrides }) => {
    const overrideId = accountOverrides.whatsapp?.trim();
    const defaultAccountId = resolveDefaultWhatsAppAccountId(cfg);
    const accountId = overrideId ? normalizeAccountId(overrideId) : defaultAccountId;
    const linked = await detectWhatsAppLinked(cfg, accountId);
    const accountLabel = accountId === DEFAULT_ACCOUNT_ID ? "default" : accountId;
    return {
      channel,
      configured: linked,
      statusLines: [`WhatsApp (${accountLabel}): ${linked ? "linked" : "not linked"}`],
      selectionHint: linked ? "linked" : "not linked",
      quickstartScore: linked ? 5 : 4,
    };
  },
  configure: async ({
    cfg,
    runtime,
    prompter,
    options,
    accountOverrides,
    shouldPromptAccountIds,
    forceAllowFrom,
  }) => {
    const overrideId = accountOverrides.whatsapp?.trim();
    let accountId = overrideId
      ? normalizeAccountId(overrideId)
      : resolveDefaultWhatsAppAccountId(cfg);
    if (shouldPromptAccountIds || options?.promptWhatsAppAccountId) {
      if (!overrideId) {
        accountId = await promptAccountId({
          cfg,
          prompter,
          label: "WhatsApp",
          currentId: accountId,
          listAccountIds: listWhatsAppAccountIds,
          defaultAccountId: resolveDefaultWhatsAppAccountId(cfg),
        });
      }
    }

    let next = cfg;
    if (accountId !== DEFAULT_ACCOUNT_ID) {
      next = {
        ...next,
        channels: {
          ...next.channels,
          whatsapp: {
            ...next.channels?.whatsapp,
            accounts: {
              ...next.channels?.whatsapp?.accounts,
              [accountId]: {
                ...next.channels?.whatsapp?.accounts?.[accountId],
                enabled: next.channels?.whatsapp?.accounts?.[accountId]?.enabled ?? true,
              },
            },
          },
        },
      };
    }

    const linked = await detectWhatsAppLinked(next, accountId);
    const { authDir } = resolveWhatsAppAuthDir({
      cfg: next,
      accountId,
    });

    if (!linked) {
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
      message: linked ? "WhatsApp already linked. Re-link now?" : "Link WhatsApp now (QR)?",
      initialValue: !linked,
    });
    if (wantsLink) {
      try {
        await loginWeb(false, undefined, runtime, accountId);
      } catch (err) {
        runtime.error(`WhatsApp login failed: ${String(err)}`);
        await prompter.note(`Docs: ${formatDocsLink("/whatsapp", "whatsapp")}`, "WhatsApp help");
      }
    } else if (!linked) {
      await prompter.note(
        `Run \`${formatCliCommand("moltbot channels login")}\` later to link WhatsApp.`,
        "WhatsApp",
      );
    }

    next = await promptWhatsAppAllowFrom(next, runtime, prompter, {
      forceAllowlist: forceAllowFrom,
    });

    return { cfg: next, accountId };
  },
  onAccountRecorded: (accountId, options) => {
    options?.onWhatsAppAccountId?.(accountId);
  },
};
