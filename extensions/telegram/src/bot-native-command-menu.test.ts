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

function waitForTelegramMenuTurn() {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

type SyncMenuOptions = {
  deleteMyCommands: ReturnType<typeof vi.fn>;
  setMyCommands: ReturnType<typeof vi.fn>;
  commandsToRegister: Parameters<typeof syncTelegramMenuCommands>[0]["commandsToRegister"];
  accountId: string;
  botToken: string;
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
    botToken: options.botToken,
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

function buildSkillRetryCommands(params: {
  nativeCount: number;
  skillCount: number;
  pluginCount: number;
}): SyncMenuOptions["commandsToRegister"] {
  return [
    { command: "custom_one", description: "Custom one" },
    { command: "custom_two", description: "Custom two" },
    ...Array.from({ length: params.nativeCount }, (_, index) => ({
      command: `native_${index}`,
      description: `Native ${index}`,
    })),
    { command: "skill", description: "Run a skill" },
    ...Array.from({ length: params.skillCount }, (_, index) => ({
      command: `skill_${index}`,
      description: `Skill ${index}`,
      isSkill: true,
    })),
    ...Array.from({ length: params.pluginCount }, (_, index) => ({
      command: `plugin_${index}`,
      description: `Plugin ${index}`,
    })),
  ];
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
        { command: "configured", description: "Configured" },
        ...canonicalCommands,
        { command: "late_alias", description: "Alias", isAlias: true },
      ],
      maxTotalChars: TELEGRAM_COMMAND_TEXT_LIMIT,
      retry: false,
      expected: ["configured", ...canonicalCommands.slice(0, 99).map(({ command }) => command)],
    },
    {
      label: "sub-100 text omission",
      allCommands: [
        { command: "custom_last", description: "Configured" },
        { command: "canonical_later", description: "Canonical" },
        { command: "late_alias", description: "Alias", isAlias: true },
      ],
      maxTotalChars: 28,
      retry: false,
      expected: ["custom_last", "canonical_later"],
    },
    {
      label: "BOT_COMMANDS_TOO_MUCH retry",
      allCommands: [
        { command: "configured", description: "Configured" },
        { command: "canonical_a", description: "Canonical A" },
        { command: "canonical_b", description: "Canonical B" },
        { command: "canonical_c", description: "Canonical C" },
        { command: "late_alias", description: "Alias", isAlias: true },
      ],
      maxTotalChars: TELEGRAM_COMMAND_TEXT_LIMIT,
      retry: true,
      expected: ["configured", "canonical_a", "canonical_b", "canonical_c"],
    },
    {
      label: "no pressure",
      allCommands: [
        { command: "configured", description: "Configured" },
        { command: "canonical", description: "Canonical" },
        { command: "plugin", description: "Plugin" },
        { command: "late_alias", description: "🦞".repeat(250), isAlias: true },
      ],
      maxTotalChars: TELEGRAM_COMMAND_TEXT_LIMIT,
      retry: false,
      expected: ["configured", "canonical", "plugin", "late_alias"],
    },
  ])("preserves canonical source order for $label", async (testCase) => {
    const result = buildCappedTelegramMenuCommands({
      allCommands: testCase.allCommands,
      maxTotalChars: testCase.maxTotalChars,
    });
    if (!testCase.retry) {
      expect(result.commandsToRegister.map(({ command }) => command)).toEqual(testCase.expected);
      if (testCase.label === "no pressure") {
        expect(result.commandsToRegister).toEqual(testCase.allCommands);
      }
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
      botToken: "bot-a",
    });
    await waitForTelegramMenu(() => expect(setMyCommands).toHaveBeenCalledTimes(3));
    const retryPayload = setMyCommandsPayload(setMyCommands, 1);
    expect(retryPayload.map((command) => (command as { command: string }).command)).toEqual(
      testCase.expected,
    );
    expect(setMyCommandsPayload(setMyCommands, 2)).toEqual(retryPayload);
    expect(retryPayload.every((command) => Object.keys(command as object).length === 2)).toBe(true);
  });

  it("promotes /skill when local fitting omits every direct skill", () => {
    const configured = Array.from({ length: 100 }, (_, index) => ({
      command: `configured_${index}`,
      description: `Configured ${index}`,
    }));
    const result = buildCappedTelegramMenuCommands({
      allCommands: [
        ...configured,
        { command: "skill", description: "Run a skill" },
        { command: "direct_one", description: "Direct one", isSkill: true },
        { command: "direct_two", description: "Direct two", isSkill: true },
      ],
    });

    expect(result.skillCommandsOmitted).toBe(true);
    expect(result.commandsToRegister.map((command) => command.command)).toEqual([
      "skill",
      ...configured.slice(0, 99).map((command) => command.command),
    ]);
  });

  it.each([
    {
      label: "partial direct-skill prefix",
      nativeCount: 67,
      source: buildSkillRetryCommands({ nativeCount: 67, skillCount: 20, pluginCount: 10 }),
      expectedPluginTail: Array.from({ length: 10 }, (_, index) => `plugin_${index}`),
    },
    {
      label: "zero direct skills retained",
      nativeCount: 77,
      source: buildSkillRetryCommands({ nativeCount: 77, skillCount: 10, pluginCount: 10 }),
      expectedPluginTail: [] as string[],
    },
  ])("collapses $label on BOT_COMMANDS_TOO_MUCH", async (testCase) => {
    const setMyCommands = vi
      .fn()
      .mockRejectedValueOnce(new Error("400: Bad Request: BOT_COMMANDS_TOO_MUCH"))
      .mockResolvedValue(undefined);
    const runtimeLog = vi.fn();
    syncMenuCommandsWithMocks({
      deleteMyCommands: vi.fn(async () => undefined),
      setMyCommands,
      runtimeLog,
      commandsToRegister: testCase.source,
      accountId: `test-skill-retry-${testCase.label}-${Date.now()}`,
      botToken: "bot-skill-retry",
    });
    await waitForTelegramMenu(() => expect(setMyCommands).toHaveBeenCalledTimes(3));

    const retryPayload = setMyCommandsPayload(setMyCommands, 1);
    const retryNames = retryPayload.map((command) => (command as { command: string }).command);
    expect(retryNames).toEqual([
      "skill",
      "custom_one",
      "custom_two",
      ...Array.from({ length: testCase.nativeCount }, (_, index) => `native_${index}`),
      ...testCase.expectedPluginTail,
    ]);
    expect(retryNames.some((command) => command.startsWith("skill_"))).toBe(false);
    expect(setMyCommandsCall(setMyCommands, 1).at(1)).toBeUndefined();
    expect(setMyCommandsPayload(setMyCommands, 2)).toEqual(retryPayload);
    expect(setMyCommandsCall(setMyCommands, 2).at(1)).toEqual({
      scope: { type: "all_group_chats" },
    });
    expect(runtimeLog.mock.calls.map(([message]) => message)).toEqual([
      "Telegram rejected 100 commands (BOT_COMMANDS_TOO_MUCH); retrying with 80.",
      "Telegram accepted 80 commands after BOT_COMMANDS_TOO_MUCH (started with 100; omitted 20). Reduce plugin/skill/custom commands to expose more menu entries.",
    ]);
  });

  it("logs and progresses from the actual underfilled retry length", async () => {
    const setMyCommands = vi
      .fn()
      .mockRejectedValueOnce(new Error("400: Bad Request: BOT_COMMANDS_TOO_MUCH"))
      .mockResolvedValue(undefined);
    const runtimeLog = vi.fn();
    const source = buildSkillRetryCommands({ nativeCount: 37, skillCount: 60, pluginCount: 0 });
    syncMenuCommandsWithMocks({
      deleteMyCommands: vi.fn(async () => undefined),
      setMyCommands,
      runtimeLog,
      commandsToRegister: source,
      accountId: `test-underfilled-skill-retry-${Date.now()}`,
      botToken: "bot-underfilled-skill-retry",
    });
    await waitForTelegramMenu(() => expect(setMyCommands).toHaveBeenCalledTimes(3));

    const retryPayload = setMyCommandsPayload(setMyCommands, 1);
    const retryNames = retryPayload.map((command) => (command as { command: string }).command);
    expect(retryNames).toEqual([
      "skill",
      "custom_one",
      "custom_two",
      ...Array.from({ length: 37 }, (_, index) => `native_${index}`),
    ]);
    expect(retryNames.some((command) => command.startsWith("skill_"))).toBe(false);
    expect(setMyCommandsCall(setMyCommands, 1).at(1)).toBeUndefined();
    expect(setMyCommandsPayload(setMyCommands, 2)).toEqual(retryPayload);
    expect(setMyCommandsCall(setMyCommands, 2).at(1)).toEqual({
      scope: { type: "all_group_chats" },
    });
    expect(runtimeLog.mock.calls.map(([message]) => message)).toEqual([
      "Telegram rejected 100 commands (BOT_COMMANDS_TOO_MUCH); retrying with 40.",
      "Telegram accepted 40 commands after BOT_COMMANDS_TOO_MUCH (started with 100; omitted 60). Reduce plugin/skill/custom commands to expose more menu entries.",
    ]);
  });

  it("refills a second BOT_COMMANDS_TOO_MUCH reduction from the original catalog", async () => {
    const setMyCommands = vi
      .fn()
      .mockRejectedValueOnce(new Error("400: Bad Request: BOT_COMMANDS_TOO_MUCH"))
      .mockRejectedValueOnce(new Error("400: Bad Request: BOT_COMMANDS_TOO_MUCH"))
      .mockResolvedValue(undefined);
    const runtimeLog = vi.fn();
    const source = buildSkillRetryCommands({ nativeCount: 57, skillCount: 20, pluginCount: 20 });
    syncMenuCommandsWithMocks({
      deleteMyCommands: vi.fn(async () => undefined),
      setMyCommands,
      runtimeLog,
      commandsToRegister: source,
      accountId: `test-second-skill-retry-${Date.now()}`,
      botToken: "bot-second-skill-retry",
    });
    await waitForTelegramMenu(() => expect(setMyCommands).toHaveBeenCalledTimes(4));

    const firstRetryNames = setMyCommandsPayload(setMyCommands, 1).map(
      (command) => (command as { command: string }).command,
    );
    expect(firstRetryNames).toHaveLength(80);
    expect(firstRetryNames.filter((command) => command.startsWith("skill_"))).toHaveLength(20);
    expect(firstRetryNames.some((command) => command.startsWith("plugin_"))).toBe(false);
    const secondRetryPayload = setMyCommandsPayload(setMyCommands, 2);
    const secondRetryNames = secondRetryPayload.map(
      (command) => (command as { command: string }).command,
    );
    expect(secondRetryNames).toHaveLength(64);
    expect(secondRetryNames.slice(0, 3)).toEqual(["skill", "custom_one", "custom_two"]);
    expect(secondRetryNames.some((command) => command.startsWith("skill_"))).toBe(false);
    expect(secondRetryNames.slice(-4)).toEqual(
      Array.from({ length: 4 }, (_, index) => `plugin_${index}`),
    );
    expect(setMyCommandsCall(setMyCommands, 2).at(1)).toBeUndefined();
    expect(setMyCommandsPayload(setMyCommands, 3)).toEqual(secondRetryPayload);
    expect(setMyCommandsCall(setMyCommands, 3).at(1)).toEqual({
      scope: { type: "all_group_chats" },
    });
    expect(runtimeLog.mock.calls.map(([message]) => message)).toEqual([
      "Telegram rejected 100 commands (BOT_COMMANDS_TOO_MUCH); retrying with 80.",
      "Telegram rejected 80 commands (BOT_COMMANDS_TOO_MUCH); retrying with 64.",
      "Telegram accepted 64 commands after BOT_COMMANDS_TOO_MUCH (started with 100; omitted 36). Reduce plugin/skill/custom commands to expose more menu entries.",
    ]);
  });

  it("hashes effective localizations independently of insertion order", async () => {
    const deleteMyCommands = vi.fn(async () => undefined);
    const setMyCommands = vi.fn(async () => undefined);
    const accountId = `test-localization-hash-${Date.now()}`;
    const sync = (descriptionLocalizations: Record<string, string>) =>
      syncMenuCommandsWithMocks({
        deleteMyCommands,
        setMyCommands,
        accountId,
        botToken: "bot-localization-hash",
        commandsToRegister: [
          {
            command: "localized",
            description: "Default|value\0",
            descriptionLocalizations,
          },
        ],
      });

    sync({ fr: "Français|value\0", ko: "한국어" });
    await waitForTelegramMenu(() => expect(setMyCommands).toHaveBeenCalledTimes(6));
    sync({ ko: "한국어", " FR ": " Français|value\0 " });
    await waitForTelegramMenuTurn();
    expect(setMyCommands).toHaveBeenCalledTimes(6);
    sync({ ko: "변경됨", fr: "Français|value\0" });
    await waitForTelegramMenu(() => expect(setMyCommands).toHaveBeenCalledTimes(12));
  });

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

  it("sorts plugin commands deterministically and prefers exact normalized identities", () => {
    const specs = [
      { name: "zeta", description: "Zeta" },
      {
        name: "foo-bar",
        description: "Transformed alias",
        descriptionLocalizations: { ko: "변환됨" },
      },
      {
        name: "foo_bar",
        description: "Exact owner",
        descriptionLocalizations: { ko: "정확함" },
      },
      { name: "alpha", description: "Alpha" },
    ];
    const build = (orderedSpecs: typeof specs) =>
      buildPluginTelegramMenuCommands({
        specs: orderedSpecs,
        existingCommands: new Set<string>(),
      });

    const forward = build(specs);
    const reverse = build(specs.toReversed());

    expect(forward).toEqual(reverse);
    expect(forward.commands).toEqual([
      { command: "alpha", description: "Alpha" },
      {
        command: "foo_bar",
        description: "Exact owner",
        descriptionLocalizations: { ko: "정확함" },
      },
      { command: "zeta", description: "Zeta" },
    ]);
    expect(forward.issues).toContain('Plugin command "/foo_bar" is duplicated.');
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
});
