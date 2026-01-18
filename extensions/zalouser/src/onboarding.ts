import type {
  ChannelOnboardingAdapter,
  ChannelOnboardingDmPolicy,
  ClawdbotConfig,
  WizardPrompter,
} from "clawdbot/plugin-sdk";
import {
  addWildcardAllowFrom,
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  promptAccountId,
  promptChannelAccessConfig,
} from "clawdbot/plugin-sdk";

import {
  listZalouserAccountIds,
  resolveDefaultZalouserAccountId,
  resolveZalouserAccountSync,
  checkZcaAuthenticated,
} from "./accounts.js";
import { runZca, runZcaInteractive, checkZcaInstalled, parseJsonOutput } from "./zca.js";
import type { ZcaGroup } from "./types.js";

const channel = "zalouser" as const;

function setZalouserDmPolicy(
  cfg: ClawdbotConfig,
  dmPolicy: "pairing" | "allowlist" | "open" | "disabled",
): ClawdbotConfig {
  const allowFrom =
    dmPolicy === "open"
      ? addWildcardAllowFrom(cfg.channels?.zalouser?.allowFrom)
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
  } as ClawdbotConfig;
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
  cfg: ClawdbotConfig;
  prompter: WizardPrompter;
  accountId: string;
}): Promise<ClawdbotConfig> {
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
    } as ClawdbotConfig;
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
  } as ClawdbotConfig;
}

function setZalouserGroupPolicy(
  cfg: ClawdbotConfig,
  accountId: string,
  groupPolicy: "open" | "allowlist" | "disabled",
): ClawdbotConfig {
  if (accountId === DEFAULT_ACCOUNT_ID) {
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        zalouser: {
          ...cfg.channels?.zalouser,
          enabled: true,
          groupPolicy,
        },
      },
    } as ClawdbotConfig;
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
            groupPolicy,
          },
        },
      },
    },
  } as ClawdbotConfig;
}

function setZalouserGroupAllowlist(
  cfg: ClawdbotConfig,
  accountId: string,
  groupKeys: string[],
): ClawdbotConfig {
  const groups = Object.fromEntries(groupKeys.map((key) => [key, { allow: true }]));
  if (accountId === DEFAULT_ACCOUNT_ID) {
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        zalouser: {
          ...cfg.channels?.zalouser,
          enabled: true,
          groups,
        },
      },
    } as ClawdbotConfig;
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
            groups,
          },
        },
      },
    },
  } as ClawdbotConfig;
}

async function resolveZalouserGroups(params: {
  cfg: ClawdbotConfig;
  accountId: string;
  entries: string[];
}): Promise<Array<{ input: string; resolved: boolean; id?: string }>> {
  const account = resolveZalouserAccountSync({ cfg: params.cfg, accountId: params.accountId });
  const result = await runZca(["group", "list", "-j"], { profile: account.profile, timeout: 15000 });
  if (!result.ok) throw new Error(result.stderr || "Failed to list groups");
  const groups = (parseJsonOutput<ZcaGroup[]>(result.stdout) ?? []).filter(
    (group) => Boolean(group.groupId),
  );
  const byName = new Map<string, ZcaGroup[]>();
  for (const group of groups) {
    const name = group.name?.trim().toLowerCase();
    if (!name) continue;
    const list = byName.get(name) ?? [];
    list.push(group);
    byName.set(name, list);
  }

  return params.entries.map((input) => {
    const trimmed = input.trim();
    if (!trimmed) return { input, resolved: false };
    if (/^\d+$/.test(trimmed)) return { input, resolved: true, id: trimmed };
    const matches = byName.get(trimmed.toLowerCase()) ?? [];
    const match = matches[0];
    return match?.groupId
      ? { input, resolved: true, id: String(match.groupId) }
      : { input, resolved: false };
  });
}

const dmPolicy: ChannelOnboardingDmPolicy = {
  label: "Zalo Personal",
  channel,
  policyKey: "channels.zalouser.dmPolicy",
  allowFromKey: "channels.zalouser.allowFrom",
  getCurrent: (cfg) => ((cfg as ClawdbotConfig).channels?.zalouser?.dmPolicy ?? "pairing") as "pairing",
  setPolicy: (cfg, policy) => setZalouserDmPolicy(cfg as ClawdbotConfig, policy),
};

export const zalouserOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,
  dmPolicy,
  getStatus: async ({ cfg }) => {
    const ids = listZalouserAccountIds(cfg as ClawdbotConfig);
    let configured = false;
    for (const accountId of ids) {
      const account = resolveZalouserAccountSync({ cfg: cfg as ClawdbotConfig, accountId });
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
    const defaultAccountId = resolveDefaultZalouserAccountId(cfg as ClawdbotConfig);
    let accountId = zalouserOverride
      ? normalizeAccountId(zalouserOverride)
      : defaultAccountId;

    if (shouldPromptAccountIds && !zalouserOverride) {
      accountId = await promptAccountId({
        cfg: cfg as ClawdbotConfig,
        prompter,
        label: "Zalo Personal",
        currentId: accountId,
        listAccountIds: listZalouserAccountIds,
        defaultAccountId,
      });
    }

    let next = cfg as ClawdbotConfig;
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
      } as ClawdbotConfig;
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
      } as ClawdbotConfig;
    }

    if (forceAllowFrom) {
      next = await promptZalouserAllowFrom({
        cfg: next,
        prompter,
        accountId,
      });
    }

    const accessConfig = await promptChannelAccessConfig({
      prompter,
      label: "Zalo groups",
      currentPolicy: account.config.groupPolicy ?? "open",
      currentEntries: Object.keys(account.config.groups ?? {}),
      placeholder: "Family, Work, 123456789",
      updatePrompt: Boolean(account.config.groups),
    });
    if (accessConfig) {
      if (accessConfig.policy !== "allowlist") {
        next = setZalouserGroupPolicy(next, accountId, accessConfig.policy);
      } else {
        let keys = accessConfig.entries;
        if (accessConfig.entries.length > 0) {
          try {
            const resolved = await resolveZalouserGroups({
              cfg: next,
              accountId,
              entries: accessConfig.entries,
            });
            const resolvedIds = resolved
              .filter((entry) => entry.resolved && entry.id)
              .map((entry) => entry.id as string);
            const unresolved = resolved
              .filter((entry) => !entry.resolved)
              .map((entry) => entry.input);
            keys = [
              ...resolvedIds,
              ...unresolved.map((entry) => entry.trim()).filter(Boolean),
            ];
            if (resolvedIds.length > 0 || unresolved.length > 0) {
              await prompter.note(
                [
                  resolvedIds.length > 0 ? `Resolved: ${resolvedIds.join(", ")}` : undefined,
                  unresolved.length > 0
                    ? `Unresolved (kept as typed): ${unresolved.join(", ")}`
                    : undefined,
                ]
                  .filter(Boolean)
                  .join("\n"),
                "Zalo groups",
              );
            }
          } catch (err) {
            await prompter.note(
              `Group lookup failed; keeping entries as typed. ${String(err)}`,
              "Zalo groups",
            );
          }
        }
        next = setZalouserGroupPolicy(next, accountId, "allowlist");
        next = setZalouserGroupAllowlist(next, accountId, keys);
      }
    }

    return { cfg: next, accountId };
  },
};
