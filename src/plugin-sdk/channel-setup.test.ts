// Channel setup tests cover setup wizard finalize behavior and config write contracts.
import { runSetupWizardFinalize } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { ChannelSetupInput } from "./channel-setup.js";
import { createOptionalChannelSetupSurface } from "./channel-setup.js";

interface ThirdPartySetupInput {
  name?: string;
  botToken?: string;
}

describe("ChannelSetupInput", () => {
  it("keeps the generic envelope and deprecated compatibility tier typed", () => {
    expectTypeOf<ChannelSetupInput["name"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<ChannelSetupInput["token"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<ChannelSetupInput["tokenFile"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<ChannelSetupInput["useEnv"]>().toEqualTypeOf<boolean | undefined>();
    expectTypeOf<ChannelSetupInput["allowFrom"]>().toEqualTypeOf<string[] | undefined>();
    expectTypeOf<ChannelSetupInput["defaultTo"]>().toEqualTypeOf<string | undefined>();

    expectTypeOf<ChannelSetupInput["botToken"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<ChannelSetupInput["appToken"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<ChannelSetupInput["mode"]>().toEqualTypeOf<
      "socket" | "http" | "relay" | undefined
    >();
    expectTypeOf<ChannelSetupInput["privateKey"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<ChannelSetupInput["password"]>().toEqualTypeOf<string | undefined>();

    const assignable: ChannelSetupInput = {} as ThirdPartySetupInput;
    expectTypeOf(assignable).toEqualTypeOf<ChannelSetupInput>();
  });
});

describe("createOptionalChannelSetupSurface", () => {
  it("returns a matched adapter and wizard for optional plugins", async () => {
    const setup = createOptionalChannelSetupSurface({
      channel: "example",
      label: "Example",
      npmSpec: "@openclaw/example",
      docsPath: "/channels/example",
    });

    expect(setup.setupAdapter.resolveAccountId?.({ cfg: {} })).toBe("default");
    expect(
      setup.setupAdapter.validateInput?.({
        cfg: {},
        accountId: "default",
        input: {},
      }),
    ).toBe(
      "Example setup requires @openclaw/example to be installed. Docs: https://docs.openclaw.ai/channels/example",
    );
    expect(setup.setupWizard.channel).toBe("example");
    expect(setup.setupWizard.status.unconfiguredHint).toBe(
      "Example setup requires @openclaw/example to be installed. Docs: https://docs.openclaw.ai/channels/example",
    );
    await expect(
      runSetupWizardFinalize({
        finalize: setup.setupWizard.finalize,
        runtime: {
          log: () => {},
          error: () => {},
          exit: async () => {},
        },
      }),
    ).rejects.toThrow("@openclaw/example");
  });
});
