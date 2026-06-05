// Sms tests cover send plugin behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedSmsAccount } from "./types.js";

type SendModule = typeof import("./send.js");

let sendSmsTextChunks: SendModule["sendSmsTextChunks"];
let toSmsPlainText: SendModule["toSmsPlainText"];

const sendSmsViaTwilio = vi.hoisted(() => vi.fn(async ({ to }) => ({ sid: `SM-${to}`, to })));

beforeEach(async () => {
  vi.resetModules();
  sendSmsViaTwilio.mockClear();
  vi.doMock("./twilio.js", () => ({
    sendSmsViaTwilio,
  }));
  ({ sendSmsTextChunks, toSmsPlainText } = await import("./send.js"));
});

afterEach(() => {
  vi.doUnmock("./twilio.js");
});

function createAccount(textChunkLimit: number): ResolvedSmsAccount {
  return {
    accountId: "default",
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
    textChunkLimit,
  };
}

describe("sendSmsTextChunks", () => {
  it("splits long SMS text before sending to Twilio", async () => {
    await sendSmsTextChunks({
      account: createAccount(5),
      to: "+15551234567",
      text: "alpha beta",
    });

    expect(sendSmsViaTwilio).toHaveBeenCalledTimes(2);
    expect(sendSmsViaTwilio.mock.calls.map(([call]) => call.text)).toEqual(["alpha", "beta"]);
  });

  it("flattens markdown before sending SMS chunks", async () => {
    expect(
      toSmsPlainText("**Hi** [docs](https://example.com)\n\n```bash\napprove 123\n```\nthere"),
    ).toBe("Hi docs (https://example.com)\n\napprove 123\nthere");
  });
});
