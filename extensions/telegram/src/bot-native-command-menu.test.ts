// Telegram tests cover bot native command menu plugin behavior.
import { describe, expect, it, vi } from "vitest";
import {
  buildCappedTelegramMenuCommands,
  buildPluginTelegramMenuCommands,
  syncTelegramMenuCommands,
} from "./bot-native-command-menu.js";

const TELEGRAM_COMMAND_TEXT_LIMIT = 5700;

function waitForTelegramMenu(assertion: () => void) {
  return vi.waitFor(assertion, { interval: 1 });
}

type SyncMenuOptions = {
  deleteMyCommands: ReturnType<typeof vi.fn>;
  setMyCommands: ReturnType<typeof vi.fn>;
  commandsToRegister: Parameters<typeof syncTelegramMenuCommands>[0]["commandsToRegister"];
  accountId: string;
  botIdentity: string;
  runtimeLog?: ReturnType<typeof vi.fn>;
  runtimeError?: ReturnType<typeof vi.fn>;
};

function syncMenuCommandsWithMocks(options: SyncMenuOptions): void {
  syncTelegramMenuCommands({
    bot: {
      api: { deleteMyCommands: options.deleteMyCommands, setMyCommands: options.setMyCommands },
    } as unknown as Parameters<typeof syncTelegramMenuCommands>[0]["bot"],
    runtime: {
      log: options.runtimeLog ?? vi.fn(),
      error: options.runtimeError ?? vi.fn(),
      exit: vi.fn(),
    } as Parameters<typeof syncTelegramMenuCommands>[0]["runtime"],
    commandsToRegister: options.commandsToRegister,
    accountId: options.accountId,
    botIdentity: options.botIdentity,
  });
}

function setMyCommandsCall(setMyCommands: ReturnType<typeof vi.fn>, index: number): unknown[] {
  const call = setMyCommands.mock.calls.at(index);
  if (!call) {
    throw new Error(`Expected setMyCommands call ${index}`);
  }
  return call;
}

function setMyCommandsPayload(
  setMyCommands: ReturnType<typeof vi.fn>,
  index: number,
): Array<unknown> {
  const payload = setMyCommandsCall(setMyCommands, index).at(0);
  if (!Array.isArray(payload)) {
    throw new Error(`Expected setMyCommands call ${index} to include a command payload`);
  }
  return payload;
}

