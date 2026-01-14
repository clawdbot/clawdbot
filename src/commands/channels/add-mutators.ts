import { getChannelPlugin } from "../../channels/plugins/index.js";
import type {
  ChannelId,
  ChannelSetupInput,
} from "../../channels/plugins/types.js";
import type { ClawdbotConfig } from "../../config/config.js";
import { normalizeAccountId } from "../../routing/session-key.js";

type ChatChannel = ChannelId;

export function applyAccountName(params: {
  cfg: ClawdbotConfig;
  channel: ChatChannel;
  accountId: string;
  name?: string;
}): ClawdbotConfig {
  const accountId = normalizeAccountId(params.accountId);
  const plugin = getChannelPlugin(params.channel);
  const apply = plugin?.setup?.applyAccountName;
  return apply
    ? apply({ cfg: params.cfg, accountId, name: params.name })
    : params.cfg;
}

export function applyChannelAccountConfig(params: {
  cfg: ClawdbotConfig;
  channel: ChatChannel;
  accountId: string;
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
}): ClawdbotConfig {
  const accountId = normalizeAccountId(params.accountId);
  const plugin = getChannelPlugin(params.channel);
  const apply = plugin?.setup?.applyAccountConfig;
  if (!apply) return params.cfg;
  const input: ChannelSetupInput = {
    name: params.name,
    token: params.token,
    tokenFile: params.tokenFile,
    botToken: params.botToken,
    appToken: params.appToken,
    signalNumber: params.signalNumber,
    cliPath: params.cliPath,
    dbPath: params.dbPath,
    service: params.service,
    region: params.region,
    authDir: params.authDir,
    httpUrl: params.httpUrl,
    httpHost: params.httpHost,
    httpPort: params.httpPort,
    useEnv: params.useEnv,
  };
  return apply({ cfg: params.cfg, accountId, input });
}
