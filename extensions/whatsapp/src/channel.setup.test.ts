import { createQueuedWizardPrompter } from "openclaw/plugin-sdk/plugin-test-runtime";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/routing";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WHATSAPP_AUTH_UNSTABLE_CODE } from "./auth-store.js";
import { whatsappSetupPlugin } from "./channel.setup.js";
import { checkWhatsAppHeartbeatReady } from "./heartbeat.js";
import type { OpenClawConfig } from "./runtime-api.js";
import { finalizeWhatsAppSetup } from "./setup-finalize.js";
import {
  createWhatsAppAllowlistModeInput,
  expectWhatsAppDefaultAccountAccessNote,
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
  readWebAuthState: vi.fn(async (): Promise<"linked" | "not-linked" | "unstable"> => "not-linked"),
  readWebAuthExistsForDecision: vi.fn(
    async (): Promise<{ outcome: "stable"; exists: boolean } | { outcome: "unstable" }> => ({
      outcome: "stable",
      exists: false,
    }),
  ),
  resolveWhatsAppAuthDir: vi.fn(() => ({
    authDir: "/tmp/openclaw-whatsapp-test",
  })),
}));

function splitSetupEntriesForMock(raw: string): string[] {
  const entries: string[] = [];
  for (const entry of raw.split(",")) {
    const normalized = entry.trim();
    if (normalized.length > 0) {
      entries.push(normalized);
    }
  }
  return entries;
}

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
    normalizeAllowFromEntries: (entries: string[], normalize: (value: string) => string) => {
      const normalized = new Set<string>();
      for (const entry of entries) {
        const value = entry === "*" ? "*" : normalize(entry);
        if (value) {
          normalized.add(value);
        }
      }
      return [...normalized];
    },
    normalizeE164,
    pathExists: hoisted.pathExists,
    splitSetupEntries: splitSetupEntriesForMock,
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

