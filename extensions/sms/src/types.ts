import type { SecretInput } from "openclaw/plugin-sdk/secret-input";

export type SmsChannelConfigFields = {
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
  allowFrom?: string | string[];
  textChunkLimit?: number;
};

export interface SmsChannelConfig extends SmsChannelConfigFields {
  accounts?: Record<string, SmsAccountRaw>;
  defaultAccount?: string;
}

export interface SmsAccountRaw extends SmsChannelConfigFields {}

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
}

export interface SmsInboundMessage {
  messageSid: string;
  accountSid: string;
  from: string;
  to: string;
  body: string;
}

export type SmsSendResult = {
  sid: string;
  to: string;
  from?: string;
  status?: string;
};
