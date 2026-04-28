import {
  createPluginSetupWizardStatus,
  createQueuedWizardPrompter,
  runSetupWizardFinalize,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { DEFAULT_ACCOUNT_ID, type OpenClawConfig } from "openclaw/plugin-sdk/setup";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { whatsappSetupWizard } from "./setup-surface.js";
import {
  createWhatsAppAllowlistModeInput,
  createWhatsAppLinkingHarness,
  createWhatsAppOwnerAllowlistHarness,
  createWhatsAppPersonalPhoneHarness,
  createWhatsAppRootAllowFromConfig,
  createWhatsAppWorkAccountConfig,
  expectNoWhatsAppLoginFollowup,
  expectWhatsAppAllowlistModeSetup,
  expectWhatsAppLoginFollowup,
  expectWhatsAppOpenPolicySetup,
  expectWhatsAppOwnerAllowlistSetup,
  expectWhatsAppPersonalPhoneSetup,
  expectWhatsAppSeparatePhoneDisabledSetup,
  expectWhatsAppWorkAccountAccessNote,
  expectWhatsAppWorkAccountOpenAccess,
} from "./setup-test-helpers.js";

const hoisted = vi.hoisted(() => ({
  detectWhatsAppLinked: vi.fn<(cfg: OpenClawConfig, accountId: string) => Promise<boolean>>(
    async () => false,
  ),
  loginWeb: vi.fn(async () => {}),
  pathExists: vi.fn(async () => false),
  readWebAuthState: vi.fn<(authDir: string) => Promise<"linked" | "not-linked" | "unstable">>(
    async () => "not-linked",
  ),
  resolveWhatsAppAuthDir: vi.fn<
    (params: { cfg: OpenClawConfig; accountId: string }) => { authDir: string }
  >(() => ({
    authDir: "/tmp/openclaw-whatsapp-test",
  })),
}));

vi.mock("./login.js", () => ({
  loginWeb: hoisted.loginWeb,
}));

vi.mock("./setup-finalize.js", async () => {
  const actual = await vi.importActual<typeof import("./setup-finalize.js")>("./setup-finalize.js");
  return {
    ...actual,
    detectWhatsAppLinked: hoisted.detectWhatsAppLinked,
  };
});

vi.mock("openclaw/plugin-sdk/setup", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/setup")>(
    "openclaw/plugin-sdk/setup",
  );
  return {
    ...actual,
    pathExists: hoisted.pathExists,
  };
});

vi.mock("./accounts.js", async () => {
  const actual = await vi.importActual<typeof import("./accounts.js")>("./accounts.js");
  return Object.assign({}, actual, {
    resolveWhatsAppAuthDir: hoisted.resolveWhatsAppAuthDir,
  });
});

vi.mock("./auth-store.js", async () => {
  const actual = await vi.importActual<typeof import("./auth-store.js")>("./auth-store.js");
  return Object.assign({}, actual, {
    readWebAuthState: hoisted.readWebAuthState,
  });
});

const createRuntime = (): RuntimeEnv =>
  ({
    error: vi.fn(),
  }) as unknown as RuntimeEnv;

const whatsappGetStatus = createPluginSetupWizardStatus({
  id: "whatsapp",
  meta: {
    label: "WhatsApp",
  },
  setupWizard: whatsappSetupWizard,
} as never);

async function runFinalizeWithHarness(params: {
  harness: ReturnType<typeof createQueuedWizardPrompter>;
  cfg?: Parameters<NonNullable<typeof whatsappSetupWizard.finalize>>[0]["cfg"];
  runtime?: RuntimeEnv;
  forceAllowFrom?: boolean;
  accountId?: string;
}) {
  return await runSetupWizardFinalize({
    finalize: whatsappSetupWizard.finalize,
    cfg: params.cfg ?? {},
    accountId: params.accountId ?? DEFAULT_ACCOUNT_ID,
    runtime: params.runtime ?? createRuntime(),
    prompter: params.harness.prompter,
    forceAllowFrom: params.forceAllowFrom ?? false,
  });
}