vi.mock("./auth-store.js", async () => {
  const actual = await vi.importActual<typeof import("./auth-store.js")>("./auth-store.js");
  return {
    ...actual,
    readWebAuthState: hoisted.readWebAuthState,
    readWebAuthExistsForDecision: hoisted.readWebAuthExistsForDecision,
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
    hoisted.readWebAuthState.mockReset();
    hoisted.readWebAuthState.mockResolvedValue("not-linked");
    hoisted.readWebAuthExistsForDecision.mockReset();
    hoisted.readWebAuthExistsForDecision.mockResolvedValue({
      outcome: "stable",
      exists: false,
    });
    hoisted.resolveWhatsAppAuthDir.mockReset();
    hoisted.resolveWhatsAppAuthDir.mockReturnValue({ authDir: "/tmp/openclaw-whatsapp-test" });
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

  it("rejects invalid owner numbers during prompt validation", async () => {
    const harness = createWhatsAppOwnerAllowlistHarness(createQueuedWizardPrompter);

    await runConfigureWithHarness({
      harness,
      forceAllowFrom: true,
    });

    const prompt = harness.text.mock.calls.at(0)?.[0] as
      | { validate?: (value: string) => string | undefined }
      | undefined;
    if (!prompt?.validate) {
      throw new Error("expected owner number validator");
    }
    expect(prompt.validate("abc")).toBe("Invalid number: abc");
    expect(prompt.validate("whatsapp:")).toBe("Invalid number: whatsapp:");
    expect(prompt.validate("+1 (555) 555-0123")).toBeUndefined();
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

  it("throws a user-facing error instead of crashing when allowlist input is undefined", async () => {
    const harness = createSeparatePhoneHarness({
      selectValues: ["separate", "allowlist", "list"],
    });
    harness.text.mockResolvedValueOnce(undefined as never);

    await expect(
      runConfigureWithHarness({
        harness,
      }),
    ).rejects.toThrow("Invalid WhatsApp allowFrom list");
  });

  it("enables allowlist self-chat mode for personal-phone setup", async () => {
    hoisted.pathExists.mockResolvedValue(true);
    const harness = createWhatsAppPersonalPhoneHarness(createQueuedWizardPrompter);

    const result = await runConfigureWithHarness({
      harness,
    });

    expectWhatsAppPersonalPhoneSetup(result.cfg);
  });

  it("throws a user-facing error instead of crashing when personal-phone input is undefined", async () => {
    hoisted.pathExists.mockResolvedValue(true);
    const harness = createWhatsAppPersonalPhoneHarness(createQueuedWizardPrompter);
    harness.text.mockResolvedValueOnce(undefined as never);

    await expect(
      runConfigureWithHarness({
        harness,
      }),
    ).rejects.toThrow("Invalid WhatsApp owner number");
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

  it("surfaces accounts.default group warning paths for named accounts", () => {
    const warnings = whatsappSetupPlugin.security?.collectWarnings?.({
      cfg: {
        channels: {
          whatsapp: {
            accounts: {
              default: {
                groupPolicy: "open",
              },
              work: {
                authDir: "/tmp/work",
              },
            },
          },
        },
      } as OpenClawConfig,
      accountId: "work",
      account: {
        accountId: "work",
        enabled: true,
        sendReadReceipts: true,
        authDir: "/tmp/work",
        isLegacyAuthDir: false,
        groupPolicy: "open",
      },
    });

    expect(warnings).toEqual([
      '- WhatsApp groups: groupPolicy="open" with no channels.whatsapp.accounts.default.groups allowlist; any group can add + ping (mention-gated). Set channels.whatsapp.accounts.default.groupPolicy="allowlist" + channels.whatsapp.accounts.default.groupAllowFrom or configure channels.whatsapp.accounts.default.groups.',
    ]);
  });

  it("surfaces mixed-case default-account group warning paths for named accounts", () => {
    const warnings = whatsappSetupPlugin.security?.collectWarnings?.({
      cfg: {
        channels: {
          whatsapp: {
            accounts: {
              Default: {
                groupPolicy: "open",
              },
              work: {
                authDir: "/tmp/work",
              },
            },
          },
        },
      } as OpenClawConfig,
      accountId: "work",
      account: {
        accountId: "work",
        enabled: true,
        sendReadReceipts: true,
        authDir: "/tmp/work",
        isLegacyAuthDir: false,
        groupPolicy: "open",
      },
    });

    expect(warnings).toEqual([
      '- WhatsApp groups: groupPolicy="open" with no channels.whatsapp.accounts.Default.groups allowlist; any group can add + ping (mention-gated). Set channels.whatsapp.accounts.Default.groupPolicy="allowlist" + channels.whatsapp.accounts.Default.groupAllowFrom or configure channels.whatsapp.accounts.Default.groups.',
    ]);
  });

  it("writes default-account DM config into accounts.default for multi-account setups", async () => {
    hoisted.pathExists.mockResolvedValue(true);
    const harness = createSeparatePhoneHarness({
      selectValues: ["separate", "open"],
    });

    const result = await runConfigureWithHarness({
      harness,
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
    });

    expect(result.cfg.channels?.whatsapp?.dmPolicy).toBeUndefined();
    expect(result.cfg.channels?.whatsapp?.allowFrom).toBeUndefined();
    expect(result.cfg.channels?.whatsapp?.accounts?.default?.dmPolicy).toBe("open");
    expect(result.cfg.channels?.whatsapp?.accounts?.default?.allowFrom).toEqual(["*"]);
    expectWhatsAppDefaultAccountAccessNote(harness);
  });

  it("updates an existing mixed-case default-account key during setup", async () => {
    hoisted.pathExists.mockResolvedValue(true);
    const harness = createSeparatePhoneHarness({
      selectValues: ["separate", "open"],
    });

    const result = await runConfigureWithHarness({
      harness,
      cfg: {
        channels: {
          whatsapp: {
            accounts: {
              Default: {
                authDir: "/tmp/default-auth",
              },
              work: {
                authDir: "/tmp/work",
              },
            },
          },
        },
      } as OpenClawConfig,
    });

    expect(result.cfg.channels?.whatsapp?.accounts?.Default?.authDir).toBe("/tmp/default-auth");
    expect(result.cfg.channels?.whatsapp?.accounts?.Default?.dmPolicy).toBe("open");
    expect(result.cfg.channels?.whatsapp?.accounts?.Default?.allowFrom).toEqual(["*"]);
    expect(result.cfg.channels?.whatsapp?.accounts?.default).toBeUndefined();
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
        readWebAuthExistsForDecision: async () => ({
          outcome: "stable" as const,
          exists: true,
        }),
        hasActiveWebListener: (accountId?: string) => accountId === "work",
      },
    });

    expect(result).toEqual({ ok: true, reason: "ok" });
  });

  it("heartbeat readiness returns unstable when auth state timing is unresolved", async () => {
    const result = await checkWhatsAppHeartbeatReady({
      cfg: {
        channels: {
          whatsapp: {
            accounts: {
              default: {
                authDir: "/tmp/default",
              },
            },
          },
        },
      } as OpenClawConfig,
      deps: {
        readWebAuthExistsForDecision: async () => ({ outcome: "unstable" as const }),
        hasActiveWebListener: () => true,
      },
    });

    expect(result).toEqual({ ok: false, reason: WHATSAPP_AUTH_UNSTABLE_CODE });
  });

  it("does not treat unstable auth as configured in generic plugin config checks", async () => {
    hoisted.readWebAuthState.mockResolvedValueOnce("unstable");

    await expect(
      whatsappSetupPlugin.config.isConfigured?.(
        {
          authDir: "/tmp/work",
        } as never,
        {} as never,
      ),
    ).resolves.toBe(false);
  });
});