describe("bot-native-command-menu", () => {
  const canonicalCommands = Array.from({ length: 100 }, (_, index) => ({
    command: `canonical_${index}`,
    description: `Canonical ${index}`,
  }));
  it.each([
    {
      label: ">100 count cap",
      allCommands: [
        { command: "early_alias", description: "Alias", isAlias: true },
        ...canonicalCommands,
        { command: "configured", description: "Configured", isConfigured: true },
      ],
      maxTotalChars: TELEGRAM_COMMAND_TEXT_LIMIT,
      retry: false,
      expected: ["configured", ...canonicalCommands.slice(0, 99).map(({ command }) => command)],
    },
    {
      label: "sub-100 text omission",
      allCommands: [
        { command: "early_alias", description: "Alias", isAlias: true },
        { command: "canonical_later", description: "Canonical" },
        { command: "custom_last", description: "Configured", isConfigured: true },
      ],
      maxTotalChars: 28,
      retry: false,
      expected: ["custom_last", "canonical_later"],
    },
    {
      label: "BOT_COMMANDS_TOO_MUCH retry",
      allCommands: [
        { command: "early_alias", description: "Alias", isAlias: true },
        { command: "canonical_a", description: "Canonical A" },
        { command: "configured", description: "Configured", isConfigured: true },
        { command: "canonical_b", description: "Canonical B" },
        { command: "canonical_c", description: "Canonical C" },
      ],
      maxTotalChars: TELEGRAM_COMMAND_TEXT_LIMIT,
      retry: true,
      expected: ["configured", "canonical_a", "canonical_b", "canonical_c"],
    },
    {
      label: "no pressure",
      allCommands: [
        { command: "early_alias", description: "🦞".repeat(250), isAlias: true },
        { command: "canonical", description: "Canonical" },
        { command: "plugin", description: "Plugin" },
        { command: "configured", description: "Configured", isConfigured: true },
      ],
      maxTotalChars: TELEGRAM_COMMAND_TEXT_LIMIT,
      retry: false,
      expected: ["early_alias", "canonical", "plugin", "configured"],
    },
  ])(
    "handles $label with configured, canonical, then alias pressure priority",
    async (testCase) => {
      const result = buildCappedTelegramMenuCommands({
        allCommands: testCase.allCommands,
        maxTotalChars: testCase.maxTotalChars,
      });
      if (!testCase.retry) {
        expect(result.commandsToRegister.map(({ command }) => command)).toEqual(testCase.expected);
        return;
      }

      const setMyCommands = vi
        .fn()
        .mockRejectedValueOnce(new Error("400: Bad Request: BOT_COMMANDS_TOO_MUCH"))
        .mockResolvedValue(undefined);
      syncMenuCommandsWithMocks({
        deleteMyCommands: vi.fn(async () => undefined),
        setMyCommands,
        commandsToRegister: result.commandsToRegister,
        accountId: `test-pressure-${Date.now()}`,
        botIdentity: "bot-a",
      });
      await waitForTelegramMenu(() => expect(setMyCommands).toHaveBeenCalledTimes(3));
      const retryPayload = setMyCommandsPayload(setMyCommands, 1);
      expect(retryPayload.map((command) => (command as { command: string }).command)).toEqual(
        testCase.expected,
      );
      expect(setMyCommandsPayload(setMyCommands, 2)).toEqual(retryPayload);
      expect(retryPayload.every((command) => Object.keys(command as object).length === 2)).toBe(
        true,
      );
    },
  );

  it("does not reuse cached capped results for delimiter-like descriptions", () => {
    const first = buildCappedTelegramMenuCommands({
      allCommands: [{ command: "a", description: "b\0c\0d" }],
    });
    const second = buildCappedTelegramMenuCommands({
      allCommands: [
        { command: "a", description: "b" },
        { command: "c", description: "d" },
      ],
    });

    expect(first.commandsToRegister).toEqual([{ command: "a", description: "b\0c\0d" }]);
    expect(second.commandsToRegister).toEqual([
      { command: "a", description: "b" },
      { command: "c", description: "d" },
    ]);
  });

  it("validates plugin command specs and reports conflicts", () => {
    const existingCommands = new Set(["native"]);

    const result = buildPluginTelegramMenuCommands({
      specs: [
        { name: "valid", description: "  Works  " },
        { name: "bad-name!", description: "Bad" },
        { name: "native", description: "Conflicts with native" },
        { name: "valid", description: "Duplicate plugin name" },
        { name: "empty", description: "   " },
      ],
      existingCommands,
    });

    expect(result.commands).toEqual([{ command: "valid", description: "Works" }]);
    expect(result.issues).toContain(
      'Plugin command "/bad-name!" is invalid for Telegram (use a-z, 0-9, underscore; max 32 chars).',
    );
    expect(result.issues).toContain(
      'Plugin command "/native" conflicts with an existing Telegram command.',
    );
    expect(result.issues).toContain('Plugin command "/valid" is duplicated.');
    expect(result.issues).toContain('Plugin command "/empty" is missing a description.');
  });

  it("preserves plugin command description localizations for Telegram menu sync", () => {
    const result = buildPluginTelegramMenuCommands({
      specs: [
        {
          name: "valid",
          description: "Works",
          descriptionLocalizations: { ko: "작동함" },
        },
      ],
      existingCommands: new Set<string>(),
    });

    expect(result.commands).toEqual([
      {
        command: "valid",
        description: "Works",
        descriptionLocalizations: { ko: "작동함" },
      },
    ]);
    expect(result.issues).toStrictEqual([]);
  });

  it("normalizes hyphenated plugin command names", () => {
    const result = buildPluginTelegramMenuCommands({
      specs: [{ name: "agent-run", description: "Run agent" }],
      existingCommands: new Set<string>(),
    });

    expect(result.commands).toEqual([{ command: "agent_run", description: "Run agent" }]);
    expect(result.issues).toStrictEqual([]);
  });

  it("ignores malformed plugin specs without crashing", () => {
    const malformedSpecs = [
      { name: "valid", description: " Works " },
      { name: "missing-description", description: undefined },
      { name: undefined, description: "Missing name" },
    ] as unknown as Parameters<typeof buildPluginTelegramMenuCommands>[0]["specs"];

    const result = buildPluginTelegramMenuCommands({
      specs: malformedSpecs,
      existingCommands: new Set<string>(),
    });

    expect(result.commands).toEqual([{ command: "valid", description: "Works" }]);
    expect(result.issues).toContain(
      'Plugin command "/missing_description" is missing a description.',
    );
    expect(result.issues).toContain(
      'Plugin command "/<unknown>" is invalid for Telegram (use a-z, 0-9, underscore; max 32 chars).',
    );
  });

  it("deletes stale commands before setting new menu", async () => {
    const callOrder: string[] = [];
    const deleteMyCommands = vi.fn(async (options?: { scope?: { type?: string } }) => {
      callOrder.push(options?.scope?.type ? `delete:${options.scope.type}` : "delete:default");
    });
    const setMyCommands = vi.fn(
      async (_commands: unknown, options?: { scope?: { type?: string } }) => {
        callOrder.push(options?.scope?.type ? `set:${options.scope.type}` : "set:default");
      },
    );

    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      commandsToRegister: [{ command: "cmd", description: "Command" }],
      accountId: `test-delete-${Date.now()}`,
      botIdentity: "bot-a",
    });

    await waitForTelegramMenu(() => {
      expect(setMyCommands).toHaveBeenCalled();
    });

    expect(callOrder).toEqual([
      "delete:default",
      "delete:all_group_chats",
      "set:default",
      "set:all_group_chats",
    ]);
  });

  it("registers the menu in default and group chat scopes", async () => {
    const deleteMyCommands = vi.fn(async () => undefined);
    const setMyCommands = vi.fn(async () => undefined);
    const commands = [{ command: "cmd", description: "Command" }];

    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      commandsToRegister: commands,
      accountId: `test-scopes-${Date.now()}`,
      botIdentity: "bot-a",
    });

    await waitForTelegramMenu(() => {
      expect(setMyCommands).toHaveBeenCalledTimes(2);
    });

    expect(setMyCommands).toHaveBeenCalledWith(commands);
    expect(setMyCommands).toHaveBeenCalledWith(commands, {
      scope: { type: "all_group_chats" },
    });
  });

  it("registers localized command descriptions per Telegram language scope", async () => {
    const deleteMyCommands = vi.fn(async () => undefined);
    const setMyCommands = vi.fn(async () => undefined);
    const runtimeLog = vi.fn();
    const commands = [
      {
        command: "cmd",
        description: "Default",
        descriptionLocalizations: {
          ko: "한국어",
          "en-GB": "British English is unsupported by Telegram",
        },
      },
    ];

    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      runtimeLog,
      commandsToRegister: commands,
      accountId: `test-localized-${Date.now()}`,
      botIdentity: "bot-a",
    });

    await waitForTelegramMenu(() => {
      expect(setMyCommands).toHaveBeenCalledTimes(4);
    });

    expect(setMyCommandsPayload(setMyCommands, 0)).toEqual([
      { command: "cmd", description: "Default" },
    ]);
    expect(setMyCommandsPayload(setMyCommands, 2)).toEqual([
      { command: "cmd", description: "한국어" },
    ]);
    expect(setMyCommandsCall(setMyCommands, 2).at(1)).toEqual({ language_code: "ko" });
    expect(setMyCommandsCall(setMyCommands, 3).at(1)).toEqual({
      scope: { type: "all_group_chats" },
      language_code: "ko",
    });
    expect(runtimeLog).toHaveBeenCalledWith(
      "Telegram command menu ignored unsupported description localization codes: en-GB.",
    );
  });

  it("caps localized command descriptions before registering Telegram variants", async () => {
    const deleteMyCommands = vi.fn(async () => undefined);
    const setMyCommands = vi.fn(async () => undefined);

    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      commandsToRegister: [
        {
          command: "long",
          description: "Default",
          descriptionLocalizations: { ko: "x".repeat(300) },
        },
      ],
      accountId: `test-localized-cap-${Date.now()}`,
      botIdentity: "bot-a",
    });

    await waitForTelegramMenu(() => {
      expect(setMyCommands).toHaveBeenCalledTimes(4);
    });

    const localizedPayload = setMyCommandsPayload(setMyCommands, 2);
    expect(localizedPayload[0]).toMatchObject({ command: "long" });
    expect((localizedPayload[0] as { description: string }).description).toHaveLength(256);
  });

  it("prioritizes configured, canonical, then alias commands under localization-only pressure", async () => {
    const deleteMyCommands = vi.fn(async () => undefined);
    const setMyCommands = vi.fn(async () => undefined);
    const localizedDescription = "한".repeat(250);
    const canonical = Array.from({ length: 22 }, (_, index) => ({
      command: `canonical_${index}`,
      description: `Canonical ${index}`,
      descriptionLocalizations: { ko: localizedDescription },
    }));

    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      commandsToRegister: [
        {
          command: "early_alias",
          description: "Alias",
          descriptionLocalizations: { ko: localizedDescription },
          isAlias: true,
        },
        ...canonical,
        {
          command: "configured",
          description: "Configured",
          descriptionLocalizations: { ko: localizedDescription },
          isConfigured: true,
        },
      ],
      accountId: `test-localized-pressure-${Date.now()}`,
      botIdentity: "bot-a",
    });

    await waitForTelegramMenu(() => expect(setMyCommands).toHaveBeenCalledTimes(4));
    const localizedNames = setMyCommandsPayload(setMyCommands, 2).map(
      (command) => (command as { command: string }).command,
    );
    expect(localizedNames).toEqual([
      "configured",
      ...canonical.map(({ command }) => command),
      "early_alias",
    ]);
    expect(setMyCommandsPayload(setMyCommands, 3)).toEqual(setMyCommandsPayload(setMyCommands, 2));
  });

  it("preserves ordinary localized order when localization creates no pressure", async () => {
    const deleteMyCommands = vi.fn(async () => undefined);
    const setMyCommands = vi.fn(async () => undefined);
    const commands = [
      {
        command: "early_alias",
        description: "Alias",
        descriptionLocalizations: { ko: "별칭" },
        isAlias: true,
      },
      {
        command: "canonical",
        description: "Canonical",
        descriptionLocalizations: { ko: "표준" },
      },
      {
        command: "configured",
        description: "Configured",
        descriptionLocalizations: { ko: "설정" },
        isConfigured: true,
      },
    ];

    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      commandsToRegister: commands,
      accountId: `test-localized-no-pressure-${Date.now()}`,
      botIdentity: "bot-a",
    });

    await waitForTelegramMenu(() => expect(setMyCommands).toHaveBeenCalledTimes(4));
    expect(setMyCommandsPayload(setMyCommands, 2)).toEqual([
      { command: "early_alias", description: "별칭" },
      { command: "canonical", description: "표준" },
      { command: "configured", description: "설정" },
    ]);
    expect(setMyCommandsPayload(setMyCommands, 3)).toEqual(setMyCommandsPayload(setMyCommands, 2));
  });

  it("resyncs when command order changes (#32017)", async () => {
    const deleteMyCommands = vi.fn(async () => undefined);
    const setMyCommands = vi.fn(async () => undefined);
    const runtimeLog = vi.fn();
    const commands = [
      { command: "bravo", description: "B" },
      { command: "alpha", description: "A" },
    ];
    const accountId = `test-order-stable-${Date.now()}`;

    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      runtimeLog,
      commandsToRegister: commands,
      accountId,
      botIdentity: "bot-a",
    });
    await waitForTelegramMenu(() => expect(setMyCommands).toHaveBeenCalledTimes(2));

    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      runtimeLog,
      commandsToRegister: commands.toReversed(),
      accountId,
      botIdentity: "bot-a",
    });
    await waitForTelegramMenu(() => expect(setMyCommands).toHaveBeenCalledTimes(4));
    expect(deleteMyCommands).toHaveBeenCalledTimes(4);
  });

  it("resyncs when a command description changes (#32017)", async () => {
    const deleteMyCommands = vi.fn(async () => undefined);
    const setMyCommands = vi.fn(async () => undefined);
    const runtimeLog = vi.fn();
    const accountId = `test-description-change-${Date.now()}`;

    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      runtimeLog,
      commandsToRegister: [{ command: "alpha", description: "A" }],
      accountId,
      botIdentity: "bot-a",
    });
    await waitForTelegramMenu(() => expect(setMyCommands).toHaveBeenCalledTimes(2));

    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      runtimeLog,
      commandsToRegister: [{ command: "alpha", description: "Changed" }],
      accountId,
      botIdentity: "bot-a",
    });
    await waitForTelegramMenu(() => expect(setMyCommands).toHaveBeenCalledTimes(4));
  });

  it("resyncs delimiter-like command lists without hash collisions", async () => {
    const deleteMyCommands = vi.fn(async () => undefined);
    const setMyCommands = vi.fn(async () => undefined);
    const runtimeLog = vi.fn();
    const accountId = `test-delimiter-collision-${Date.now()}`;

    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      runtimeLog,
      commandsToRegister: [{ command: "a", description: "b\0c\0d" }],
      accountId,
      botIdentity: "bot-a",
    });
    await waitForTelegramMenu(() => expect(setMyCommands).toHaveBeenCalledTimes(2));

    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      runtimeLog,
      commandsToRegister: [
        { command: "a", description: "b" },
        { command: "c", description: "d" },
      ],
      accountId,
      botIdentity: "bot-a",
    });
    await waitForTelegramMenu(() => expect(setMyCommands).toHaveBeenCalledTimes(4));
  });

  it("ignores internal priority metadata in the requested-state hash (#32017)", async () => {
    const deleteMyCommands = vi.fn(async () => undefined);
    const setMyCommands = vi.fn(async () => undefined);
    const runtimeLog = vi.fn();

    const accountId = `test-skip-${Date.now()}`;
    const commands = [{ command: "skip_test", description: "Skip test command" }];

    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      runtimeLog,
      commandsToRegister: [
        {
          command: "skip_test",
          description: "Skip test command",
          isAlias: true,
          isConfigured: true,
        },
      ],
      accountId,
      botIdentity: "bot-a",
    });

    await waitForTelegramMenu(() => {
      expect(setMyCommands).toHaveBeenCalledTimes(2);
    });

    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      runtimeLog,
      commandsToRegister: commands,
      accountId,
      botIdentity: "bot-a",
    });

    expect(setMyCommands).toHaveBeenCalledTimes(2);
  });

  it("does not reuse cached hash across different bot identities", async () => {
    const deleteMyCommands = vi.fn(async () => undefined);
    const setMyCommands = vi.fn(async () => undefined);
    const runtimeLog = vi.fn();
    const accountId = `test-bot-identity-${Date.now()}`;
    const commands = [{ command: "same", description: "Same" }];

    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      runtimeLog,
      commandsToRegister: commands,
      accountId,
      botIdentity: "token-bot-a",
    });
    await waitForTelegramMenu(() => expect(setMyCommands).toHaveBeenCalledTimes(2));

    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      runtimeLog,
      commandsToRegister: commands,
      accountId,
      botIdentity: "token-bot-b",
    });
    await waitForTelegramMenu(() => expect(setMyCommands).toHaveBeenCalledTimes(4));
  });

  it("does not cache empty-menu hash when deleteMyCommands fails", async () => {
    const deleteMyCommands = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient failure"))
      .mockResolvedValue(undefined);
    const setMyCommands = vi.fn(async () => undefined);
    const runtimeLog = vi.fn();
    const accountId = `test-empty-delete-fail-${Date.now()}`;

    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      runtimeLog,
      commandsToRegister: [],
      accountId,
      botIdentity: "bot-a",
    });
    await waitForTelegramMenu(() => expect(deleteMyCommands).toHaveBeenCalledTimes(2));

    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      runtimeLog,
      commandsToRegister: [],
      accountId,
      botIdentity: "bot-a",
    });
    await waitForTelegramMenu(() => expect(deleteMyCommands).toHaveBeenCalledTimes(4));
  });

  it("registers localized variants from the accepted retry command set", async () => {
    const deleteMyCommands = vi.fn(async () => undefined);
    const setMyCommands = vi
      .fn()
      .mockRejectedValueOnce(new Error("400: Bad Request: BOT_COMMANDS_TOO_MUCH"))
      .mockResolvedValue(undefined);

    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      commandsToRegister: Array.from({ length: 100 }, (_, i) => ({
        command: `cmd_${i}`,
        description: `Command ${i}`,
        descriptionLocalizations: { ko: `명령 ${i}` },
      })),
      accountId: `test-localized-retry-${Date.now()}`,
      botIdentity: "bot-a",
    });

    await waitForTelegramMenu(() => {
      expect(setMyCommands).toHaveBeenCalledTimes(5);
    });
    expect(setMyCommandsPayload(setMyCommands, 0)).toHaveLength(100);
    expect(setMyCommandsPayload(setMyCommands, 1)).toHaveLength(80);
    expect(setMyCommandsPayload(setMyCommands, 3)).toHaveLength(80);
    expect(setMyCommandsCall(setMyCommands, 3).at(1)).toEqual({ language_code: "ko" });
  });

  it.each([
    { label: "description envelope", error: { description: "BOT_COMMANDS_TOO_MUCH" } },
    { label: "message envelope", error: { message: "BOT_COMMANDS_TOO_MUCH" } },
  ])("retries when Telegram returns a plain-object $label error", async ({ error }) => {
    const deleteMyCommands = vi.fn(async () => undefined);
    const setMyCommands = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(undefined);
    const runtimeLog = vi.fn();

    syncMenuCommandsWithMocks({
      deleteMyCommands,
      setMyCommands,
      runtimeLog,
      commandsToRegister: Array.from({ length: 10 }, (_, i) => ({
        command: `cmd_${i}`,
        description: `Command ${i}`,
      })),
      accountId: `test-envelope-${Date.now()}`,
      botIdentity: "bot-a",
    });

    await waitForTelegramMenu(() => {
      expect(setMyCommands).toHaveBeenCalledTimes(3);
    });
    expect(runtimeLog).toHaveBeenCalledWith(
      "Telegram rejected 10 commands (BOT_COMMANDS_TOO_MUCH); retrying with 8.",
    );
  });
});
