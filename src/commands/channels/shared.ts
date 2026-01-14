import {
  type ChannelId,
  getChannelPlugin,
} from "../../channels/plugins/index.js";
import {
  type ClawdbotConfig,
  readConfigFileSnapshot,
} from "../../config/config.js";
import { DEFAULT_ACCOUNT_ID } from "../../routing/session-key.js";
import { defaultRuntime, type RuntimeEnv } from "../../runtime.js";

export type ChatChannel = ChannelId;

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

export const channelLabel = (channel: ChatChannel) => {
  const plugin = getChannelPlugin(channel);
  return plugin?.meta.label ?? channel;
};

export function formatChannelAccountLabel(params: {
  channel: ChatChannel;
  accountId: string;
  name?: string;
  channelStyle?: (value: string) => string;
  accountStyle?: (value: string) => string;
}): string {
  const channelText = channelLabel(params.channel);
  const accountText = formatAccountLabel({
    accountId: params.accountId,
    name: params.name,
  });
  const styledChannel = params.channelStyle
    ? params.channelStyle(channelText)
    : channelText;
  const styledAccount = params.accountStyle
    ? params.accountStyle(accountText)
    : accountText;
  return `${styledChannel} ${styledAccount}`;
}

export function shouldUseWizard(params?: { hasFlags?: boolean }) {
  return params?.hasFlags === false;
}
