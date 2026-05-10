import type { ResolvedChannelMessageIngress } from "openclaw/plugin-sdk/channel-ingress-runtime";
import type { EffectivePolicyInput } from "../access/resolve-policy.js";
import type { FetchMediaOptions, FetchMediaResult, SecretInputRef } from "./types.js";

export type QQBotInboundAccess = ResolvedChannelMessageIngress;

export interface AccessPort {
  resolveInboundAccess(
    input: EffectivePolicyInput & {
      cfg: unknown;
      accountId: string;
      isGroup: boolean;
      senderId: string;
      conversationId: string;
    },
  ): QQBotInboundAccess | Promise<QQBotInboundAccess>;

  resolveSlashCommandAuthorization(input: {
    cfg: unknown;
    accountId: string;
    isGroup: boolean;
    senderId: string;
    conversationId: string;
    allowFrom?: Array<string | number>;
    groupAllowFrom?: Array<string | number>;
    commandsAllowFrom?: Array<string | number>;
  }): boolean | Promise<boolean>;
}

export interface EngineAdapters {
  history: import("./history.port.js").HistoryPort;
  mentionGate: import("./mention-gate.port.js").MentionGatePort;
  access: AccessPort;
  audioConvert: import("./audio.port.js").AudioConvertPort;
  outboundAudio: import("./audio.port.js").OutboundAudioPort;
  commands: import("./commands.port.js").CommandsPort;
}

export interface PlatformAdapter {
  validateRemoteUrl(url: string, options?: { allowPrivate?: boolean }): Promise<void>;
  resolveSecret(value: string | SecretInputRef | undefined): Promise<string | undefined>;
  downloadFile(url: string, destDir: string, filename?: string): Promise<string>;
  fetchMedia(options: FetchMediaOptions): Promise<FetchMediaResult>;
  getTempDir(): string;
  hasConfiguredSecret(value: unknown): boolean;
  normalizeSecretInputString(value: unknown): string | undefined;
  resolveSecretInputString(params: { value: unknown; path: string }): string | undefined;
  resolveApproval?(approvalId: string, decision: string): Promise<boolean>;
}

let _adapter: PlatformAdapter | null = null;
let _adapterFactory: (() => PlatformAdapter) | null = null;

export function registerPlatformAdapter(adapter: PlatformAdapter): void {
  _adapter = adapter;
}

export function registerPlatformAdapterFactory(factory: () => PlatformAdapter): void {
  _adapterFactory = factory;
}

export function getPlatformAdapter(): PlatformAdapter {
  if (!_adapter && _adapterFactory) {
    _adapter = _adapterFactory();
  }
  if (!_adapter) {
    throw new Error(
      "PlatformAdapter not registered. Call registerPlatformAdapter() during bootstrap.",
    );
  }
  return _adapter;
}

export function hasPlatformAdapter(): boolean {
  return _adapter !== null || _adapterFactory !== null;
}
