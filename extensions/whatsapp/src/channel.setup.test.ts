import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/routing";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createQueuedWizardPrompter } from "../../../test/helpers/plugins/setup-wizard.js";
import { whatsappApprovalAuth } from "./approval-auth.js";
import { whatsappPlugin } from "./channel.js";
import { checkWhatsAppHeartbeatReady } from "./heartbeat.js";
import type { OpenClawConfig } from "./runtime-api.js";
import { finalizeWhatsAppSetup } from "./setup-finalize.js";
import {
  createWhatsAppAllowlistModeInput,
  createWhatsAppLinkingHarness,
  createWhatsAppOwnerAllowlistHarness,
  createWhatsAppPersonalPhoneHarness,
  createWhatsAppRootAllowFromConfig,
  expectNoWhatsAppLoginFollowup,
  expectWhatsAppAllowlistModeSetup,
  expectWhatsAppLoginFollowup,
  expectWhatsAppOpenPolicySetup,
  expectWhatsAppOwnerAllowlistSetup,
  expectWhatsAppPersonalPhoneSetup,
  expectWhatsAppSeparatePhoneDisabledSetup,
} from "./setup-test-helpers.js";

const hoisted = vi.hoisted(() => ({
  loginWeb: vi.fn(async () => {}),
  pathExists: vi.fn(async () => false),
  resolveWhatsAppAuthDir: vi.fn(() => ({
    authDir: "/tmp/openclaw-whatsapp-test",
  })),
}));

vi.mock("./login.js", () => ({
  loginWeb: hoisted.loginWeb,
}));

vi.mock("openclaw/plugin-sdk/setup", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/setup")>(
    "openclaw/plugin-sdk/setup",
  );
  const normalizeE164 = (value?: string | null) => {
    const raw = (value ?? "").trim();
    if (!raw) {
      return "";
    }
    const digits = raw.replace(/[^\d+]/g, "");
    return digits.startsWith("+") ? digits : `+${digits}`;
  };
  return {
    ...actual,
    DEFAULT_ACCOUNT_ID,
    normalizeAccountId: (value?: string | null) => value?.trim() || DEFAULT_ACCOUNT_ID,
    normalizeAllowFromEntries: (entries: string[], normalize: (value: string) => string) => [
      ...new Set(entries.map((entry) => (entry === "*" ? "*" : normalize(entry))).filter(Boolean)),
    ],
    normalizeE164,
    pathExists: hoisted.pathExists,
    splitSetupEntries: (raw: string) =>
      raw
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    setSetupChannelEnabled: (cfg: OpenClawConfig, channel: string, enabled: boolean) => ({
      ...cfg,
      channels: {
        ...cfg.channels,
        [channel]: {
          ...(cfg.channels?.[channel as keyof NonNullable<OpenClawConfig["channels"]>] as object),
          enabled,
        },
      },
    }),
  };
});

vi.mock("./accounts.js", async () => {
  const actual = await vi.importActual<typeof import("./accounts.js")>("./accounts.js");
  return {
    ...actual,
    resolveWhatsAppAuthDir: hoisted.resolveWhatsAppAuthDir,
  };
});

function createRuntime(): RuntimeEnv {
  return {
    error: vi.fn(),
  } as unknown as RuntimeEnv;
}

async function runConfigureWithHarness(params: {
  harness: ReturnType<typeof createQueuedWizardPrompter>;
  cfg?: OpenClawConfig;
  runtime?: RuntimeEnv;
  forceAllowFrom?: boolean;
}) {
  const result = await finalizeWhatsAppSetup({
    cfg: params.cfg ?? ({} as OpenClawConfig),
    accountId: DEFAULT_ACCOUNT_ID,
    forceAllowFrom: params.forceAllowFrom ?? false,
    prompter: params.harness.prompter,
    runtime: params.runtime ?? createRuntime(),
  });
  return {
    accountId: DEFAULT_ACCOUNT_ID,
    cfg: result.cfg,
  };
}

function createSeparatePhoneHarness(params: { selectValues: string[]; textValues?: string[] }) {
  return createQueuedWizardPrompter({
    confirmValues: [false],
    selectValues: params.selectValues,
    textValues: params.textValues,
  });
}

