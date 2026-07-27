// Telegram type declarations define plugin contracts.
import type { OpenClawConfig, ReplyToMode } from "openclaw/plugin-sdk/config-contracts";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import type { TelegramBotDeps } from "./bot-deps.js";
import type { TelegramBotInfo } from "./bot-info.js";
import type {
  CurrentDmRecoveryFreshness,
  CurrentDmRecoveryScheduler,
  CurrentDmRecoveryStore,
} from "./current-dm-recovery-coordinator.js";
import type { TelegramTransport } from "./fetch.js";

export type TelegramCurrentDmRecoveryOptions = {
  /** Explicit feature gate. Omission or false leaves Recovery completely disabled. */
  enabled: true;
  /** Durable ingress ownership generation supplied by the Telegram host. */
  ingressGeneration: number;
  /** Generation of the feature gate/config snapshot authorizing this turn. */
  featureGateGeneration: number;
  store: CurrentDmRecoveryStore;
  scheduler: CurrentDmRecoveryScheduler;
  checkFreshness: (
    identity: import("./current-dm-recovery-coordinator.js").CurrentDmRecoveryIdentity,
  ) => CurrentDmRecoveryFreshness | Promise<CurrentDmRecoveryFreshness>;
};

export type TelegramBotOptions = {
  token: string;
  accountId?: string;
  runtime?: RuntimeEnv;
  requireMention?: boolean;
  allowFrom?: Array<string | number>;
  groupAllowFrom?: Array<string | number>;
  mediaMaxMb?: number;
  replyToMode?: ReplyToMode;
  proxyFetch?: typeof fetch;
  config?: OpenClawConfig;
  /** Bot identity returned by the startup getMe probe. Avoids a duplicate grammY init getMe before polling. */
  botInfo?: TelegramBotInfo;
  /** Signal to abort in-flight Telegram API fetch requests (e.g. getUpdates) on shutdown. */
  fetchAbortSignal?: AbortSignal;
  /** Signal to abort inbound media resolution without cancelling adopted-turn Bot API calls. */
  mediaAbortSignal?: AbortSignal;
  /** Minimum grammY client timeout when timeoutSeconds is configured on long-polling bots. */
  minimumClientTimeoutSeconds?: number;
  updateOffset?: {
    lastUpdateId?: number | null;
    persistenceFloorUpdateId?: number | null;
    onUpdateId?: (updateId: number) => void | Promise<void>;
  };
  testTimings?: {
    mediaGroupFlushMs?: number;
    textFragmentGapMs?: number;
  };
  /** Pre-resolved Telegram transport to reuse across bot instances. If not provided, creates a new one. */
  telegramTransport?: TelegramTransport;
  /** Narrow, disabled-by-default host wiring for the exact current main Telegram DM. */
  currentDmRecovery?: TelegramCurrentDmRecoveryOptions;
  telegramDeps?: TelegramBotDeps;
};
