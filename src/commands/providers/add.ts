import { writeConfigFile } from "../../config/config.js";
import { normalizeProviderId } from "../../providers/plugins/index.js";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
} from "../../routing/session-key.js";
import { defaultRuntime, type RuntimeEnv } from "../../runtime.js";
import { createClackPrompter } from "../../wizard/clack-prompter.js";
import { setupProviders } from "../onboard-providers.js";
import type { ProviderChoice } from "../onboard-types.js";
import {
  applyAccountName,
  applyProviderAccountConfig,
} from "./add-mutators.js";
import {
  providerLabel,
  requireValidConfig,
  shouldUseWizard,
} from "./shared.js";

export type ProvidersAddOptions = {
  provider?: string;
  account?: string;
  name?: string;
  token?: string;
  tokenFile?: string;
  botToken?: string;
  appToken?: string;
  signalNumber?: string;
  cliPath?: string;
  dbPath?: string;
  service?: "imessage" | "sms" | "auto";
  region?: string;
  authDir?: string;
  httpUrl?: string;
  httpHost?: string;
  httpPort?: string;
  useEnv?: boolean;
};

export async function providersAddCommand(
  opts: ProvidersAddOptions,
  runtime: RuntimeEnv = defaultRuntime,
  params?: { hasFlags?: boolean },
) {
  const cfg = await requireValidConfig(runtime);
  if (!cfg) return;

  const useWizard = shouldUseWizard(params);
  if (useWizard) {
    const prompter = createClackPrompter();
    let selection: ProviderChoice[] = [];
    const accountIds: Partial<Record<ProviderChoice, string>> = {};
    await prompter.intro("Provider setup");
    let nextConfig = await setupProviders(cfg, runtime, prompter, {
      allowDisable: false,
      allowSignalInstall: true,
      promptAccountIds: true,
      onSelection: (value) => {
        selection = value;
      },
      onAccountId: (provider, accountId) => {
        accountIds[provider] = accountId;
      },
    });
    if (selection.length === 0) {
      await prompter.outro("No providers selected.");
      return;
    }

    const wantsNames = await prompter.confirm({
      message: "Add display names for these accounts? (optional)",
      initialValue: false,
    });
    if (wantsNames) {
      for (const provider of selection) {
        const accountId = accountIds[provider] ?? DEFAULT_ACCOUNT_ID;
        const existingName =
          provider === "whatsapp"
            ? nextConfig.whatsapp?.accounts?.[accountId]?.name
            : provider === "telegram"
              ? (nextConfig.telegram?.accounts?.[accountId]?.name ??
                nextConfig.telegram?.name)
              : provider === "discord"
                ? (nextConfig.discord?.accounts?.[accountId]?.name ??
                  nextConfig.discord?.name)
                : provider === "slack"
                  ? (nextConfig.slack?.accounts?.[accountId]?.name ??
                    nextConfig.slack?.name)
                  : provider === "signal"
                    ? (nextConfig.signal?.accounts?.[accountId]?.name ??
                      nextConfig.signal?.name)
                    : provider === "imessage"
                      ? (nextConfig.imessage?.accounts?.[accountId]?.name ??
                        nextConfig.imessage?.name)
                      : undefined;
        const name = await prompter.text({
          message: `${provider} account name (${accountId})`,
          initialValue: existingName,
        });
        if (name?.trim()) {
          nextConfig = applyAccountName({
            cfg: nextConfig,
            provider,
            accountId,
            name,
          });
        }
      }
    }

    await writeConfigFile(nextConfig);
    await prompter.outro("Providers updated.");
    return;
  }

  const provider = normalizeProviderId(opts.provider);
  if (!provider) {
    runtime.error(`Unknown provider: ${String(opts.provider ?? "")}`);
    runtime.exit(1);
    return;
  }

  const accountId =
    provider === "msteams"
      ? DEFAULT_ACCOUNT_ID
      : normalizeAccountId(opts.account);
  const useEnv = opts.useEnv === true;

  if (provider === "telegram") {
    if (useEnv && accountId !== DEFAULT_ACCOUNT_ID) {
      runtime.error(
        "TELEGRAM_BOT_TOKEN can only be used for the default account.",
      );
      runtime.exit(1);
      return;
    }
    if (!useEnv && !opts.token && !opts.tokenFile) {
      runtime.error(
        "Telegram requires --token or --token-file (or --use-env).",
      );
      runtime.exit(1);
      return;
    }
  }
  if (provider === "discord") {
    if (useEnv && accountId !== DEFAULT_ACCOUNT_ID) {
      runtime.error(
        "DISCORD_BOT_TOKEN can only be used for the default account.",
      );
      runtime.exit(1);
      return;
    }
    if (!useEnv && !opts.token) {
      runtime.error("Discord requires --token (or --use-env).");
      runtime.exit(1);
      return;
    }
  }
  if (provider === "slack") {
    if (useEnv && accountId !== DEFAULT_ACCOUNT_ID) {
      runtime.error(
        "Slack env tokens can only be used for the default account.",
      );
      runtime.exit(1);
      return;
    }
    if (!useEnv && (!opts.botToken || !opts.appToken)) {
      runtime.error(
        "Slack requires --bot-token and --app-token (or --use-env).",
      );
      runtime.exit(1);
      return;
    }
  }
  if (provider === "signal") {
    if (
      !opts.signalNumber &&
      !opts.httpUrl &&
      !opts.httpHost &&
      !opts.httpPort &&
      !opts.cliPath
    ) {
      runtime.error(
        "Signal requires --signal-number or --http-url/--http-host/--http-port/--cli-path.",
      );
      runtime.exit(1);
      return;
    }
  }

  const nextConfig = applyProviderAccountConfig({
    cfg,
    provider,
    accountId,
    name: opts.name,
    token: opts.token,
    tokenFile: opts.tokenFile,
    botToken: opts.botToken,
    appToken: opts.appToken,
    signalNumber: opts.signalNumber,
    cliPath: opts.cliPath,
    dbPath: opts.dbPath,
    service: opts.service,
    region: opts.region,
    authDir: opts.authDir,
    httpUrl: opts.httpUrl,
    httpHost: opts.httpHost,
    httpPort: opts.httpPort,
    useEnv,
  });

  await writeConfigFile(nextConfig);
  runtime.log(`Added ${providerLabel(provider)} account "${accountId}".`);
}
