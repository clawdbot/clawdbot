// Sms test support shares webhook fixtures between the unit and raw-wire suites.
import { vi } from "vitest";
import type { SmsDeliveryRecorder } from "./delivery-observations.js";
import type { ResolvedSmsAccount } from "./types.js";

let testAccountSequence = 0;
let activeAccountId = "test-0";

// Each test gets its own account id so the handler's per-account rate-limiter
// buckets never carry a previous test's counters into the next one.
export function advanceSmsTestAccountId(): string {
  activeAccountId = `test-${++testAccountSequence}`;
  return activeAccountId;
}

export function createSmsTestAccount(
  overrides: Partial<ResolvedSmsAccount> = {},
): ResolvedSmsAccount {
  return {
    accountId: activeAccountId,
    enabled: true,
    accountSid: "AC123",
    authToken: "secret",
    fromNumber: "+15557654321",
    messagingServiceSid: "",
    defaultTo: "",
    webhookPath: "/webhooks/sms",
    publicWebhookUrl: "https://gateway.example.com/webhooks/sms",
    dangerouslyDisableSignatureValidation: false,
    dmPolicy: "pairing",
    allowFrom: [],
    textChunkLimit: 1500,
    ...overrides,
  };
}

export function createSmsTestDeliveryRecorder(
  record = vi.fn<SmsDeliveryRecorder["record"]>(async ({ account, form }) => ({
    duplicate: false,
    record: {
      accountId: account.accountId,
      accountSidHash: "account-sid-hash",
      messageSid: form.MessageSid ?? form.SmsSid ?? form.SmsMessageSid ?? "",
      status: form.MessageStatus ?? form.SmsStatus ?? "",
      firstObservedAt: 1,
      lastObservedAt: 1,
      observations: [],
    },
  })),
): SmsDeliveryRecorder & { record: typeof record } {
  return { record };
}
