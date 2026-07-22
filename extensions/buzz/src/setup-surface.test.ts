import { nip19 } from "nostr-tools";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import type { WizardPrompter } from "openclaw/plugin-sdk/setup";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBuzzSetupWizard } from "./setup-surface.js";

const ROOM_A = "7c4a6d2a-2ed9-4b4e-a5e2-4d705ee9b34c";
const ROOM_B = "940d0c32-4eb7-46d7-9d5b-d975aaef87f7";
const OWNER_PUBKEY = "22".repeat(32);
const GENERATED_KEY = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const AUTH_TAG = '["auth","bot","kind=9","signature"]';

function createPrompter(): WizardPrompter {
  return {
    intro: vi.fn(async () => {}),
    outro: vi.fn(async () => {}),
    note: vi.fn(async () => {}),
    plain: vi.fn(async () => {}),
    progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
    select: vi.fn(async ({ message }) => {
      if (message.includes("identity")) {
        return "generate";
      }
      if (message.includes("access")) {
        return "allowlist";
      }
      if (message.includes("default")) {
        return ROOM_B;
      }
      throw new Error(`Unexpected select prompt: ${message}`);
    }) as WizardPrompter["select"],
    multiselect: vi.fn(async () => [ROOM_A, ROOM_B]) as WizardPrompter["multiselect"],
    text: vi.fn(async ({ message }) => {
      if (message.includes("relay")) {
        return "wss://buzz.example.com";
      }
      if (message.includes("sender")) {
        return OWNER_PUBKEY;
      }
      throw new Error(`Unexpected text prompt: ${message}`);
    }),
    confirm: vi.fn(async ({ message }) => {
      if (message.includes("mentions")) {
        return true;
      }
      if (message.includes("membership")) {
        return true;
      }
      if (message.includes("test message")) {
        return true;
      }
      throw new Error(`Unexpected confirm prompt: ${message}`);
    }),
  };
}

function createRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn() as RuntimeEnv["exit"],
  };
}

