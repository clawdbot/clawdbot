import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { nip19 } from "nostr-tools";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import type { SecretInput, WizardPrompter } from "openclaw/plugin-sdk/setup";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBuzzSetupWizard } from "./setup-surface.js";

const ROOM_A = "7c4a6d2a-2ed9-4b4e-a5e2-4d705ee9b34c";
const ROOM_B = "940d0c32-4eb7-46d7-9d5b-d975aaef87f7";
const GENERATED_KEY = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const AUTH_TAG = '["auth","bot","kind=9","signature"]';
const secretFixtureRoots: string[] = [];

function createCredentialConfig(
  accountId: "default" | "ada",
  privateKey: SecretInput,
  authTag: SecretInput,
) {
  const healthyAccount = {
    enabled: true,
    name: "Healthy bot",
    relayUrl: "wss://healthy.example.com",
    privateKey: "11".repeat(32),
    authTag: '["auth","healthy","kind=9","signature"]',
    groups: { [ROOM_B]: { requireMention: true } },
    defaultTo: ROOM_B,
  };
  const selectedAccount = {
    enabled: true,
    name: "Selected bot",
    relayUrl: "wss://selected.example.com",
    privateKey,
    authTag,
    groupPolicy: "allowlist",
    groupAllowFrom: [],
    groups: { [ROOM_A]: { requireMention: false, groupAllowFrom: [] } },
  };
  const cfg: OpenClawConfig = {
    channels: {
      buzz:
        accountId === "default"
          ? { ...selectedAccount, accounts: { ada: healthyAccount } }
          : { ...healthyAccount, accounts: { ada: selectedAccount } },
    },
  };
  return { cfg, healthyAccount };
}

async function createStoredCredentials(source: "env" | "file"): Promise<{
  privateKey: SecretInput;
  authTag: SecretInput;
  secrets?: OpenClawConfig["secrets"];
}> {
  const privateKey = nip19.nsecEncode(GENERATED_KEY);
  if (source === "env") {
    vi.stubEnv("BUZZ_SETUP_PRIVATE_KEY", privateKey);
    vi.stubEnv("BUZZ_SETUP_AUTH_TAG", AUTH_TAG);
    return {
      privateKey: { source, provider: "default", id: "BUZZ_SETUP_PRIVATE_KEY" },
      authTag: { source, provider: "default", id: "BUZZ_SETUP_AUTH_TAG" },
    };
  }
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "buzz-setup-ref-")));
  secretFixtureRoots.push(root);
  const filePath = path.join(root, "credentials.json");
  await fs.writeFile(filePath, JSON.stringify({ privateKey, authTag: AUTH_TAG }), { mode: 0o600 });
  return {
    privateKey: { source, provider: "buzzsetup", id: "/privateKey" },
    authTag: { source, provider: "buzzsetup", id: "/authTag" },
    secrets: { providers: { buzzsetup: { source, path: filePath, mode: "json" } } },
  };
}

