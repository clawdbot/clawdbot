import { detectBinary } from "../../../commands/onboard-helpers.js";
import { installSignalCli } from "../../../commands/signal-install.js";
import type { ClawdbotConfig } from "../../../config/config.js";
import type { DmPolicy } from "../../../config/types.js";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
} from "../../../routing/session-key.js";
import {
  listSignalAccountIds,
  resolveDefaultSignalAccountId,
  resolveSignalAccount,
} from "../../../signal/accounts.js";
import { formatDocsLink } from "../../../terminal/links.js";
import type {
  ProviderOnboardingAdapter,
  ProviderOnboardingDmPolicy,
} from "../onboarding-types.js";
import { addWildcardAllowFrom, promptAccountId } from "./helpers.js";

const provider = "signal" as const;

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

const dmPolicy: ProviderOnboardingDmPolicy = {
  label: "Signal",
  provider,
  policyKey: "signal.dmPolicy",
  allowFromKey: "signal.allowFrom",
  getCurrent: (cfg) => cfg.signal?.dmPolicy ?? "pairing",
  setPolicy: (cfg, policy) => setSignalDmPolicy(cfg, policy),
};

export const signalOnboardingAdapter: ProviderOnboardingAdapter = {
  provider,
  getStatus: async ({ cfg }) => {
    const configured = listSignalAccountIds(cfg).some(
      (accountId) => resolveSignalAccount({ cfg, accountId }).configured,
    );
    const signalCliPath = cfg.signal?.cliPath ?? "signal-cli";
    const signalCliDetected = await detectBinary(signalCliPath);
    return {
      provider,
      configured,
      statusLines: [
        `Signal: ${configured ? "configured" : "needs setup"}`,
        `signal-cli: ${signalCliDetected ? "found" : "missing"} (${signalCliPath})`,
      ],
      selectionHint: signalCliDetected
        ? "signal-cli found"
        : "signal-cli missing",
      quickstartScore: signalCliDetected ? 1 : 0,
    };
  },
  configure: async ({
    cfg,
    runtime,
    prompter,
    accountOverrides,
    shouldPromptAccountIds,
    options,
  }) => {
    const signalOverride = accountOverrides.signal?.trim();
    const defaultSignalAccountId = resolveDefaultSignalAccountId(cfg);
    let signalAccountId = signalOverride
      ? normalizeAccountId(signalOverride)
      : defaultSignalAccountId;
    if (shouldPromptAccountIds && !signalOverride) {
      signalAccountId = await promptAccountId({
        cfg,
        prompter,
        label: "Signal",
        currentId: signalAccountId,
        listAccountIds: listSignalAccountIds,
        defaultAccountId: defaultSignalAccountId,
      });
    }

    let next = cfg;
    const resolvedAccount = resolveSignalAccount({
      cfg: next,
      accountId: signalAccountId,
    });
    const accountConfig = resolvedAccount.config;
    let resolvedCliPath = accountConfig.cliPath ?? "signal-cli";
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

    return { cfg: next, accountId: signalAccountId };
  },
  dmPolicy,
  disable: (cfg) => ({
    ...cfg,
    signal: { ...cfg.signal, enabled: false },
  }),
};
