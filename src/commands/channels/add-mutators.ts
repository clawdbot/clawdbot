import { getChannelPlugin } from "../../channels/plugins/index.js";
import type { ChannelId, ChannelSetupInput } from "../../channels/plugins/types.js";
import type { MoltbotConfig } from "../../config/config.js";
import { normalizeAccountId } from "../../routing/session-key.js";

type ChatChannel = ChannelId;

export function applyAccountName(params: {
  cfg: MoltbotConfig;
  channel: ChatChannel;
  accountId: string;
  name?: string;
}): MoltbotConfig {
  const accountId = normalizeAccountId(params.accountId);
  const plugin = getChannelPlugin(params.channel);
  const apply = plugin?.setup?.applyAccountName;
  return apply ? apply({ cfg: params.cfg, accountId, name: params.name }) : params.cfg;
}

export function applyChannelAccountConfig(params: {
  cfg: MoltbotConfig;
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
  webhookPath?: string;
  webhookUrl?: string;
  audienceType?: string;
  audience?: string;
  useEnv?: boolean;
  homeserver?: string;
  userId?: string;
  accessToken?: string;
  password?: string;
  deviceName?: string;
  initialSyncLimit?: number;
  ship?: string;
  url?: string;
  code?: string;
  groupChannels?: string[];
  dmAllowlist?: string[];
  autoDiscoverChannels?: boolean;
}): MoltbotConfig {
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
    webhookPath: params.webhookPath,
    webhookUrl: params.webhookUrl,
    audienceType: params.audienceType,
    audience: params.audience,
    useEnv: params.useEnv,
    homeserver: params.homeserver,
    userId: params.userId,
    accessToken: params.accessToken,
    password: params.password,
    deviceName: params.deviceName,
    initialSyncLimit: params.initialSyncLimit,
    ship: params.ship,
    url: params.url,
    code: params.code,
    groupChannels: params.groupChannels,
    dmAllowlist: params.dmAllowlist,
    autoDiscoverChannels: params.autoDiscoverChannels,
  };
  return apply({ cfg: params.cfg, accountId, input });
}