function createPrompter(): WizardPrompter {
  return {
    intro: vi.fn(async () => {}),
    outro: vi.fn(async () => {}),
    note: vi.fn(async () => {}),
    plain: vi.fn(async () => {}),
    progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
    select: vi.fn(async ({ message }) => {
      if (message.includes("room access")) {
        return "retry";
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
      throw new Error(`Unexpected text prompt: ${message}`);
    }),
    confirm: vi.fn(async ({ message }) => {
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
  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(secretFixtureRoots.splice(0).map((root) => fs.rm(root, { recursive: true })));
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
      groupPolicy: "open",
      groupAllowFrom: undefined,
      groups: {
        [ROOM_A]: { enabled: true, requireMention: false },
        [ROOM_B]: { enabled: true, requireMention: false },
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
    expect(hooks).toHaveLength(1);
    await hooks[0]!.run({ cfg: result.cfg, runtime });
    expect(verifyAfterWrite).toHaveBeenCalledWith({
      accountId: "default",
      target: ROOM_B,
      runtime,
    });
  });

  it("keeps generated identities stable per account across wizard replay", async () => {
    vi.stubEnv("BUZZ_PRIVATE_KEY", "33".repeat(32));
    vi.stubEnv("BUZZ_AUTH_TAG", "ambient-auth-must-not-be-used");
    const otherKey = Uint8Array.from({ length: 32 }, () => 7);
    const generate = vi.fn().mockReturnValueOnce(GENERATED_KEY).mockReturnValueOnce(otherKey);
    const discoverRooms = vi.fn(async () => [{ id: ROOM_B, name: "Agents" }]);
    const wizard = createBuzzSetupWizard({ generateSecretKey: generate, discoverRooms });
    const prompter = createPrompter();
    const cfg = {
      channels: {
        buzz: {
          enabled: false,
          relayUrl: "wss://root.example.com",
          privateKey: "11".repeat(32),
          authTag: AUTH_TAG,
          groups: { [ROOM_A]: {} },
        },
      },
    } as OpenClawConfig;
    const configure = (accountId: string) =>
      wizard.configure({
        cfg,
        runtime: createRuntime(),
        prompter,
        accountOverrides: { buzz: accountId },
        shouldPromptAccountIds: false,
        forceAllowFrom: false,
      });
    const ada = await configure("ada");
    const grace = await configure("grace");
    const replay = await configure("ada");
    expect(generate).toHaveBeenCalledTimes(2);
    expect(ada.accountId).toBe("ada");
    expect(ada.cfg.channels?.buzz?.accounts?.ada?.privateKey).toBe(nip19.nsecEncode(GENERATED_KEY));
    expect(grace.cfg.channels?.buzz?.accounts?.grace?.privateKey).toBe(nip19.nsecEncode(otherKey));
    expect(replay.cfg).toEqual(ada.cfg);
    const { accounts: _accounts, ...root } = ada.cfg.channels!.buzz!;
    expect(root).toEqual(cfg.channels!.buzz);
    expect(ada.cfg.channels?.buzz?.accounts?.ada?.groups).toEqual({
      [ROOM_B]: { enabled: true, requireMention: false },
    });
    expect(discoverRooms).toHaveBeenCalledWith({
      relayUrl: "wss://buzz.example.com",
      privateKey: nip19.nsecEncode(GENERATED_KEY),
    });
  });

  it("selects a new guided account without borrowing the root identity or rooms", async () => {
    const root = {
      name: "Root",
      relayUrl: "wss://root.example.com",
      privateKey: "11".repeat(32),
      groups: { [ROOM_A]: {} },
    };
    const discoverRooms = vi.fn(async () => [{ id: ROOM_B, name: "Agents" }]);
    const wizard = createBuzzSetupWizard({ discoverRooms, generateSecretKey: () => GENERATED_KEY });
    const prompter = createPrompter();
    vi.mocked(prompter.select).mockResolvedValueOnce("__new__");
    vi.mocked(prompter.text)
      .mockResolvedValueOnce("ada")
      .mockResolvedValueOnce("wss://ada.example.com");
    const result = await wizard.configure({
      cfg: { channels: { buzz: root } } as OpenClawConfig,
      runtime: createRuntime(),
      prompter,
      accountOverrides: {},
      shouldPromptAccountIds: true,
      forceAllowFrom: false,
    });
    expect(result.accountId).toBe("ada");
    expect(result.cfg.channels?.buzz).toEqual({
      ...root,
      accounts: {
        ada: {
          enabled: true,
          relayUrl: "wss://ada.example.com",
          privateKey: nip19.nsecEncode(GENERATED_KEY),
          groupPolicy: "open",
          groupAllowFrom: undefined,
          groups: { [ROOM_B]: { enabled: true, requireMention: false } },
          defaultTo: ROOM_B,
        },
      },
    });
    expect(discoverRooms).toHaveBeenCalledWith({
      relayUrl: "wss://ada.example.com",
      privateKey: nip19.nsecEncode(GENERATED_KEY),
    });
  });

  it("uses the standard SecretRef route when entering a bot key", async () => {
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

  it("falls back to retry without rotating the identity when automatic discovery expires", async () => {
    const discoverRooms = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: ROOM_A, name: "General" }]);
    const wizard = createBuzzSetupWizard({
      discoverRooms,
      generateSecretKey: () => GENERATED_KEY,
      waitForRoomAccess: vi.fn(async () => []),
    });
    const prompter = createPrompter();

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

    expect(result.cfg.channels?.buzz?.enabled).toBe(true);
    expect(result.cfg.channels?.buzz?.privateKey).toBe("11".repeat(32));
    expect(result.completion).toBeUndefined();
    expect(result.accountId).toBe("default");
    expect(discoverRooms).toHaveBeenCalledTimes(2);
    expect(discoverRooms.mock.calls[0]?.[0].privateKey).toBe(
      discoverRooms.mock.calls[1]?.[0].privateKey,
    );
    expect(prompter.note).toHaveBeenCalledWith(
      expect.stringContaining("Local `just dev` needs no separate community-member step"),
      "Buzz room access required",
    );
    expect(prompter.text).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("room UUID") }),
    );
    expect(prompter.select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Buzz room access is not ready",
        initialValue: "retry",
      }),
    );
  });

  it.each(["default", "ada"] as const)(
    "keeps %s setup open after an empty room selection",
    async (accountId) => {
      const { cfg } = createCredentialConfig(accountId, "22".repeat(32), AUTH_TAG);
      const before = structuredClone(cfg);
      const discoverRooms = vi.fn(async () => [
        { id: ROOM_A, name: "General" },
        { id: ROOM_B, name: "Agents" },
      ]);
      const prompter = createPrompter();
      vi.mocked(prompter.multiselect).mockResolvedValueOnce([]).mockResolvedValueOnce([ROOM_A]);
      const result = await createBuzzSetupWizard({ discoverRooms }).configure({
        cfg,
        runtime: createRuntime(),
        prompter,
        accountOverrides: { buzz: accountId },
        shouldPromptAccountIds: false,
        forceAllowFrom: false,
      });
      expect(result.accountId).toBe(accountId);
      expect(result.completion).toBeUndefined();
      expect(prompter.multiselect).toHaveBeenCalledTimes(2);
      expect(prompter.note).toHaveBeenCalledWith(
        expect.stringContaining("at least one"),
        "Buzz room selection required",
      );
      expect(discoverRooms).toHaveBeenCalledOnce();
      expect(result.cfg.channels?.buzz?.enabled).toBe(true);
      expect(result.cfg.channels?.buzz?.accounts?.ada?.enabled).toBe(true);
      expect(cfg).toEqual(before);
    },
  );

  it("reports a configured identity as disabled", async () => {
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
    const wizard = createBuzzSetupWizard({
      discoverRooms: vi.fn(async () => [{ id: ROOM_A, name: "General" }]),
      generateSecretKey: () => GENERATED_KEY,
    });
    const prompter = createPrompter();
    vi.mocked(prompter.text).mockResolvedValueOnce("wss://buzz.example.com");
    vi.mocked(prompter.confirm).mockImplementation(async ({ message }) => {
      if (message.includes("unencrypted")) {
        return false;
      }
      throw new Error(`Unexpected confirm prompt: ${message}`);
    });

    const result = await wizard.configure({
      cfg: {
        channels: { buzz: { relayUrl: "ws://127.attacker.example" } },
      } as OpenClawConfig,
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
    const wizard = createBuzzSetupWizard({
      discoverRooms: vi.fn(async () => [{ id: ROOM_A, name: "General" }]),
      runSecretStep,
    });
    const prompter = createPrompter();

    const result = await wizard.configure({
      cfg: {
        channels: {
          defaults: { groupPolicy: "disabled" },
          buzz: {
            relayUrl: "wss://buzz.example.com",
            privateKey: "11".repeat(32),
            groups: {
              [ROOM_A]: {
                enabled: false,
                requireMention: false,
                groupPolicy: "allowlist",
                groupAllowFrom: [],
              },
            },
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
    expect(result.cfg.channels?.buzz?.groupPolicy).toBeUndefined();
    expect(result.cfg.channels?.buzz?.groups?.[ROOM_A]).toEqual({
      enabled: false,
      requireMention: false,
      groupPolicy: "allowlist",
      groupAllowFrom: [],
    });
    expect(result.cfg.channels?.defaults?.groupPolicy).toBe("disabled");
  });

  it.each([
    { accountId: "default", source: "env", plaintextPrivateKey: false },
    { accountId: "ada", source: "env", plaintextPrivateKey: false },
    { accountId: "default", source: "file", plaintextPrivateKey: false },
    { accountId: "ada", source: "file", plaintextPrivateKey: false },
    { accountId: "ada", source: "env", plaintextPrivateKey: true },
  ] as const)(
    "reuses $accountId $source refs with plaintextPrivateKey=$plaintextPrivateKey without replacing authored credentials",
    async ({ accountId, source, plaintextPrivateKey }) => {
      vi.stubEnv("BUZZ_PRIVATE_KEY", "33".repeat(32));
      vi.stubEnv("BUZZ_AUTH_TAG", "ambient-auth-must-not-be-used");
      const stored = await createStoredCredentials(source);
      const privateKey = nip19.nsecEncode(GENERATED_KEY);
      const configuredKey = plaintextPrivateKey ? privateKey : stored.privateKey;
      const { cfg, healthyAccount } = createCredentialConfig(
        accountId,
        configuredKey,
        stored.authTag,
      );
      cfg.secrets = stored.secrets;
      const before = structuredClone(cfg);
      const discoverRooms = vi.fn(async () => [{ id: ROOM_A, name: "General" }]);
      const generate = vi.fn(() => GENERATED_KEY);
      const runSecretStep = vi.fn();
      const wizard = createBuzzSetupWizard({
        discoverRooms,
        generateSecretKey: generate,
        runSecretStep,
      });
      const prompter = createPrompter();

      const result = await wizard.configure({
        cfg,
        runtime: createRuntime(),
        prompter,
        accountOverrides: { buzz: accountId },
        shouldPromptAccountIds: false,
        forceAllowFrom: false,
      });

      expect(result.accountId).toBe(accountId);
      expect(result.completion).toBeUndefined();
      expect(discoverRooms).toHaveBeenCalledWith({
        relayUrl: "wss://selected.example.com",
        privateKey,
        authTag: AUTH_TAG,
      });
      const { accounts, ...root } = result.cfg.channels!.buzz!;
      const selected = accountId === "default" ? root : accounts.ada;
      expect(accountId === "default" ? accounts.ada : root).toEqual(healthyAccount);
      expect(selected).toMatchObject({
        enabled: true,
        privateKey: configuredKey,
        authTag: stored.authTag,
        groupPolicy: "allowlist",
        groupAllowFrom: [],
        groups: { [ROOM_A]: { enabled: true, requireMention: false, groupAllowFrom: [] } },
        defaultTo: ROOM_A,
      });
      expect(cfg).toEqual(before);
      expect(generate).not.toHaveBeenCalled();
      expect(runSecretStep).not.toHaveBeenCalled();
      expect(JSON.stringify(vi.mocked(prompter.note).mock.calls)).not.toContain(privateKey);
      expect(JSON.stringify(vi.mocked(prompter.note).mock.calls)).not.toContain(AUTH_TAG);
    },
  );

  it.each([
    { accountId: "default", field: "privateKey" },
    { accountId: "ada", field: "privateKey" },
    { accountId: "default", field: "authTag" },
    { accountId: "ada", field: "authTag" },
  ] as const)(
    "rejects unavailable $accountId $field refs without a configuration result or credential fallback",
    async ({ accountId, field }) => {
      vi.stubEnv("BUZZ_PRIVATE_KEY", "33".repeat(32));
      vi.stubEnv("BUZZ_AUTH_TAG", "ambient-auth-must-not-be-used");
      vi.stubEnv("BUZZ_SETUP_MISSING", undefined);
      const secretRef = { source: "env", provider: "default", id: "BUZZ_SETUP_MISSING" } as const;
      const privateKey = nip19.nsecEncode(GENERATED_KEY);
      const { cfg } = createCredentialConfig(
        accountId,
        field === "privateKey" ? secretRef : privateKey,
        field === "authTag" ? secretRef : AUTH_TAG,
      );
      const before = structuredClone(cfg);
      const discoverRooms = vi.fn(async () => [{ id: ROOM_A, name: "General" }]);
      const waitForRoomAccess = vi.fn(async () => []);
      const generate = vi.fn(() => GENERATED_KEY);
      const runSecretStep = vi.fn();
      const onPostWriteHook = vi.fn();
      const wizard = createBuzzSetupWizard({
        discoverRooms,
        waitForRoomAccess,
        generateSecretKey: generate,
        runSecretStep,
      });

      await expect(
        wizard.configure({
          cfg,
          runtime: createRuntime(),
          prompter: createPrompter(),
          options: { onPostWriteHook },
          accountOverrides: { buzz: accountId },
          shouldPromptAccountIds: false,
          forceAllowFrom: false,
        }),
      ).rejects.toThrow(/configured|SecretRef/i);
      expect(cfg).toEqual(before);
      expect(cfg.channels?.buzz?.enabled).toBe(true);
      expect(cfg.channels?.buzz?.accounts?.ada?.enabled).toBe(true);
      expect(discoverRooms).not.toHaveBeenCalled();
      expect(waitForRoomAccess).not.toHaveBeenCalled();
      expect(generate).not.toHaveBeenCalled();
      expect(runSecretStep).not.toHaveBeenCalled();
      expect(onPostWriteHook).not.toHaveBeenCalled();
    },
  );

  it("does not replace an existing identity during SecretRef setup", async () => {
    const runSecretStep = vi.fn();
    const discoverRooms = vi.fn(async () => [{ id: ROOM_A, name: "General" }]);
    const wizard = createBuzzSetupWizard({
      discoverRooms,
      runSecretStep,
    });
    const prompter = createPrompter();

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
      options: { secretInputMode: "ref" },
      accountOverrides: {},
      shouldPromptAccountIds: false,
      forceAllowFrom: false,
    });

    expect(runSecretStep).not.toHaveBeenCalled();
    expect(discoverRooms).toHaveBeenCalledWith({
      relayUrl: "wss://buzz.example.com",
      privateKey: "11".repeat(32),
    });
    expect(result.cfg.channels?.buzz?.privateKey).toBe("11".repeat(32));
    expect(result.cfg.channels?.buzz?.enabled).toBe(true);
    expect(result.completion).toBeUndefined();
  });

  it("waits for authenticated room access without rotating the generated identity", async () => {
    const discoverRooms = vi.fn(async () => []);
    const waitForRoomAccess = vi.fn(async () => [{ id: ROOM_A, name: "General" }]);
    const wizard = createBuzzSetupWizard({
      discoverRooms,
      generateSecretKey: () => GENERATED_KEY,
      waitForRoomAccess,
      verifyAfterWrite: vi.fn(async () => {}),
    });
    const prompter = createPrompter();
    vi.mocked(prompter.multiselect).mockResolvedValue([ROOM_A]);

    const result = await wizard.configure({
      cfg: {} as OpenClawConfig,
      runtime: createRuntime(),
      prompter,
      accountOverrides: {},
      shouldPromptAccountIds: false,
      forceAllowFrom: false,
    });

    expect(discoverRooms).toHaveBeenCalledOnce();
    const expectedPrivateKey = nip19.nsecEncode(GENERATED_KEY);
    expect(discoverRooms).toHaveBeenCalledWith(
      expect.objectContaining({ privateKey: expectedPrivateKey }),
    );
    expect(waitForRoomAccess).toHaveBeenCalledWith(
      expect.objectContaining({ privateKey: expectedPrivateKey }),
    );
    expect(result.cfg.channels?.buzz?.enabled).toBe(true);
    expect(result.cfg.channels?.buzz?.defaultTo).toBe(ROOM_A);
  });
});
