import { expect } from "vitest";

type WhatsAppSetupConfig = {
  channels?: {
    whatsapp?: {
      selfChatMode?: boolean;
      dmPolicy?: string;
      allowFrom?: string[];
      accounts?: Record<string, { dmPolicy?: string; allowFrom?: string[]; authDir?: string }>;
    };
  };
};

type WizardPromptHarness = {
  text: (...args: unknown[]) => unknown;
  select: (...args: unknown[]) => unknown;
  note: (...args: unknown[]) => unknown;
};

type QueuedWizardPrompterFactory<T extends WizardPromptHarness> = (params: {
  confirmValues?: boolean[];
  selectValues?: string[];
  textValues?: string[];
}) => T;

export const WHATSAPP_OWNER_NUMBER_INPUT = "+1 (555) 555-0123";
export const WHATSAPP_OWNER_NUMBER = "+15555550123";
export const WHATSAPP_PERSONAL_NUMBER_INPUT = "+1 (555) 111-2222";
export const WHATSAPP_PERSONAL_NUMBER = "+15551112222";
export const WHATSAPP_ACCESS_NOTE_TITLE = "WhatsApp DM access";
export const WHATSAPP_LOGIN_NOTE_TITLE = "WhatsApp";

export function createWhatsAppRootAllowFromConfig(): WhatsAppSetupConfig {
  return {
    channels: {
      whatsapp: {
        allowFrom: [WHATSAPP_OWNER_NUMBER],
      },
    },
  };
}

export function createWhatsAppOwnerAllowlistHarness<T extends WizardPromptHarness>(
  createPrompter: QueuedWizardPrompterFactory<T>,
): T {
  return createPrompter({
    confirmValues: [false],
    textValues: [WHATSAPP_OWNER_NUMBER_INPUT],
  });
}

export function createWhatsAppPersonalPhoneHarness<T extends WizardPromptHarness>(
  createPrompter: QueuedWizardPrompterFactory<T>,
): T {
  return createPrompter({
    confirmValues: [false],
    selectValues: ["personal"],
    textValues: [WHATSAPP_PERSONAL_NUMBER_INPUT],
  });
}

export function createWhatsAppLinkingHarness<T extends WizardPromptHarness>(
  createPrompter: QueuedWizardPrompterFactory<T>,
): T {
  return createPrompter({
    confirmValues: [true],
    selectValues: ["separate", "disabled"],
  });
}

export function createWhatsAppWorkAccountConfig(
  params: {
    defaultAccount?: string;
  } = {},
): WhatsAppSetupConfig {
  return {
    channels: {
      whatsapp: {
        ...(params.defaultAccount ? { defaultAccount: params.defaultAccount } : {}),
        dmPolicy: "disabled",
        allowFrom: [WHATSAPP_OWNER_NUMBER],
        accounts: {
          work: {
            authDir: "/tmp/work",
          },
        },
      },
    },
  };
}

export function createWhatsAppAllowlistModeInput(): {
  selectValues: string[];
  textValues: string[];
} {
  return {
    selectValues: ["separate", "allowlist", "list"],
    textValues: [`${WHATSAPP_OWNER_NUMBER_INPUT}, ${WHATSAPP_OWNER_NUMBER}, *`],
  };
}

export function expectWhatsAppDmAccess(
  cfg: WhatsAppSetupConfig,
  expected: {
    selfChatMode: boolean;
    dmPolicy: string;
    allowFrom?: string[];
  },
): void {
  expect(cfg.channels?.whatsapp?.selfChatMode).toBe(expected.selfChatMode);
  expect(cfg.channels?.whatsapp?.dmPolicy).toBe(expected.dmPolicy);
  if ("allowFrom" in expected) {
    expect(cfg.channels?.whatsapp?.allowFrom).toEqual(expected.allowFrom);
  } else {
    expect(cfg.channels?.whatsapp?.allowFrom).toBeUndefined();
  }
}

