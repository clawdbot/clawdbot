import {
  type ClawdbotConfig,
  readConfigFileSnapshot,
} from "../../config/config.js";
import {
  getProviderPlugin,
  type ProviderId,
} from "../../providers/plugins/index.js";
import { getChatProviderMeta } from "../../providers/registry.js";
import { DEFAULT_ACCOUNT_ID } from "../../routing/session-key.js";
import { defaultRuntime, type RuntimeEnv } from "../../runtime.js";

export type ChatProvider = ProviderId;

export async function requireValidConfig(
  runtime: RuntimeEnv = defaultRuntime,
): Promise<ClawdbotConfig | null> {
  const snapshot = await readConfigFileSnapshot();
  if (snapshot.exists && !snapshot.valid) {
    const issues =
      snapshot.issues.length > 0
        ? snapshot.issues
            .map((issue) => `- ${issue.path}: ${issue.message}`)
            .join("\n")
        : "Unknown validation issue.";
    runtime.error(`Config invalid:\n${issues}`);
    runtime.error("Fix the config or run clawdbot doctor.");
    runtime.exit(1);
    return null;
  }
  return snapshot.config;
}

export function formatAccountLabel(params: {
  accountId: string;
  name?: string;
}) {
  const base = params.accountId || DEFAULT_ACCOUNT_ID;
  if (params.name?.trim()) return `${base} (${params.name.trim()})`;
  return base;
}

export const providerLabel = (provider: ChatProvider) => {
  const plugin = getProviderPlugin(provider);
  if (plugin) return plugin.meta.label;
  return getChatProviderMeta(provider as never).label;
};

export function formatProviderAccountLabel(params: {
  provider: ChatProvider;
  accountId: string;
  name?: string;
  providerStyle?: (value: string) => string;
  accountStyle?: (value: string) => string;
}): string {
  const providerText = providerLabel(params.provider);
  const accountText = formatAccountLabel({
    accountId: params.accountId,
    name: params.name,
  });
  const styledProvider = params.providerStyle
    ? params.providerStyle(providerText)
    : providerText;
  const styledAccount = params.accountStyle
    ? params.accountStyle(accountText)
    : accountText;
  return `${styledProvider} ${styledAccount}`;
}

export function shouldUseWizard(params?: { hasFlags?: boolean }) {
  return params?.hasFlags === false;
}
