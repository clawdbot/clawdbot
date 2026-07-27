// Gateway Protocol tests cover openclaw.schema behavior.
import { Compile } from "typebox/compile";
import { describe, expect, it } from "vitest";
import { SystemAgentChatResultSchema } from "./schema/openclaw.js";
import type { WizardStep } from "./schema/wizard.js";

/**
 * The chat result carries the awaited wizard step verbatim so control-capable
 * clients can render it. Every step type has to survive the wire, including the
 * fields the card-shaped `question` projection drops.
 */
describe("SystemAgentChatResultSchema", () => {
  const validate = Compile(SystemAgentChatResultSchema);
  const base = { sessionId: "chat-1", reply: "Bot token", action: "none" };

  const steps: Array<{ name: string; step: WizardStep }> = [
    {
      name: "text carrying placeholder, initial value, and secrecy",
      step: {
        id: "step-text",
        type: "text",
        message: "Bot token",
        placeholder: "123:abc",
        initialValue: "seed-token",
        sensitive: true,
        executor: "client",
      },
    },
    {
      name: "select with options",
      step: {
        id: "step-select",
        type: "select",
        message: "DM mode",
        options: [
          { value: "alpha", label: "Alpha", hint: "First" },
          { value: "beta", label: "Beta" },
        ],
        initialValue: "beta",
        executor: "client",
      },
    },
    {
      name: "multiselect with options",
      step: {
        id: "step-multiselect",
        type: "multiselect",
        message: "Features",
        options: [
          { value: "alerts", label: "Alerts" },
          { value: "logs", label: "Logs" },
        ],
        initialValue: ["alerts"],
        executor: "client",
      },
    },
    {
      name: "confirm",
      step: {
        id: "step-confirm",
        type: "confirm",
        message: "Enable delegated auth?",
        initialValue: false,
        executor: "client",
      },
    },
    {
      // The engine auto-answers notes, so this shape only reaches clients on the
      // wizard methods; the chat result still has to accept it losslessly.
      name: "note carrying a device code and an external URL",
      step: {
        id: "step-note",
        type: "note",
        title: "Sign in",
        message: "Enter this one-time code on the provider's sign-in page.",
        format: "plain",
        externalUrl: "https://example.com/auth",
        deviceCode: {
          code: "ABCD-EFGH",
          expiresInMinutes: 15,
          message: "Never share this code.",
        },
        executor: "client",
      },
    },
    {
      name: "progress",
      step: {
        id: "step-progress",
        type: "progress",
        message: "Linking your account",
        executor: "gateway",
      },
    },
    {
      name: "action executed by the client",
      step: {
        id: "step-action",
        type: "action",
        title: "Authorize",
        message: "Approve the app in your browser.",
        externalUrl: "https://example.com/authorize",
        executor: "client",
      },
    },
  ];

  it.each(steps)("accepts a chat result carrying a $name step", ({ step }) => {
    expect(validate.Check({ ...base, step })).toBe(true);
  });

  it("stays optional for replies with no awaited step", () => {
    expect(validate.Check(base)).toBe(true);
  });

  it("rejects a step outside the wizard step contract", () => {
    expect(validate.Check({ ...base, step: { id: "step-bogus", type: "freeform" } })).toBe(false);
  });
});
