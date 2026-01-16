import type { ChannelOnboardingAdapter, ChannelOnboardingDmPolicy } from "../../../src/channels/plugins/onboarding-types.js";
import type { WizardPrompter } from "../../../src/wizard/prompts.js";

import {
  listZalouserAccountIds,
  resolveDefaultZalouserAccountId,
  resolveZalouserAccountSync,
  normalizeAccountId,
  checkZcaAuthenticated,
} from "./accounts.js";
import { runZcaInteractive, checkZcaInstalled } from "./zca.js";
import { DEFAULT_ACCOUNT_ID, type CoreConfig } from "./types.js";

const channel = "zalouser" as const;

function setZalouserDmPolicy(
  cfg: CoreConfig,
  dmPolicy: "pairing" | "allowlist" | "open" | "disabled",
): CoreConfig {
  const allowFrom =
    dmPolicy === "open"
      ? [...(cfg.channels?.zalouser?.allowFrom ?? []), "*"].filter(
          (v, i, a) => a.indexOf(v) === i,
        )
      : undefined;
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      zalouser: {
        ...cfg.channels?.zalouser,
        dmPolicy,
        ...(allowFrom ? { allowFrom } : {}),
      },
    },
  } as CoreConfig;
}

async function noteZalouserHelp(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      "Zalo Personal Account login via QR code.",
      "",
      "Prerequisites:",
      "1) Install zca-cli",
      "2) You'll scan a QR code with your Zalo app",
      "",
      "Docs: https://docs.clawd.bot/channels/zalouser",
    ].join("\n"),
    "Zalo Personal Setup",
  );
}

async function promptZalouserAllowFrom(params: {
  cfg: CoreConfig;
  prompter: WizardPrompter;
  accountId: string;
}): Promise<CoreConfig> {
  const { cfg, prompter, accountId } = params;
  const resolved = resolveZalouserAccountSync({ cfg, accountId });
  const existingAllowFrom = resolved.config.allowFrom ?? [];
  const entry = await prompter.text({
    message: "Zalouser allowFrom (user id)",
    placeholder: "123456789",
    initialValue: existingAllowFrom[0] ? String(existingAllowFrom[0]) : undefined,
    validate: (value) => {
      const raw = String(value ?? "").trim();
      if (!raw) return "Required";
      if (!/^\d+$/.test(raw)) return "Use a numeric Zalo user id";
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
      channels: {
        ...cfg.channels,
        zalouser: {
          ...cfg.channels?.zalouser,
          enabled: true,
          dmPolicy: "allowlist",
          allowFrom: unique,
        },
      },
    } as CoreConfig;
  }

  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      zalouser: {
        ...cfg.channels?.zalouser,
        enabled: true,
        accounts: {
          ...(cfg.channels?.zalouser?.accounts ?? {}),
          [accountId]: {
            ...(cfg.channels?.zalouser?.accounts?.[accountId] ?? {}),
            enabled: cfg.channels?.zalouser?.accounts?.[accountId]?.enabled ?? true,
            dmPolicy: "allowlist",
            allowFrom: unique,
          },
        },
      },
    },
  } as CoreConfig;
}

async function promptAccountId(params: {
  cfg: CoreConfig;
  prompter: WizardPrompter;
  label: string;
  currentId: string;
  listAccountIds: (cfg: CoreConfig) => string[];
  defaultAccountId: string;
}): Promise<string> {
  const { cfg, prompter, label, currentId, listAccountIds, defaultAccountId } = params;
  const existingIds = listAccountIds(cfg);
  const options = [
    ...existingIds.map((id) => ({
      value: id,
      label: id === defaultAccountId ? `${id} (default)` : id,
    })),
    { value: "__new__", label: "Create new account" },
  ];

  const selected = await prompter.select({
    message: `${label} account`,
    options,
    initialValue: currentId,
  });

  if (selected === "__new__") {
    const newId = await prompter.text({
      message: "New account ID",
      placeholder: "work",
      validate: (value) => {
        const raw = String(value ?? "").trim().toLowerCase();
        if (!raw) return "Required";
        if (!/^[a-z0-9_-]+$/.test(raw)) return "Use lowercase alphanumeric, dash, or underscore";
        if (existingIds.includes(raw)) return "Account already exists";
        return undefined;
      },
    });
    return String(newId).trim().toLowerCase();
  }

  return selected as string;
}

