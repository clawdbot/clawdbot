import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelSetupDmPolicy } from "../commands/channel-setup/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { maybeConfigureDmPolicies } from "./channel-setup.prompts.js";

beforeEach(() => {
  delete process.env.OPENCLAW_LOCALE;
});

describe("maybeConfigureDmPolicies", () => {
  it("localizes DM policy guidance and options", async () => {
    process.env.OPENCLAW_LOCALE = "zh-CN";
    const note = vi.fn<WizardPrompter["note"]>(async () => {});
    const select = vi.fn(async () => "pairing") as unknown as WizardPrompter["select"];
    const prompter = {
      confirm: vi.fn(async () => true),
      note,
      select,
    } as unknown as WizardPrompter;
    const policy: ChannelSetupDmPolicy = {
      label: "Telegram",
      channel: "telegram" as ChannelSetupDmPolicy["channel"],
      policyKey: "channels.telegram.dmPolicy",
      allowFromKey: "channels.telegram.allowFrom",
      getCurrent: () => "pairing",
      setPolicy: (cfg: OpenClawConfig) => cfg,
    };

    await maybeConfigureDmPolicies({
      cfg: {},
      selection: ["telegram" as never],
      prompter,
      resolveAdapter: () => ({ dmPolicy: policy }) as never,
    });

    expect(note.mock.calls[0]?.[0]).toContain("默认：配对");
    expect(note.mock.calls[0]?.[1]).toBe("Telegram DM 访问");
    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Telegram DM 策略",
        options: expect.arrayContaining([
          expect.objectContaining({ label: "配对（推荐）", value: "pairing" }),
        ]),
      }),
    );
  });
});
