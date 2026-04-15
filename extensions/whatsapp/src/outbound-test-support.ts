import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { MockInstance } from "vitest";

export function createWhatsAppPollFixture() {
  const cfg = { marker: "resolved-cfg" } as OpenClawConfig;
  const poll = {
    question: "Lunch?",
    options: ["Pizza", "Sushi"],
    maxSelections: 1,
  };
  return {
    cfg,
    poll,
    to: "+1555",
    accountId: "work",
  };
}

export function expectWhatsAppPollSent(
  sendPollWhatsApp: MockInstance,
  params: {
    cfg: OpenClawConfig;
    poll: { question: string; options: string[]; maxSelections: number };
    to?: string;
    accountId?: string;
  },
) {
  const expected = [
    params.to ?? "+1555",
    params.poll,
    {
      verbose: false,
      accountId: params.accountId ?? "work",
      cfg: params.cfg,
    },
  ];
  const actual = sendPollWhatsApp.mock.calls.at(-1);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected WhatsApp poll send ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}
