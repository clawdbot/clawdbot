// Setup wizard binary tests cover channel setup wizard binary selection and invocation.
import { describe, expect, it, vi } from "vitest";
import {
  createCliPathTextInput,
  createDelegatedSetupWizardStatusResolvers,
  createDelegatedTextInputShouldPrompt,
  createDetectedBinaryStatus,
} from "./setup-wizard-binary.js";
import type { ChannelSetupWizard } from "./setup-wizard.js";

describe("createDetectedBinaryStatus", () => {
  it("builds status lines, hint, and score from binary detection", async () => {
    const resolveConfigured = vi.fn(() => true);
    const resolveBinaryPath = vi.fn(() => "/usr/local/bin/signal-cli");
    const status = createDetectedBinaryStatus({
      channelLabel: "Signal",
      binaryLabel: "signal-cli",
      configuredLabel: "configured",
      unconfiguredLabel: "needs setup",
      configuredHint: "signal-cli found",
      unconfiguredHint: "signal-cli missing",
      configuredScore: 1,
      unconfiguredScore: 0,
      resolveConfigured,
      resolveBinaryPath,
      detectBinary: vi.fn(async () => true),
    });

    expect(await status.resolveConfigured({ cfg: {}, accountId: "work" })).toBe(true);
    expect(resolveConfigured).toHaveBeenCalledWith({ cfg: {}, accountId: "work" });
    expect(await status.resolveStatusLines?.({ cfg: {}, configured: true })).toEqual([
      "Signal: configured",
      "signal-cli: found (/usr/local/bin/signal-cli)",
    ]);
    expect(resolveBinaryPath).toHaveBeenCalledWith({ cfg: {}, accountId: undefined });
    expect(await status.resolveSelectionHint?.({ cfg: {}, configured: true })).toBe(
      "signal-cli found",
    );
    expect(await status.resolveQuickstartScore?.({ cfg: {}, configured: true })).toBe(1);
  });

  it("passes accountId into binary path resolution", async () => {
    const resolveBinaryPath = vi.fn(({ accountId }: { accountId?: string }) =>
      accountId === "work" ? "/opt/work-signal-cli" : "/usr/local/bin/signal-cli",
    );
    const status = createDetectedBinaryStatus({
      channelLabel: "Signal",
      binaryLabel: "signal-cli",
      configuredLabel: "configured",
      unconfiguredLabel: "needs setup",
      configuredHint: "signal-cli found",
      unconfiguredHint: "signal-cli missing",
      configuredScore: 1,
      unconfiguredScore: 0,
      resolveConfigured: () => true,
      resolveBinaryPath,
      detectBinary: vi.fn(async () => false),
    });

    expect(
      await status.resolveStatusLines?.({ cfg: {}, accountId: "work", configured: false }),
    ).toEqual(["Signal: needs setup", "signal-cli: missing (/opt/work-signal-cli)"]);
    expect(resolveBinaryPath).toHaveBeenCalledWith({ cfg: {}, accountId: "work" });
  });
});

describe("createCliPathTextInput", () => {
  it("reuses the same path resolver for current and initial values", async () => {
    const textInput = createCliPathTextInput({
      inputKey: "cliPath",
      message: "CLI path",
      resolvePath: () => "imsg",
      shouldPrompt: async () => false,
      helpTitle: "iMessage",
      helpLines: ["help"],
    });

    expect(
      await textInput.currentValue?.({ cfg: {}, accountId: "default", credentialValues: {} }),
    ).toBe("imsg");
    expect(
      await textInput.initialValue?.({ cfg: {}, accountId: "default", credentialValues: {} }),
    ).toBe("imsg");
    expect(textInput.helpTitle).toBe("iMessage");
    expect(textInput.helpLines).toEqual(["help"]);
  });
});

describe("createDelegatedSetupWizardStatusResolvers", () => {
  it("forwards optional status resolvers to the loaded wizard", async () => {
    const loadWizard = vi.fn(
      async (): Promise<ChannelSetupWizard> => ({
        channel: "demo",
        status: {
          configuredLabel: "configured",
          unconfiguredLabel: "needs setup",
          resolveConfigured: () => true,
          resolveStatusLines: async () => ["line"],
          resolveSelectionHint: async () => "hint",
          resolveQuickstartScore: async () => 7,
        },
        credentials: [],
      }),
    );

    const status = createDelegatedSetupWizardStatusResolvers(loadWizard);

    expect(await status.resolveStatusLines?.({ cfg: {}, configured: true })).toEqual(["line"]);
    expect(await status.resolveSelectionHint?.({ cfg: {}, configured: true })).toBe("hint");
    expect(await status.resolveQuickstartScore?.({ cfg: {}, configured: true })).toBe(7);
  });
});

describe("createDelegatedTextInputShouldPrompt", () => {
  it("forwards shouldPrompt for the requested input key", async () => {
    const loadWizard = vi.fn(
      async (): Promise<ChannelSetupWizard> => ({
        channel: "demo",
        status: {
          configuredLabel: "configured",
          unconfiguredLabel: "needs setup",
          resolveConfigured: () => true,
        },
        credentials: [],
        textInputs: [
          {
            inputKey: "cliPath",
            message: "CLI path",
            shouldPrompt: async ({ currentValue }) => currentValue !== "imsg",
          },
        ],
      }),
    );

    const shouldPrompt = createDelegatedTextInputShouldPrompt({
      loadWizard,
      inputKey: "cliPath",
    });

    expect(
      await shouldPrompt({
        cfg: {},
        accountId: "default",
        credentialValues: {},
        currentValue: "imsg",
      }),
    ).toBe(false);
    expect(
      await shouldPrompt({
        cfg: {},
        accountId: "default",
        credentialValues: {},
        currentValue: "other",
      }),
    ).toBe(true);
  });
});