describe("Buzz guided setup", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("generates a dedicated plaintext bot key and configures discovered rooms", async () => {
    const discoverRooms = vi.fn(async () => [
      { id: ROOM_A, name: "General", about: "Team room" },
      { id: ROOM_B, name: "Agents" },
    ]);
    const verifyAfterWrite = vi.fn(async () => {});
    const wizard = createBuzzSetupWizard({
      discoverRooms,
      generateSecretKey: () => GENERATED_KEY,
      verifyAfterWrite,
    });
    const prompter = createPrompter();
    const runtime = createRuntime();
    const hooks: Array<{
      run: (ctx: { cfg: OpenClawConfig; runtime: RuntimeEnv }) => void | Promise<void>;
    }> = [];

    const result = await wizard.configure({
      cfg: { channels: { buzz: { authTag: AUTH_TAG } } } as OpenClawConfig,
      runtime,
      prompter,
      options: {
        onPostWriteHook: (hook) => hooks.push(hook),
      },
      accountOverrides: {},
      shouldPromptAccountIds: false,
      forceAllowFrom: false,
    });

    const expectedPrivateKey = nip19.nsecEncode(GENERATED_KEY);
    expect(result.accountId).toBe("default");
    expect(result.cfg.channels?.buzz).toEqual({
      enabled: true,
      relayUrl: "wss://buzz.example.com",
      privateKey: expectedPrivateKey,
      groupPolicy: "allowlist",
      groupAllowFrom: [OWNER_PUBKEY],
      groups: {
        [ROOM_A]: { enabled: true, requireMention: true },
        [ROOM_B]: { enabled: true, requireMention: true },
      },
      defaultTo: ROOM_B,
    });
    expect(discoverRooms).toHaveBeenCalledWith({
      relayUrl: "wss://buzz.example.com",
      privateKey: expectedPrivateKey,
    });
    expect(result.cfg.channels?.buzz?.authTag).toBeUndefined();
    expect(
      vi.mocked(prompter.note).mock.calls.some(([message]) => message.includes(expectedPrivateKey)),
    ).toBe(false);
    expect(prompter.note).toHaveBeenCalledWith(
      expect.stringContaining("buzz-admin add-member"),
      "Send this to your Buzz admin",
    );

    expect(hooks).toHaveLength(1);
    await hooks[0]!.run({ cfg: result.cfg, runtime });
    expect(verifyAfterWrite).toHaveBeenCalledWith({
      cfg: result.cfg,
      accountId: "default",
      target: ROOM_B,
      runtime,
      sendTestMessage: true,
    });
  });

  it("uses the standard SecretRef route for an existing bot key", async () => {
    const secretRef = { source: "env" as const, provider: "default", id: "BUZZ_BOT_KEY" };
    const privateKey = nip19.nsecEncode(GENERATED_KEY);
    type BuzzSetupDependencies = NonNullable<Parameters<typeof createBuzzSetupWizard>[0]>;
    type RunSecretStep = NonNullable<BuzzSetupDependencies["runSecretStep"]>;
    const runSecretStep = vi.fn(async ({ cfg, applySet }: Parameters<RunSecretStep>[0]) => ({
      cfg: await applySet!(cfg, secretRef, privateKey),
      action: "set" as const,
      resolvedValue: privateKey,
    }));
    const wizard = createBuzzSetupWizard({
      discoverRooms: vi.fn(async () => [{ id: ROOM_A, name: "General" }]),
      runSecretStep,
      verifyAfterWrite: vi.fn(async () => {}),
    });
    const prompter = createPrompter();
    vi.mocked(prompter.select).mockImplementation((async ({ message }) => {
      if (message.includes("identity")) {
        return "existing";
      }
      if (message.includes("access")) {
        return "allowlist";
      }
      if (message.includes("default")) {
        return ROOM_A;
      }
      throw new Error(`Unexpected select prompt: ${message}`);
    }) as WizardPrompter["select"]);
    vi.mocked(prompter.multiselect).mockResolvedValue([ROOM_A]);

    const result = await wizard.configure({
      cfg: {} as OpenClawConfig,
      runtime: createRuntime(),
      prompter,
      options: { secretInputMode: "ref" },
      accountOverrides: {},
      shouldPromptAccountIds: false,
      forceAllowFrom: false,
    });

    expect(runSecretStep).toHaveBeenCalledWith(
      expect.objectContaining({ secretInputMode: "ref", providerHint: "buzz" }),
    );
    expect(result.cfg.channels?.buzz?.privateKey).toEqual(secretRef);
  });

  it("disables Buzz when setup pauses for external membership approval", async () => {
    const wizard = createBuzzSetupWizard({ generateSecretKey: () => GENERATED_KEY });
    const prompter = createPrompter();
    vi.mocked(prompter.select).mockImplementation((async ({ message }) => {
      if (message.includes("identity")) {
        return "reuse";
      }
      throw new Error(`Unexpected select prompt: ${message}`);
    }) as WizardPrompter["select"]);
    vi.mocked(prompter.confirm).mockImplementation(async ({ message }) => {
      if (message.includes("membership")) {
        return false;
      }
      throw new Error(`Unexpected confirm prompt: ${message}`);
    });

    const result = await wizard.configure({
      cfg: {
        channels: {
          buzz: {
            enabled: true,
            relayUrl: "wss://old.example.com",
            privateKey: "11".repeat(32),
            groups: { [ROOM_A]: { enabled: true } },
            defaultTo: ROOM_A,
          },
        },
      } as OpenClawConfig,
      runtime: createRuntime(),
      prompter,
      accountOverrides: {},
      shouldPromptAccountIds: false,
      forceAllowFrom: false,
    });

    expect(result.cfg.channels?.buzz?.enabled).toBe(false);
    expect(result.cfg.channels?.buzz?.privateKey).toBe("11".repeat(32));
    expect(
      vi
        .mocked(prompter.select)
        .mock.calls.find(([prompt]) => prompt.message.includes("identity"))?.[0].initialValue,
    ).toBe("reuse");
  });

  it("reports a paused identity as configured but disabled", async () => {
    const wizard = createBuzzSetupWizard();

    await expect(
      wizard.getStatus({
        cfg: {
          channels: {
            buzz: {
              enabled: false,
              relayUrl: "wss://buzz.example.com",
              privateKey: "11".repeat(32),
            },
          },
        } as OpenClawConfig,
        accountOverrides: {},
      }),
    ).resolves.toEqual({
      channel: "buzz",
      configured: true,
      statusLines: ["Buzz: configured but disabled"],
      selectionHint: "configured but disabled",
    });
  });

  it("warns before using an unencrypted remote relay", async () => {
    const wizard = createBuzzSetupWizard({ generateSecretKey: () => GENERATED_KEY });
    const prompter = createPrompter();
    vi.mocked(prompter.text)
      .mockResolvedValueOnce("ws://127.attacker.example")
      .mockResolvedValueOnce("wss://buzz.example.com");
    vi.mocked(prompter.confirm).mockImplementation(async ({ message }) => {
      if (message.includes("unencrypted")) {
        return false;
      }
      if (message.includes("membership")) {
        return false;
      }
      throw new Error(`Unexpected confirm prompt: ${message}`);
    });

    const result = await wizard.configure({
      cfg: {} as OpenClawConfig,
      runtime: createRuntime(),
      prompter,
      accountOverrides: {},
      shouldPromptAccountIds: false,
      forceAllowFrom: false,
    });

    expect(result.cfg.channels?.buzz?.relayUrl).toBe("wss://buzz.example.com");
    expect(prompter.confirm).toHaveBeenCalledWith({
      message: "This remote ws:// relay is unencrypted. Continue anyway?",
      initialValue: false,
    });
  });

  it("reuses an existing identity without a second credential prompt", async () => {
    const runSecretStep = vi.fn();
    const wizard = createBuzzSetupWizard({ runSecretStep });
    const prompter = createPrompter();
    vi.mocked(prompter.select).mockImplementation((async ({ message }) => {
      if (message.includes("identity")) {
        return "reuse";
      }
      throw new Error(`Unexpected select prompt: ${message}`);
    }) as WizardPrompter["select"]);
    vi.mocked(prompter.confirm).mockResolvedValue(false);

    const result = await wizard.configure({
      cfg: {
        channels: {
          buzz: {
            relayUrl: "wss://buzz.example.com",
            privateKey: "11".repeat(32),
          },
        },
      } as OpenClawConfig,
      runtime: createRuntime(),
      prompter,
      accountOverrides: {},
      shouldPromptAccountIds: false,
      forceAllowFrom: false,
    });

    expect(runSecretStep).not.toHaveBeenCalled();
    expect(result.cfg.channels?.buzz?.privateKey).toBe("11".repeat(32));
  });

  it("does not use BUZZ_PRIVATE_KEY when reusing an unresolved SecretRef", async () => {
    vi.stubEnv("BUZZ_PRIVATE_KEY", nip19.nsecEncode(GENERATED_KEY));
    const secretRef = { source: "env" as const, provider: "default", id: "OTHER_BUZZ_KEY" };
    const discoverRooms = vi.fn(async () => [{ id: ROOM_A, name: "General" }]);
    const wizard = createBuzzSetupWizard({ discoverRooms });
    const prompter = createPrompter();
    vi.mocked(prompter.select).mockImplementation((async ({ message }) => {
      if (message.includes("identity")) {
        return "reuse";
      }
      if (message.includes("access")) {
        return "open";
      }
      if (message.includes("default")) {
        return ROOM_A;
      }
      throw new Error(`Unexpected select prompt: ${message}`);
    }) as WizardPrompter["select"]);
    vi.mocked(prompter.text).mockImplementation(async ({ message }) => {
      if (message.includes("relay")) {
        return "wss://buzz.example.com";
      }
      if (message.includes("room UUID")) {
        return ROOM_A;
      }
      throw new Error(`Unexpected text prompt: ${message}`);
    });
    vi.mocked(prompter.confirm).mockImplementation(async ({ message }) => {
      if (message.includes("membership")) {
        return true;
      }
      if (message.includes("mentions") || message.includes("test message")) {
        return false;
      }
      throw new Error(`Unexpected confirm prompt: ${message}`);
    });

    const result = await wizard.configure({
      cfg: {
        channels: {
          buzz: { relayUrl: "wss://buzz.example.com", privateKey: secretRef },
        },
      } as OpenClawConfig,
      runtime: createRuntime(),
      prompter,
      accountOverrides: {},
      shouldPromptAccountIds: false,
      forceAllowFrom: false,
    });

    expect(discoverRooms).not.toHaveBeenCalled();
    expect(result.cfg.channels?.buzz?.privateKey).toEqual(secretRef);
  });

  it("does not use the old key after switching to an unresolved SecretRef", async () => {
    const newSecretRef = { source: "env" as const, provider: "default", id: "NEW_BUZZ_KEY" };
    type BuzzSetupDependencies = NonNullable<Parameters<typeof createBuzzSetupWizard>[0]>;
    type RunSecretStep = NonNullable<BuzzSetupDependencies["runSecretStep"]>;
    const runSecretStep = vi.fn(async ({ cfg, applySet }: Parameters<RunSecretStep>[0]) => ({
      cfg: await applySet!(cfg, newSecretRef, ""),
      action: "set" as const,
    }));
    const discoverRooms = vi.fn(async () => [{ id: ROOM_A, name: "General" }]);
    const wizard = createBuzzSetupWizard({ discoverRooms, runSecretStep });
    const prompter = createPrompter();
    vi.mocked(prompter.select).mockImplementation((async ({ message }) => {
      if (message.includes("identity")) {
        return "existing";
      }
      if (message.includes("access")) {
        return "open";
      }
      if (message.includes("default")) {
        return ROOM_A;
      }
      throw new Error(`Unexpected select prompt: ${message}`);
    }) as WizardPrompter["select"]);
    vi.mocked(prompter.text).mockImplementation(async ({ message }) => {
      if (message.includes("relay")) {
        return "wss://buzz.example.com";
      }
      if (message.includes("room UUID")) {
        return ROOM_A;
      }
      throw new Error(`Unexpected text prompt: ${message}`);
    });

    const result = await wizard.configure({
      cfg: {
        channels: {
          buzz: {
            relayUrl: "wss://buzz.example.com",
            privateKey: "11".repeat(32),
          },
        },
      } as OpenClawConfig,
      runtime: createRuntime(),
      prompter,
      accountOverrides: {},
      shouldPromptAccountIds: false,
      forceAllowFrom: false,
    });

    expect(discoverRooms).not.toHaveBeenCalled();
    expect(result.cfg.channels?.buzz?.privateKey).toEqual(newSecretRef);
  });
});
