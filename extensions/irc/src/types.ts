import type {
  BlockStreamingCoalesceConfig,
  DmConfig,
  DmPolicy,
  GroupPolicy,
  GroupToolPolicyBySenderConfig,
  GroupToolPolicyConfig,
  MarkdownConfig,
  OpenClawConfig,
  BaseProbeResult,
} from "./runtime-api.js";

export type IrcChannelConfig = {
  requireMention?: boolean;
  tools?: GroupToolPolicyConfig;
  toolsBySender?: GroupToolPolicyBySenderConfig;
  skills?: string[];
  enabled?: boolean;
  allowFrom?: Array<string | number>;
  systemPrompt?: string;
};

export type IrcNickServConfig = {
  enabled?: boolean;
  service?: string;
  password?: string;
  passwordFile?: string;
  register?: boolean;
  registerEmail?: string;
};

export type IrcAccountConfig = {
  name?: string;
  enabled?: boolean;
  /**
   * Break-glass override: allow nick-only allowlist matching.
   * Default behavior requires host/user-qualified identities.
   */
  dangerouslyAllowNameMatching?: boolean;
  host?: string;
  port?: number;
  tls?: boolean;
  nick?: string;
  username?: string;
  realname?: string;
  password?: string;
  passwordFile?: string;
  nickserv?: IrcNickServConfig;
  dmPolicy?: DmPolicy;
  allowFrom?: Array<string | number>;
  defaultTo?: string;
  groupPolicy?: GroupPolicy;
  groupAllowFrom?: Array<string | number>;
  groups?: Record<string, IrcChannelConfig>;
  channels?: string[];
  mentionPatterns?: string[];
  markdown?: MarkdownConfig;
  historyLimit?: number;
  dmHistoryLimit?: number;
  dms?: Record<string, DmConfig>;
  textChunkLimit?: number;
  chunkMode?: "length" | "newline";
  blockStreaming?: boolean;
  blockStreamingCoalesce?: BlockStreamingCoalesceConfig;
  responsePrefix?: string;
  mediaMaxMb?: number;
};

export type IrcConfig = IrcAccountConfig & {
  accounts?: Record<string, IrcAccountConfig>;
  defaultAccount?: string;
};

export type CoreConfig = OpenClawConfig & {
  channels?: OpenClawConfig["channels"] & {
    irc?: IrcConfig;
  };
};

export type IrcInboundMessage = {
  messageId: string;
  /** Conversation peer id: channel name for groups, sender nick for DMs. */
  target: string;
  /** Raw IRC PRIVMSG target (bot nick for DMs, channel for groups). */
  rawTarget?: string;
  senderNick: string;
  senderUser?: string;
  senderHost?: string;
  text: string;
  timestamp: number;
  isGroup: boolean;
};

export type IrcProbe = BaseProbeResult<string> & {
  host: string;
  port: number;
  tls: boolean;
  nick: string;
  latencyMs?: number;
};
