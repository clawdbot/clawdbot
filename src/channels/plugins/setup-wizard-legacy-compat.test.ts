import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { WizardPrompter } from "../../wizard/prompts.js";
import {
  createLegacyCompatChannelDmPolicy,
  promptLegacyChannelAllowFromForAccount,
} from "./setup-wizard-legacy-compat.js";

describe("legacy channel setup compatibility", () => {
  it("preserves legacy DM policy behavior for shipped setup plugins", () => {
    const policy = createLegacyCompatChannelDmPolicy({ label: "Slack", channel: "slack" });
    const initial = {
      channels: {
        slack: {
          dm: { policy: "allowlist" },
          accounts: { work: { dmPolicy: "disabled", allowFrom: ["U1"] } },
        },
      },
    } as OpenClawConfig;

    expect(policy.getCurrent(initial, "work")).toBe("disabled");
    expect(policy.setPolicy(initial, "open", "work")).toMatchObject({
      channels: {
        slack: {
          accounts: {
            work: { dmPolicy: "open", allowFrom: ["U1", "*"] },
          },
        },
      },
    });
    expect(policy.setPolicy(initial, "open", "default")).toMatchObject({
      channels: {
        slack: {
          dmPolicy: "open",
          allowFrom: ["*"],
          dm: { policy: "allowlist", enabled: true },
        },
      },
    });
  });

  it("preserves the legacy allowlist prompt contract", async () => {
    const note = vi.fn(async () => undefined);
    const text = vi.fn(async () => "U2");
    const prompter = { note, text } as unknown as WizardPrompter;
    const cfg = {
      channels: { slack: { allowFrom: ["U1"] } },
    } as OpenClawConfig;

    const next = await promptLegacyChannelAllowFromForAccount({
      cfg,
      channel: "slack",
      prompter,
      defaultAccountId: "default",
      resolveAccount: () => ({ allowFrom: ["U1"] }),
      resolveExisting: (account) => account.allowFrom,
      resolveToken: () => null,
      noteTitle: "Slack allowlist",
      noteLines: ["Enter Slack user ids"],
      message: "Allowed users",
      placeholder: "U123",
      parseId: (value) => (/^U\d+$/.test(value) ? value : null),
      invalidWithoutTokenNote: "Use an id",
      resolveEntries: async () => [],
    });

    expect(note).toHaveBeenCalledWith("Enter Slack user ids", "Slack allowlist");
    expect(next).toMatchObject({
      channels: {
        slack: { allowFrom: ["U1", "U2"], dm: { enabled: true } },
      },
    });
  });
});
