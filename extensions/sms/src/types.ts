// Sms type declarations define plugin contracts.
import type { SecretInput } from "openclaw/plugin-sdk/secret-input";

type SmsChannelConfigFields = {
  /** Megabyte cap for media this channel accepts and delivers. */
  mediaMaxMb?: number;
  enabled?: boolean;
  accountSid?: string;
  authToken?: SecretInput;
  fromNumber?: string;
  messagingServiceSid?: string;
  defaultTo?: string;
  webhookPath?: string;
  publicWebhookUrl?: string;
  dangerouslyDisableSignatureValidation?: boolean;
  dmPolicy?: "pairing" | "open" | "allowlist" | "disabled";
  allowFrom?: string | Array<string | number>;
  textChunkLimit?: number;
};

export interface SmsChannelConfig extends SmsChannelConfigFields {
  accounts?: Record<string, SmsAccountRaw>;
  defaultAccount?: string;
}

interface SmsAccountRaw extends SmsChannelConfigFields {}

export interface ResolvedSmsAccount {
  accountId: string;
  enabled: boolean;
  accountSid: string;
  authToken: string;
  fromNumber: string;
  messagingServiceSid: string;
  defaultTo: string;
  webhookPath: string;
  publicWebhookUrl: string;
  dangerouslyDisableSignatureValidation: boolean;
  dmPolicy: "pairing" | "open" | "allowlist" | "disabled";
  allowFrom: string[];
  textChunkLimit: number;
  mediaMaxBytes?: number;
}

export interface SmsInboundMessage {
  messageSid: string;
  accountSid: string;
  messagingServiceSid?: string;
  from: string;
  to: string;
  body: string;
  media: SmsInboundMedia[];
  unavailableMediaCount?: number;
}

type SmsInboundMedia = {
  url: string;
  contentType?: string;
};

export type SmsSendResult = {
  sid: string;
  to: string;
  from?: string;
  status?: string;
};
