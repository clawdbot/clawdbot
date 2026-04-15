export type QaChannelActionConfig = {
  messages?: boolean;
  reactions?: boolean;
  search?: boolean;
  threads?: boolean;
};

export type QaChannelAccountConfig = {
  name?: string;
  enabled?: boolean;
  baseUrl?: string;
  botUserId?: string;
  botDisplayName?: string;
  pollTimeoutMs?: number;
  allowFrom?: Array<string | number>;
  defaultTo?: string;
  actions?: QaChannelActionConfig;
};

export type QaChannelConfig = QaChannelAccountConfig & {
  accounts?: Record<string, Partial<QaChannelAccountConfig>>;
  defaultAccount?: string;
};

export type CoreConfig = {
  channels?: {
    "qa-channel"?: QaChannelConfig;
  };
  session?: {
    store?: string;
  };
};

export type ResolvedQaChannelAccount = {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  name?: string;
  baseUrl: string;
  botUserId: string;
  botDisplayName: string;
  pollTimeoutMs: number;
  config: QaChannelAccountConfig;
};