export function expectWhatsAppWorkAccountOpenAccess(cfg: WhatsAppSetupConfig): void {
  expect(cfg.channels?.whatsapp?.dmPolicy).toBe("disabled");
  expect(cfg.channels?.whatsapp?.allowFrom).toEqual([WHATSAPP_OWNER_NUMBER]);
  expect(cfg.channels?.whatsapp?.accounts?.work?.dmPolicy).toBe("open");
  expect(cfg.channels?.whatsapp?.accounts?.work?.allowFrom).toEqual(["*", WHATSAPP_OWNER_NUMBER]);
}

export function expectWhatsAppOwnerNumberPrompt(harness: WizardPromptHarness): void {
  expect(harness.text).toHaveBeenCalledWith(
    expect.objectContaining({
      message: "Your personal WhatsApp number (the phone you will message from)",
    }),
  );
}

export function expectWhatsAppOwnerAllowlistSetup(
  cfg: WhatsAppSetupConfig,
  harness: WizardPromptHarness,
): void {
  expectWhatsAppDmAccess(cfg, {
    selfChatMode: true,
    dmPolicy: "allowlist",
    allowFrom: [WHATSAPP_OWNER_NUMBER],
  });
  expectWhatsAppOwnerNumberPrompt(harness);
}

export function expectWhatsAppSeparatePhoneDisabledSetup(
  cfg: WhatsAppSetupConfig,
  harness: WizardPromptHarness,
): void {
  expectWhatsAppDmAccess(cfg, {
    selfChatMode: false,
    dmPolicy: "disabled",
  });
  expect(harness.text).not.toHaveBeenCalled();
}

export function expectWhatsAppAllowlistModeSetup(cfg: WhatsAppSetupConfig): void {
  expectWhatsAppDmAccess(cfg, {
    selfChatMode: false,
    dmPolicy: "allowlist",
    allowFrom: [WHATSAPP_OWNER_NUMBER, "*"],
  });
}

export function expectWhatsAppPersonalPhoneSetup(cfg: WhatsAppSetupConfig): void {
  expectWhatsAppDmAccess(cfg, {
    selfChatMode: true,
    dmPolicy: "allowlist",
    allowFrom: [WHATSAPP_PERSONAL_NUMBER],
  });
}

export function expectWhatsAppOpenPolicySetup(
  cfg: WhatsAppSetupConfig,
  harness: WizardPromptHarness,
): void {
  expectWhatsAppDmAccess(cfg, {
    selfChatMode: false,
    dmPolicy: "open",
    allowFrom: ["*", WHATSAPP_OWNER_NUMBER],
  });
  expect(harness.select).toHaveBeenCalledTimes(2);
  expect(harness.text).not.toHaveBeenCalled();
}

export function expectNoWhatsAppLoginFollowup(harness: WizardPromptHarness): void {
  expect(harness.note).not.toHaveBeenCalledWith(
    expect.stringContaining("openclaw channels login"),
    WHATSAPP_LOGIN_NOTE_TITLE,
  );
}

export function expectWhatsAppLoginFollowup(harness: WizardPromptHarness): void {
  expect(harness.note).toHaveBeenCalledWith(
    expect.stringContaining("openclaw channels login"),
    WHATSAPP_LOGIN_NOTE_TITLE,
  );
}

export function expectWhatsAppWorkAccountAccessNote(harness: WizardPromptHarness): void {
  expect(harness.note).toHaveBeenCalledWith(
    expect.stringContaining(
      "`channels.whatsapp.accounts.work.dmPolicy` + `channels.whatsapp.accounts.work.allowFrom`",
    ),
    WHATSAPP_ACCESS_NOTE_TITLE,
  );
}

export function expectWhatsAppDefaultAccountAccessNote(harness: WizardPromptHarness): void {
  expect(harness.note).toHaveBeenCalledWith(
    expect.stringContaining(
      "`channels.whatsapp.accounts.default.dmPolicy` + `channels.whatsapp.accounts.default.allowFrom`",
    ),
    WHATSAPP_ACCESS_NOTE_TITLE,
  );
}