async function runSeparatePhoneFlow(params: { selectValues: string[]; textValues?: string[] }) {
  hoisted.pathExists.mockResolvedValue(true);
  const harness = createSeparatePhoneHarness({
    selectValues: params.selectValues,
    textValues: params.textValues,
  });
  const result = await runConfigureWithHarness({
    harness,
  });
  return { harness, result };
}

describe("whatsapp setup wizard", () => {
  beforeEach(() => {
    hoisted.loginWeb.mockReset();
    hoisted.pathExists.mockReset();
    hoisted.pathExists.mockResolvedValue(false);
    hoisted.resolveWhatsAppAuthDir.mockReset();
    hoisted.resolveWhatsAppAuthDir.mockReturnValue({ authDir: "/tmp/openclaw-whatsapp-test" });
  });

  it("exposes approval auth through approvalCapability only", () => {
    expect(whatsappPlugin.approvalCapability).toBe(whatsappApprovalAuth);
    expect(typeof whatsappPlugin.auth?.login).toBe("function");
    expect("authorizeActorAction" in (whatsappPlugin.auth ?? {})).toBe(false);
    expect("getActionAvailabilityState" in (whatsappPlugin.auth ?? {})).toBe(false);
  });

  it("applies owner allowlist when forceAllowFrom is enabled", async () => {
    const harness = createWhatsAppOwnerAllowlistHarness(createQueuedWizardPrompter);

    const result = await runConfigureWithHarness({
      harness,
      forceAllowFrom: true,
    });

    expect(result.accountId).toBe(DEFAULT_ACCOUNT_ID);
    expect(hoisted.loginWeb).not.toHaveBeenCalled();
    expectWhatsAppOwnerAllowlistSetup(result.cfg, harness);
  });

  it("supports disabled DM policy for separate-phone setup", async () => {
    const { harness, result } = await runSeparatePhoneFlow({
      selectValues: ["separate", "disabled"],
    });

    expectWhatsAppSeparatePhoneDisabledSetup(result.cfg, harness);
  });

  it("normalizes allowFrom entries when list mode is selected", async () => {
    const { result } = await runSeparatePhoneFlow(createWhatsAppAllowlistModeInput());

    expectWhatsAppAllowlistModeSetup(result.cfg);
  });

  it("enables allowlist self-chat mode for personal-phone setup", async () => {
    hoisted.pathExists.mockResolvedValue(true);
    const harness = createWhatsAppPersonalPhoneHarness(createQueuedWizardPrompter);

    const result = await runConfigureWithHarness({
      harness,
    });

    expectWhatsAppPersonalPhoneSetup(result.cfg);
  });

  it("forces wildcard allowFrom for open policy without allowFrom follow-up prompts", async () => {
    hoisted.pathExists.mockResolvedValue(true);
    const harness = createSeparatePhoneHarness({
      selectValues: ["separate", "open"],
    });

    const result = await runConfigureWithHarness({
      harness,
      cfg: createWhatsAppRootAllowFromConfig() as OpenClawConfig,
    });

    expectWhatsAppOpenPolicySetup(result.cfg, harness);
  });

  it("runs WhatsApp login when not linked and user confirms linking", async () => {
    hoisted.pathExists.mockResolvedValue(false);
    const harness = createWhatsAppLinkingHarness(createQueuedWizardPrompter);
    const runtime = createRuntime();

    await runConfigureWithHarness({
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

    await runConfigureWithHarness({
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

    await runConfigureWithHarness({
      harness,
    });

    expectWhatsAppLoginFollowup(harness);
  });

  it("heartbeat readiness uses configured defaultAccount for active listener checks", async () => {
    const result = await checkWhatsAppHeartbeatReady({
      cfg: {
        channels: {
          whatsapp: {
            defaultAccount: "work",
            accounts: {
              work: {
                authDir: "/tmp/work",
              },
            },
          },
        },
      } as OpenClawConfig,
      deps: {
        webAuthExists: async () => true,
        hasActiveWebListener: (accountId?: string) => accountId === "work",
      },
    });

    expect(result).toEqual({ ok: true, reason: "ok" });
  });
});