const dmPolicy: ChannelOnboardingDmPolicy = {
  label: "Zalo Personal",
  channel,
  policyKey: "channels.zalouser.dmPolicy",
  allowFromKey: "channels.zalouser.allowFrom",
  getCurrent: (cfg) => ((cfg as CoreConfig).channels?.zalouser?.dmPolicy ?? "pairing") as "pairing",
  setPolicy: (cfg, policy) => setZalouserDmPolicy(cfg as CoreConfig, policy),
};

export const zalouserOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,
  dmPolicy,
  getStatus: async ({ cfg }) => {
    const ids = listZalouserAccountIds(cfg as CoreConfig);
    let configured = false;
    for (const accountId of ids) {
      const account = resolveZalouserAccountSync({ cfg: cfg as CoreConfig, accountId });
      const isAuth = await checkZcaAuthenticated(account.profile);
      if (isAuth) {
        configured = true;
        break;
      }
    }
    return {
      channel,
      configured,
      statusLines: [`Zalo Personal: ${configured ? "logged in" : "needs QR login"}`],
      selectionHint: configured ? "recommended · logged in" : "recommended · QR login",
      quickstartScore: configured ? 1 : 15,
    };
  },
  configure: async ({ cfg, prompter, accountOverrides, shouldPromptAccountIds, forceAllowFrom }) => {
    // Check zca is installed
    const zcaInstalled = await checkZcaInstalled();
    if (!zcaInstalled) {
      await prompter.note(
        [
          "The `zca` binary was not found in PATH.",
          "",
          "Install zca-cli, then re-run onboarding:",
          "Docs: https://docs.clawd.bot/channels/zalouser",
        ].join("\n"),
        "Missing Dependency",
      );
      return { cfg, accountId: DEFAULT_ACCOUNT_ID };
    }

    const zalouserOverride = accountOverrides.zalouser?.trim();
    const defaultAccountId = resolveDefaultZalouserAccountId(cfg as CoreConfig);
    let accountId = zalouserOverride
      ? normalizeAccountId(zalouserOverride)
      : defaultAccountId;

    if (shouldPromptAccountIds && !zalouserOverride) {
      accountId = await promptAccountId({
        cfg: cfg as CoreConfig,
        prompter,
        label: "Zalo Personal",
        currentId: accountId,
        listAccountIds: listZalouserAccountIds,
        defaultAccountId,
      });
    }

    let next = cfg as CoreConfig;
    const account = resolveZalouserAccountSync({ cfg: next, accountId });
    const alreadyAuthenticated = await checkZcaAuthenticated(account.profile);

    if (!alreadyAuthenticated) {
      await noteZalouserHelp(prompter);

      const wantsLogin = await prompter.confirm({
        message: "Login via QR code now?",
        initialValue: true,
      });

      if (wantsLogin) {
        await prompter.note(
          "A QR code will appear in your terminal.\nScan it with your Zalo app to login.",
          "QR Login",
        );

        // Run interactive login
        const result = await runZcaInteractive(["auth", "login"], {
          profile: account.profile,
        });

        if (!result.ok) {
          await prompter.note(
            `Login failed: ${result.stderr || "Unknown error"}`,
            "Error",
          );
        } else {
          const isNowAuth = await checkZcaAuthenticated(account.profile);
          if (isNowAuth) {
            await prompter.note("Login successful!", "Success");
          }
        }
      }
    } else {
      const keepSession = await prompter.confirm({
        message: "Zalo Personal already logged in. Keep session?",
        initialValue: true,
      });
      if (!keepSession) {
        await runZcaInteractive(["auth", "logout"], { profile: account.profile });
        await runZcaInteractive(["auth", "login"], { profile: account.profile });
      }
    }

    // Enable the channel
    if (accountId === DEFAULT_ACCOUNT_ID) {
      next = {
        ...next,
        channels: {
          ...next.channels,
          zalouser: {
            ...next.channels?.zalouser,
            enabled: true,
            profile: account.profile !== "default" ? account.profile : undefined,
          },
        },
      } as CoreConfig;
    } else {
      next = {
        ...next,
        channels: {
          ...next.channels,
          zalouser: {
            ...next.channels?.zalouser,
            enabled: true,
            accounts: {
              ...(next.channels?.zalouser?.accounts ?? {}),
              [accountId]: {
                ...(next.channels?.zalouser?.accounts?.[accountId] ?? {}),
                enabled: true,
                profile: account.profile,
              },
            },
          },
        },
      } as CoreConfig;
    }

    if (forceAllowFrom) {
      next = await promptZalouserAllowFrom({
        cfg: next,
        prompter,
        accountId,
      });
    }

    return { cfg: next, accountId };
  },
};