function createSeparatePhoneHarness(params: { selectValues: string[]; textValues?: string[] }) {
  return createQueuedWizardPrompter({
    confirmValues: [false],
    selectValues: params.selectValues,
    textValues: params.textValues,
  });
}

function expectFinalizeResult(result: Awaited<ReturnType<typeof runFinalizeWithHarness>>): {
  cfg: OpenClawConfig;
} {
  expect(result).toBeDefined();
  if (!result || typeof result !== "object" || !("cfg" in result) || !result.cfg) {
    throw new Error("Expected WhatsApp finalize result with cfg");
  }
  return result as { cfg: OpenClawConfig };
}

async function runSeparatePhoneFlow(params: { selectValues: string[]; textValues?: string[] }) {
  hoisted.pathExists.mockResolvedValue(true);
  const harness = createSeparatePhoneHarness({
    selectValues: params.selectValues,
    textValues: params.textValues,
  });
  const result = expectFinalizeResult(
    await runFinalizeWithHarness({
      harness,
    }),
  );
  return { harness, result };
}

describe("whatsapp setup wizard", () => {
  beforeEach(() => {
    hoisted.detectWhatsAppLinked.mockReset();
    hoisted.detectWhatsAppLinked.mockResolvedValue(false);
    hoisted.loginWeb.mockReset();
    hoisted.pathExists.mockReset();
    hoisted.pathExists.mockResolvedValue(false);
    hoisted.readWebAuthState.mockReset();
    hoisted.readWebAuthState.mockResolvedValue("not-linked");
    hoisted.resolveWhatsAppAuthDir.mockReset();
    hoisted.resolveWhatsAppAuthDir.mockReturnValue({ authDir: "/tmp/openclaw-whatsapp-test" });
  });

  it("applies owner allowlist when forceAllowFrom is enabled", async () => {
    const harness = createWhatsAppOwnerAllowlistHarness(createQueuedWizardPrompter);

    const result = expectFinalizeResult(
      await runFinalizeWithHarness({
        harness,
        forceAllowFrom: true,
      }),
    );

    expect(hoisted.loginWeb).not.toHaveBeenCalled();
    expectWhatsAppOwnerAllowlistSetup(result.cfg, harness);
  });

  it("supports disabled DM policy for separate-phone setup", async () => {
    const { harness, result } = await runSeparatePhoneFlow({
      selectValues: ["separate", "disabled"],
    });

    expectWhatsAppSeparatePhoneDisabledSetup(result.cfg, harness);
  });

  it("writes named-account DM policy and allowFrom instead of the channel root", async () => {
    hoisted.pathExists.mockResolvedValue(true);
    const harness = createSeparatePhoneHarness({
      selectValues: ["separate", "open"],
    });

    const named = expectFinalizeResult(
      await runFinalizeWithHarness({
        harness,
        accountId: "work",
        cfg: createWhatsAppWorkAccountConfig() as OpenClawConfig,
      }),
    );

    expectWhatsAppWorkAccountOpenAccess(named.cfg);
    expectWhatsAppWorkAccountAccessNote(harness);
  });

  it("labels the selected named account in setup status even when not linked", async () => {
    const status = await whatsappGetStatus({
      cfg: {
        channels: {
          whatsapp: {
            accounts: {
              work: {
                authDir: "/tmp/work",
              },
            },
          },
        },
      } as OpenClawConfig,
      accountOverrides: {
        whatsapp: "work",
      },
    });

    expect(status.configured).toBe(false);
    expect(status.statusLines).toEqual(["WhatsApp (work): not linked"]);
  });

  it("uses configured defaultAccount for omitted-account setup status", async () => {
    hoisted.resolveWhatsAppAuthDir.mockImplementation(({ accountId }: { accountId: string }) => ({
      authDir: accountId === "work" ? "/tmp/work" : "/tmp/default",
    }));
    hoisted.readWebAuthState.mockImplementation(async (authDir: string) =>
      authDir === "/tmp/work" ? "linked" : "not-linked",
    );

    const status = await whatsappGetStatus({
      cfg: {
        channels: {
          whatsapp: {
            defaultAccount: "work",
            accounts: {
              default: {
                authDir: "/tmp/default",
              },
              work: {
                authDir: "/tmp/work",
              },
            },
          },
        },
      } as OpenClawConfig,
      accountOverrides: {},
    });

    expect(status.configured).toBe(true);
    expect(status.statusLines).toEqual(["WhatsApp (work): linked"]);
    expect(hoisted.readWebAuthState).toHaveBeenCalledWith("/tmp/default");
    expect(hoisted.readWebAuthState).toHaveBeenCalledWith("/tmp/work");
  });

  it("shows auth stabilizing when auth reads time out", async () => {
    hoisted.resolveWhatsAppAuthDir.mockReturnValue({ authDir: "/tmp/work" });
    hoisted.readWebAuthState.mockResolvedValue("unstable");

    const status = await whatsappGetStatus({
      cfg: {
        channels: {
          whatsapp: {
            accounts: {
              work: {
                authDir: "/tmp/work",
              },
            },
          },
        },
      } as OpenClawConfig,
      accountOverrides: {
        whatsapp: "work",
      },
    });

    expect(status.configured).toBe(false);
    expect(status.statusLines).toEqual(["WhatsApp (work): auth stabilizing"]);
  });

  it("uses configured defaultAccount for omitted-account finalize writes", async () => {
    hoisted.pathExists.mockResolvedValue(true);
    const harness = createSeparatePhoneHarness({
      selectValues: ["separate", "open"],
    });

    const result = expectFinalizeResult(
      await runFinalizeWithHarness({
        harness,
        accountId: "",
        cfg: createWhatsAppWorkAccountConfig({ defaultAccount: "work" }) as OpenClawConfig,
      }),
    );

    expectWhatsAppWorkAccountOpenAccess(result.cfg);
    expectWhatsAppWorkAccountAccessNote(harness);
  });

  it("normalizes allowFrom entries when list mode is selected", async () => {
    const { result } = await runSeparatePhoneFlow(createWhatsAppAllowlistModeInput());

    expectWhatsAppAllowlistModeSetup(result.cfg);
  });

  it("enables allowlist self-chat mode for personal-phone setup", async () => {
    hoisted.pathExists.mockResolvedValue(true);
    const harness = createWhatsAppPersonalPhoneHarness(createQueuedWizardPrompter);

    const result = expectFinalizeResult(
      await runFinalizeWithHarness({
        harness,
      }),
    );

    expectWhatsAppPersonalPhoneSetup(result.cfg);
  });

  it("forces wildcard allowFrom for open policy without allowFrom follow-up prompts", async () => {
    hoisted.pathExists.mockResolvedValue(true);
    const harness = createSeparatePhoneHarness({
      selectValues: ["separate", "open"],
    });

    const result = expectFinalizeResult(
      await runFinalizeWithHarness({
        harness,
        cfg: createWhatsAppRootAllowFromConfig() as OpenClawConfig,
      }),
    );

    expectWhatsAppOpenPolicySetup(result.cfg, harness);
  });

  it("runs WhatsApp login when not linked and user confirms linking", async () => {
    hoisted.pathExists.mockResolvedValue(false);
    const harness = createWhatsAppLinkingHarness(createQueuedWizardPrompter);
    const runtime = createRuntime();

    await runFinalizeWithHarness({
      harness,
      runtime,
    });

    expect(hoisted.loginWeb).toHaveBeenCalledWith(false, undefined, runtime, DEFAULT_ACCOUNT_ID);
  });

  it("skips relink note when already linked and relink is declined", async () => {
    hoisted.pathExists.mockResolvedValue(true);
    const harness = createSeparatePhoneHarness({
      selectValues: ["separate", "disabled"],
    });

    await runFinalizeWithHarness({
      harness,
    });

    expect(hoisted.loginWeb).not.toHaveBeenCalled();
    expectNoWhatsAppLoginFollowup(harness);
  });

  it("shows follow-up login command note when not linked and linking is skipped", async () => {
    hoisted.pathExists.mockResolvedValue(false);
    const harness = createSeparatePhoneHarness({
      selectValues: ["separate", "disabled"],
    });

    await runFinalizeWithHarness({
      harness,
    });

    expectWhatsAppLoginFollowup(harness);
  });
});
