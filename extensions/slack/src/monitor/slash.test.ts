import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getSlackSlashMocks, resetSlackSlashMocks } from "./slash.test-harness.js";

vi.mock("./slash-commands.runtime.js", () => {
  const usageCommand = { key: "usage", nativeName: "usage" };
  const reportCommand = { key: "report", nativeName: "report" };
  const reportCompactCommand = { key: "reportcompact", nativeName: "reportcompact" };
  const reportExternalCommand = { key: "reportexternal", nativeName: "reportexternal" };
  const reportLongCommand = { key: "reportlong", nativeName: "reportlong" };
  const reportLongButtonCommand = { key: "reportlongbutton", nativeName: "reportlongbutton" };
  const reportHugeButtonCommand = { key: "reporthugebutton", nativeName: "reporthugebutton" };
  const reportHugeValueCommand = { key: "reporthugevalue", nativeName: "reporthugevalue" };
  const unsafeConfirmCommand = { key: "unsafeconfirm", nativeName: "unsafeconfirm" };
  const longConfirmCommand = { key: "longconfirm", nativeName: "longconfirm" };
  const statusAliasCommand = { key: "status", nativeName: "status" };
  const periodArg = { name: "period", description: "period" };
  const baseReportPeriodChoices = [
    { value: "day", label: "day" },
    { value: "week", label: "week" },
    { value: "month", label: "month" },
    { value: "quarter", label: "quarter" },
  ];
  const fullReportPeriodChoices = [...baseReportPeriodChoices, { value: "year", label: "year" }];
  const hasNonEmptyArgValue = (values: unknown, key: string) => {
    const raw =
      typeof values === "object" && values !== null
        ? (values as Record<string, unknown>)[key]
        : undefined;
    return typeof raw === "string" && raw.trim().length > 0;
  };
  const resolvePeriodMenu = (
    params: { args?: { values?: unknown } },
    choices: Array<{
      value: string;
      label: string;
    }>,
  ) => {
    if (hasNonEmptyArgValue(params.args?.values, "period")) {
      return null;
    }
    return { arg: periodArg, choices };
  };

  return {
    buildCommandTextFromArgs: (
      cmd: { nativeName?: string; key: string },
      args?: { values?: Record<string, unknown> },
    ) => {
      const name = cmd.nativeName ?? cmd.key;
      const values = args?.values ?? {};
      const mode = values.mode;
      const period = values.period;
      const selected =
        typeof mode === "string" && mode.trim()
          ? mode.trim()
          : typeof period === "string" && period.trim()
            ? period.trim()
            : "";
      return selected ? `/${name} ${selected}` : `/${name}`;
    },
    findCommandByNativeName: (name: string) => {
      const normalized = name.trim().toLowerCase();
      if (normalized === "usage") {
        return usageCommand;
      }
      if (normalized === "report") {
        return reportCommand;
      }
      if (normalized === "reportcompact") {
        return reportCompactCommand;
      }
      if (normalized === "reportexternal") {
        return reportExternalCommand;
      }
      if (normalized === "reportlong") {
        return reportLongCommand;
      }
      if (normalized === "reportlongbutton") {
        return reportLongButtonCommand;
      }
      if (normalized === "reporthugebutton") {
        return reportHugeButtonCommand;
      }
      if (normalized === "reporthugevalue") {
        return reportHugeValueCommand;
      }
      if (normalized === "unsafeconfirm") {
        return unsafeConfirmCommand;
      }
      if (normalized === "longconfirm") {
        return longConfirmCommand;
      }
      if (normalized === "agentstatus") {
        return statusAliasCommand;
      }
      return undefined;
    },
    listNativeCommandSpecsForConfig: () => [
      {
        name: "usage",
        description: "Usage",
        acceptsArgs: true,
        args: [],
      },
      {
        name: "report",
        description: "Report",
        acceptsArgs: true,
        args: [],
      },
      {
        name: "reportcompact",
        description: "ReportCompact",
        acceptsArgs: true,
        args: [],
      },
      {
        name: "reportexternal",
        description: "ReportExternal",
        acceptsArgs: true,
        args: [],
      },
      {
        name: "reportlong",
        description: "ReportLong",
        acceptsArgs: true,
        args: [],
      },
      {
        name: "reportlongbutton",
        description: "ReportLongButton",
        acceptsArgs: true,
        args: [],
      },
      {
        name: "reporthugebutton",
        description: "ReportHugeButton",
        acceptsArgs: true,
        args: [],
      },
      {
        name: "reporthugevalue",
        description: "ReportHugeValue",
        acceptsArgs: true,
        args: [],
      },
      {
        name: "unsafeconfirm",
        description: "UnsafeConfirm",
        acceptsArgs: true,
        args: [],
      },
      {
        name: "longconfirm",
        description: "LongConfirm",
        acceptsArgs: true,
        args: [],
      },
      {
        name: "agentstatus",
        description: "Status",
        acceptsArgs: false,
        args: [],
      },
    ],
    parseCommandArgs: () => ({ values: {} }),
    resolveCommandArgMenu: (params: {
      command?: { key?: string };
      args?: { values?: unknown };
    }) => {
      if (params.command?.key === "report") {
        return resolvePeriodMenu(params, [
          ...fullReportPeriodChoices,
          { value: "all", label: "all" },
        ]);
      }
      if (params.command?.key === "reportlong") {
        return resolvePeriodMenu(params, [
          ...fullReportPeriodChoices,
          { value: "x".repeat(100), label: "long" },
        ]);
      }
      if (params.command?.key === "reportlongbutton") {
        return resolvePeriodMenu(params, [
          {
            value: "x".repeat(170),
            label: "Long button label ".repeat(8),
          },
        ]);
      }
      if (params.command?.key === "reporthugebutton") {
        return resolvePeriodMenu(
          params,
          Array.from({ length: 250 }, (_v, i) => ({
            value: `${String(i + 1)}-${"x".repeat(170)}`,
            label: `Long button label ${i + 1}`,
          })),
        );
      }
      if (params.command?.key === "reporthugevalue") {
        return resolvePeriodMenu(params, [
          { value: "valid", label: "Valid" },
          { value: "x".repeat(2500), label: "Overlong" },
        ]);
      }
      if (params.command?.key === "reportcompact") {
        return resolvePeriodMenu(params, baseReportPeriodChoices);
      }
      if (params.command?.key === "reportexternal") {
        return {
          arg: { name: "period", description: "period" },
          choices: Array.from({ length: 140 }, (_v, i) => ({
            value: `period-${i + 1}`,
            label: `Period ${i + 1}`,
          })),
        };
      }
      if (params.command?.key === "unsafeconfirm") {
        return {
          arg: { name: "mode_*`~<&>", description: "mode" },
          choices: [
            { value: "on", label: "on" },
            { value: "off", label: "off" },
          ],
        };
      }
      if (params.command?.key === "longconfirm") {
        return {
          arg: { name: `mode_${"x".repeat(320)}`, description: "mode" },
          choices: [
            { value: "on", label: "on" },
            { value: "off", label: "off" },
          ],
        };
      }
      if (params.command?.key !== "usage") {
        return null;
      }
      const values = (params.args?.values ?? {}) as Record<string, unknown>;
      if (typeof values.mode === "string" && values.mode.trim()) {
        return null;
      }
      return {
        arg: { name: "mode", description: "mode" },
        choices: [
          { value: "tokens", label: "tokens" },
          { value: "cost", label: "cost" },
        ],
      };
    },
  };
});

type RegisterFn = (params: { ctx: unknown; account: unknown }) => Promise<void>;
const { registerSlackMonitorSlashCommands } = (await import("./slash.js")) as {
  registerSlackMonitorSlashCommands: RegisterFn;
};

const { dispatchMock } = getSlackSlashMocks();

beforeEach(() => {
  resetSlackSlashMocks();
});

async function registerCommands(ctx: unknown, account: unknown, trackEvent?: () => void) {
  await registerSlackMonitorSlashCommands({
    ctx: ctx as never,
    account: account as never,
    trackEvent,
  } as never);
}

function encodeValue(parts: { command: string; arg: string; value: string; userId: string }) {
  return [
    "cmdarg",
    encodeURIComponent(parts.command),
    encodeURIComponent(parts.arg),
    encodeURIComponent(parts.value),
    encodeURIComponent(parts.userId),
  ].join("|");
}

function findFirstActionsBlock(payload: { blocks?: Array<{ type: string }> }) {
  return payload.blocks?.find((block) => block.type === "actions") as
    | { type: string; elements?: Array<{ type?: string; action_id?: string; confirm?: unknown }> }
    | undefined;
}

function createDeferred<T>() {
  let resolve: ((value: T | PromiseLike<T>) => void) | undefined;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  if (!resolve) {
    throw new Error("Expected Slack slash deferred resolver to be initialized");
  }
  return { promise, resolve };
}

function createArgMenusHarness() {
  const commands = new Map<string, (args: unknown) => Promise<void>>();
  const actions = new Map<string | RegExp, (args: unknown) => Promise<void>>();
  const options = new Map<string, (args: unknown) => Promise<void>>();
  const optionsReceiverContexts: unknown[] = [];

  const postEphemeral = vi.fn().mockResolvedValue({ ok: true });
  const app = {
    client: { chat: { postEphemeral } },
    command: (name: string, handler: (args: unknown) => Promise<void>) => {
      commands.set(name, handler);
    },
    action: (id: string | RegExp, handler: (args: unknown) => Promise<void>) => {
      actions.set(id, handler);
    },
    options: function (this: unknown, id: string, handler: (args: unknown) => Promise<void>) {
      optionsReceiverContexts.push(this);
      options.set(id, handler);
    },
  };

  const ctx = {
    cfg: { commands: { native: true, nativeSkills: false } },
    runtime: {},
    botToken: "bot-token",
    botUserId: "bot",
    teamId: "T1",
    allowFrom: ["*"],
    dmEnabled: true,
    dmPolicy: "open",
    groupDmEnabled: false,
    groupDmChannels: [],
    defaultRequireMention: true,
    groupPolicy: "open",
    useAccessGroups: false,
    channelsConfig: undefined,
    slashCommand: {
      enabled: true,
      name: "openclaw",
      ephemeral: true,
      sessionPrefix: "slack:slash",
    },
    textLimit: 4000,
    app,
    isChannelAllowed: () => true,
    resolveChannelName: async () => ({ name: "dm", type: "im" }),
    resolveUserName: async () => ({ name: "Ada" }),
  } as unknown;

  const account = {
    accountId: "acct",
    config: { commands: { native: true, nativeSkills: false } },
  } as unknown;

  return {
    commands,
    actions,
    options,
    optionsReceiverContexts,
    postEphemeral,
    ctx,
    account,
    app,
  };
}

function requireHandler(
  handlers: Map<string | RegExp, (args: unknown) => Promise<void>>,
  key: string | RegExp,
  label: string,
): (args: unknown) => Promise<void> {
  const handler =
    key instanceof RegExp
      ? Array.from(handlers.entries()).find(
          ([candidate]) => candidate instanceof RegExp && String(candidate) === String(key),
        )?.[1]
      : handlers.get(key);
  if (!handler) {
    throw new Error(`Missing ${label} handler`);
  }
  return handler;
}

function createSlashCommand(overrides: Partial<Record<string, string>> = {}) {
  return {
    user_id: "U1",
    user_name: "Ada",
    channel_id: "C1",
    channel_name: "directmessage",
    text: "",
    trigger_id: "t1",
    ...overrides,
  };
}

async function runCommandHandler(handler: (args: unknown) => Promise<void>) {
  const respond = vi.fn().mockResolvedValue(undefined);
  const ack = vi.fn().mockResolvedValue(undefined);
  await handler({
    command: createSlashCommand(),
    ack,
    respond,
  });
  return { respond, ack };
}

function expectArgMenuLayout(respond: ReturnType<typeof vi.fn>): {
  type: string;
  elements?: Array<{ type?: string; action_id?: string; confirm?: unknown }>;
} {
  expect(respond).toHaveBeenCalledTimes(1);
  const payload = firstCallPayload(respond, "response") as { blocks?: Array<{ type: string }> };
  expect(payload.blocks?.[0]?.type).toBe("header");
  expect(payload.blocks?.[1]?.type).toBe("section");
  expect(payload.blocks?.[2]?.type).toBe("context");
  const actions = findFirstActionsBlock(payload);
  if (!actions) {
    throw new Error("actions block missing");
  }
  return actions;
}

function expectSingleDispatchedSlashBody(expectedBody: string) {
  expect(dispatchMock).toHaveBeenCalledTimes(1);
  const call = firstDispatchArg() as { ctx?: { Body?: string } };
  expect(call.ctx?.Body).toBe(expectedBody);
}

type ActionsBlockPayload = {
  blocks?: Array<{ type: string; block_id?: string }>;
};

async function runCommandAndResolveActionsBlock(
  handler: (args: unknown) => Promise<void>,
): Promise<{
  respond: ReturnType<typeof vi.fn>;
  payload: ActionsBlockPayload;
  blockId?: string;
}> {
  const { respond } = await runCommandHandler(handler);
  const payload = firstCallPayload(respond, "response") as ActionsBlockPayload;
  const blockId = payload.blocks?.find((block) => block.type === "actions")?.block_id;
  return { respond, payload, blockId };
}

async function getFirstActionElementFromCommand(handler: (args: unknown) => Promise<void>) {
  const { respond } = await runCommandHandler(handler);
  expect(respond).toHaveBeenCalledTimes(1);
  const payload = firstCallPayload(respond, "response") as { blocks?: Array<{ type: string }> };
  const actions = findFirstActionsBlock(payload);
  const element = actions?.elements?.[0];
  if (!element) {
    throw new Error("first action element missing");
  }
  return element;
}

async function runArgMenuAction(
  handler: (args: unknown) => Promise<void>,
  params: {
    action: Record<string, unknown>;
    userId?: string;
    userName?: string;
    channelId?: string;
    channelName?: string;
    respond?: ReturnType<typeof vi.fn>;
    includeRespond?: boolean;
  },
) {
  const includeRespond = params.includeRespond ?? true;
  const respond = params.respond ?? vi.fn().mockResolvedValue(undefined);
  const payload: Record<string, unknown> = {
    ack: vi.fn().mockResolvedValue(undefined),
    action: params.action,
    body: {
      user: { id: params.userId ?? "U1", name: params.userName ?? "Ada" },
      channel: { id: params.channelId ?? "C1", name: params.channelName ?? "directmessage" },
      trigger_id: "t1",
    },
  };
  if (includeRespond) {
    payload.respond = respond;
  }
  await handler(payload);
  return respond;
}

type MockCallSource = {
  mock: {
    calls: ArrayLike<ReadonlyArray<unknown>>;
  };
};

function firstMockArg(mock: MockCallSource, argIndex: number, label: string) {
  expect(mock).toHaveBeenCalled();
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  return call[argIndex];
}

function firstCallPayload(mock: MockCallSource, label: string): Record<string, unknown> {
  const payload = firstMockArg(mock, 0, label);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`expected ${label} payload`);
  }
  return payload as Record<string, unknown>;
}

function firstDispatchArg(): { ctx?: Record<string, unknown> } {
  return firstMockArg(dispatchMock as unknown as MockCallSource, 0, "dispatch") as {
    ctx?: Record<string, unknown>;
  };
}

function responseTexts(mock: ReturnType<typeof vi.fn>): unknown[] {
  return mock.mock.calls.map(([payload]) =>
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as { text?: unknown }).text
      : undefined,
  );
}

describe("Slack native command argument menus", () => {
  let harness: ReturnType<typeof createArgMenusHarness>;
  let usageHandler: (args: unknown) => Promise<void>;
  let reportHandler: (args: unknown) => Promise<void>;
  let reportCompactHandler: (args: unknown) => Promise<void>;
  let reportExternalHandler: (args: unknown) => Promise<void>;
  let reportLongHandler: (args: unknown) => Promise<void>;
  let reportLongButtonHandler: (args: unknown) => Promise<void>;
  let reportHugeButtonHandler: (args: unknown) => Promise<void>;
  let reportHugeValueHandler: (args: unknown) => Promise<void>;
  let unsafeConfirmHandler: (args: unknown) => Promise<void>;
  let longConfirmHandler: (args: unknown) => Promise<void>;
  let agentStatusHandler: (args: unknown) => Promise<void>;
  let argMenuHandler: (args: unknown) => Promise<void>;
  let argMenuOptionsHandler: (args: unknown) => Promise<void>;

  beforeAll(async () => {
    harness = createArgMenusHarness();
    await registerCommands(harness.ctx, harness.account);
    usageHandler = requireHandler(harness.commands, "/usage", "/usage");
    reportHandler = requireHandler(harness.commands, "/report", "/report");
    reportCompactHandler = requireHandler(harness.commands, "/reportcompact", "/reportcompact");
    reportExternalHandler = requireHandler(harness.commands, "/reportexternal", "/reportexternal");
    reportLongHandler = requireHandler(harness.commands, "/reportlong", "/reportlong");
    reportLongButtonHandler = requireHandler(
      harness.commands,
      "/reportlongbutton",
      "/reportlongbutton",
    );
    reportHugeButtonHandler = requireHandler(
      harness.commands,
      "/reporthugebutton",
      "/reporthugebutton",
    );
    reportHugeValueHandler = requireHandler(
      harness.commands,
      "/reporthugevalue",
      "/reporthugevalue",
    );
    unsafeConfirmHandler = requireHandler(harness.commands, "/unsafeconfirm", "/unsafeconfirm");
    longConfirmHandler = requireHandler(harness.commands, "/longconfirm", "/longconfirm");
    agentStatusHandler = requireHandler(harness.commands, "/agentstatus", "/agentstatus");
    argMenuHandler = requireHandler(harness.actions, /^openclaw_cmdarg/, "arg-menu action");
    argMenuOptionsHandler = requireHandler(harness.options, "openclaw_cmdarg", "arg-menu options");
  });

  beforeEach(() => {
    harness.postEphemeral.mockClear();
  });

  it("registers options handlers without losing app receiver binding", async () => {
    const testHarness = createArgMenusHarness();
    await registerCommands(testHarness.ctx, testHarness.account);
    expect(testHarness.commands.size).toBeGreaterThan(0);
    expect(
      Array.from(testHarness.actions.keys()).some(
        (key) => key instanceof RegExp && String(key) === String(/^openclaw_cmdarg/),
      ),
    ).toBe(true);
    expect(testHarness.options.has("openclaw_cmdarg")).toBe(true);
    expect(testHarness.optionsReceiverContexts[0]).toBe(testHarness.app);
  });

  it("falls back to static menus when app.options() throws during registration", async () => {
    const commands = new Map<string, (args: unknown) => Promise<void>>();
    const actions = new Map<string | RegExp, (args: unknown) => Promise<void>>();
    const postEphemeral = vi.fn().mockResolvedValue({ ok: true });
    const app = {
      client: { chat: { postEphemeral } },
      command: (name: string, handler: (args: unknown) => Promise<void>) => {
        commands.set(name, handler);
      },
      action: (id: string | RegExp, handler: (args: unknown) => Promise<void>) => {
        actions.set(id, handler);
      },
      // Simulate Bolt throwing during options registration (e.g. receiver not initialized)
      options: () => {
        throw new Error("Cannot read properties of undefined (reading 'listeners')");
      },
    };
    const ctx = {
      cfg: { commands: { native: true, nativeSkills: false } },
      runtime: {},
      botToken: "bot-token",
      botUserId: "bot",
      teamId: "T1",
      allowFrom: ["*"],
      dmEnabled: true,
      dmPolicy: "open",
      groupDmEnabled: false,
      groupDmChannels: [],
      defaultRequireMention: true,
      groupPolicy: "open",
      useAccessGroups: false,
      channelsConfig: undefined,
      slashCommand: {
        enabled: true,
        name: "openclaw",
        ephemeral: true,
        sessionPrefix: "slack:slash",
      },
      textLimit: 4000,
      app,
      isChannelAllowed: () => true,
      resolveChannelName: async () => ({ name: "dm", type: "im" }),
      resolveUserName: async () => ({ name: "Ada" }),
    } as unknown;
    const account = {
      accountId: "acct",
      config: { commands: { native: true, nativeSkills: false } },
    } as unknown;

    // Registration should not throw despite app.options() throwing
    await registerCommands(ctx, account);
    expect(commands.size).toBeGreaterThan(0);
    expect(
      Array.from(actions.keys()).some(
        (key) => key instanceof RegExp && String(key) === String(/^openclaw_cmdarg/),
      ),
    ).toBe(true);

    // The /reportexternal command (140 choices) should fall back to static_select
    // instead of external_select since options registration failed
    const handler = requireHandler(commands, "/reportexternal", "/reportexternal");
    const respond = vi.fn().mockResolvedValue(undefined);
    const ack = vi.fn().mockResolvedValue(undefined);
    await handler({
      command: createSlashCommand(),
      ack,
      respond,
    });
    expect(respond).toHaveBeenCalledTimes(1);
    const payload = firstCallPayload(respond, "response") as {
      blocks?: Array<{ type: string }>;
    };
    const actionsBlock = findFirstActionsBlock(payload);
    // Should be static_select (fallback) not external_select
    expect(actionsBlock?.elements?.[0]?.type).toBe("static_select");
  });

  it("shows a button menu when required args are omitted", async () => {
    const { respond } = await runCommandHandler(usageHandler);
    const actions = expectArgMenuLayout(respond);
    const elementType = actions?.elements?.[0]?.type;
    expect(elementType).toBe("button");
    expect(actions?.elements?.[0]?.action_id).toBe("openclaw_cmdarg_0_0");
    expect(actions?.elements?.[1]?.action_id).toBe("openclaw_cmdarg_0_1");
    expect(actions?.elements?.[0]).toHaveProperty("confirm");
  });

  it("shows a static_select menu when choices exceed button row size", async () => {
    const { respond } = await runCommandHandler(reportHandler);
    const actions = expectArgMenuLayout(respond);
    const element = actions?.elements?.[0];
    expect(element?.type).toBe("static_select");
    expect(element?.action_id).toBe("openclaw_cmdarg");
    expect(element).toHaveProperty("confirm");
  });

  it("uses static_select when encoded values fit Slack option limits", async () => {
    const firstElement = (await getFirstActionElementFromCommand(reportLongHandler)) as
      | {
          type?: string;
          options?: Array<{ value?: string }>;
          confirm?: unknown;
        }
      | undefined;
    expect(firstElement?.type).toBe("static_select");
    const longOption = firstElement?.options?.find((option) => option.value?.includes("xxx"));
    expect(longOption?.value?.length).toBeGreaterThan(75);
    expect(longOption?.value?.length).toBeLessThanOrEqual(150);
    expect(firstElement).toHaveProperty("confirm");
  });

  it("truncates button labels when static_select value limit would be exceeded", async () => {
    const firstElement = (await getFirstActionElementFromCommand(reportLongButtonHandler)) as
      | { type?: string; text?: { text?: string }; value?: string; confirm?: unknown }
      | undefined;
    expect(firstElement?.type).toBe("button");
    expect(firstElement?.text?.text).toHaveLength(75);
    expect(firstElement?.text?.text?.endsWith("…")).toBe(true);
    expect(firstElement?.value?.length).toBeGreaterThan(75);
    expect(firstElement).toHaveProperty("confirm");
  });

  it("caps large button fallback menus to Slack's block limit", async () => {
    const { respond } = await runCommandHandler(reportHugeButtonHandler);
    expect(respond).toHaveBeenCalledTimes(1);
    const payload = firstCallPayload(respond, "response") as {
      blocks?: Array<{ type: string; elements?: unknown[] }>;
    };
    const actionBlocks = (payload.blocks ?? []).filter((block) => block.type === "actions");
    expect(payload.blocks).toHaveLength(50);
    expect(actionBlocks).toHaveLength(47);
    expect(actionBlocks.at(-1)?.elements).toHaveLength(5);
  });

  it("drops fallback buttons whose encoded values exceed Slack's button value limit", async () => {
    const { respond } = await runCommandHandler(reportHugeValueHandler);
    expect(respond).toHaveBeenCalledTimes(1);
    const payload = firstCallPayload(respond, "response") as {
      blocks?: Array<{
        type: string;
        elements?: Array<{ text?: { text?: string }; value?: string }>;
      }>;
    };
    const actionBlocks = (payload.blocks ?? []).filter((block) => block.type === "actions");
    expect(actionBlocks).toHaveLength(1);
    expect(actionBlocks[0]?.elements).toHaveLength(1);
    const element = actionBlocks[0]?.elements?.[0];
    expect(element?.text?.text).toBe("Valid");
    expect(element?.value?.length).toBeLessThanOrEqual(2000);
  });

  it("shows an overflow menu when choices fit compact range", async () => {
    const element = await getFirstActionElementFromCommand(reportCompactHandler);
    expect(element?.type).toBe("overflow");
    expect(element?.action_id).toBe("openclaw_cmdarg");
    expect(element).toHaveProperty("confirm");
  });

  it("escapes mrkdwn characters in confirm dialog text", async () => {
    const element = (await getFirstActionElementFromCommand(unsafeConfirmHandler)) as
      | { confirm?: { text?: { text?: string } } }
      | undefined;
    expect(element?.confirm?.text?.text).toContain(
      "Run */unsafeconfirm* with *mode\\_\\*\\`\\~&lt;&amp;&gt;* set to this value?",
    );
  });

  it("truncates confirm dialog text when long args force button fallback", async () => {
    const element = (await getFirstActionElementFromCommand(longConfirmHandler)) as
      | { type?: string; confirm?: { text?: { text?: string } } }
      | undefined;
    const confirmText = element?.confirm?.text?.text;
    expect(element?.type).toBe("button");
    expect(confirmText).toHaveLength(300);
    expect(confirmText?.endsWith("…")).toBe(true);
  });

  it("dispatches the command when a menu button is clicked", async () => {
    await runArgMenuAction(argMenuHandler, {
      action: {
        value: encodeValue({ command: "usage", arg: "mode", value: "tokens", userId: "U1" }),
      },
    });

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const call = firstDispatchArg() as { ctx?: { Body?: string } };
    expect(call.ctx?.Body).toBe("/usage tokens");
  });

  it("tracks accepted slash command activity", async () => {
    const trackingHarness = createArgMenusHarness();
    const trackEvent = vi.fn();
    await registerCommands(trackingHarness.ctx, trackingHarness.account, trackEvent);
    const usageTrackingHandler = requireHandler(trackingHarness.commands, "/usage", "/usage");

    await runCommandHandler(usageTrackingHandler);

    expect(trackEvent).toHaveBeenCalledTimes(1);
  });

  it("maps /agentstatus to /status when dispatching", async () => {
    await runCommandHandler(agentStatusHandler);
    expectSingleDispatchedSlashBody("/status");
  });

  it("dispatches the command when a static_select option is chosen", async () => {
    await runArgMenuAction(argMenuHandler, {
      action: {
        selected_option: {
          value: encodeValue({ command: "report", arg: "period", value: "month", userId: "U1" }),
        },
      },
    });

    expectSingleDispatchedSlashBody("/report month");
  });

  it("dispatches the command when an overflow option is chosen", async () => {
    await runArgMenuAction(argMenuHandler, {
      action: {
        selected_option: {
          value: encodeValue({
            command: "reportcompact",
            arg: "period",
            value: "quarter",
            userId: "U1",
          }),
        },
      },
    });

    expectSingleDispatchedSlashBody("/reportcompact quarter");
  });

  it("shows an external_select menu when choices exceed static_select options max", async () => {
    const { respond, payload, blockId } =
      await runCommandAndResolveActionsBlock(reportExternalHandler);

    expect(respond).toHaveBeenCalledTimes(1);
    const actions = findFirstActionsBlock(payload);
    const element = actions?.elements?.[0];
    expect(element?.type).toBe("external_select");
    expect(element?.action_id).toBe("openclaw_cmdarg");
    expect(blockId).toContain("openclaw_cmdarg_ext:");
    const token = (blockId ?? "").slice("openclaw_cmdarg_ext:".length);
    expect(token).toMatch(/^[A-Za-z0-9_-]{24}$/);
  });

  it("serves filtered options for external_select menus", async () => {
    const { blockId } = await runCommandAndResolveActionsBlock(reportExternalHandler);
    expect(blockId).toContain("openclaw_cmdarg_ext:");

    const ackOptions = vi.fn().mockResolvedValue(undefined);
    await argMenuOptionsHandler({
      ack: ackOptions,
      body: {
        user: { id: "U1" },
        value: "period 12",
        actions: [{ block_id: blockId }],
      },
    });

    expect(ackOptions).toHaveBeenCalledTimes(1);
    const optionsPayload = firstCallPayload(ackOptions, "options ack") as {
      options?: Array<{ text?: { text?: string }; value?: string }>;
    };
    const optionTexts = (optionsPayload.options ?? []).map((option) => option.text?.text ?? "");
    expect(optionTexts.join("\n")).toContain("Period 12");
  });

  it("tracks accepted external_select option requests", async () => {
    const trackingHarness = createArgMenusHarness();
    const trackEvent = vi.fn();
    await registerCommands(trackingHarness.ctx, trackingHarness.account, trackEvent);
    const reportExternalTrackingHandler = requireHandler(
      trackingHarness.commands,
      "/reportexternal",
      "/reportexternal",
    );
    const argMenuOptionsTrackingHandler = requireHandler(
      trackingHarness.options,
      "openclaw_cmdarg",
      "arg-menu options",
    );
    const { blockId } = await runCommandAndResolveActionsBlock(reportExternalTrackingHandler);
    const ackOptions = vi.fn().mockResolvedValue(undefined);
    trackEvent.mockClear();

    await argMenuOptionsTrackingHandler({
      ack: ackOptions,
      body: {
        user: { id: "U1" },
        value: "period 12",
        actions: [{ block_id: blockId }],
      },
    });

    expect(trackEvent).toHaveBeenCalledTimes(1);
  });

  it("rejects external_select option requests without user identity", async () => {
    const { blockId } = await runCommandAndResolveActionsBlock(reportExternalHandler);
    expect(blockId).toContain("openclaw_cmdarg_ext:");

    const ackOptions = vi.fn().mockResolvedValue(undefined);
    await argMenuOptionsHandler({
      ack: ackOptions,
      body: {
        value: "period 1",
        actions: [{ block_id: blockId }],
      },
    });

    expect(ackOptions).toHaveBeenCalledTimes(1);
    expect(ackOptions).toHaveBeenCalledWith({ options: [] });
  });

  it("rejects menu clicks from other users", async () => {
    const respond = await runArgMenuAction(argMenuHandler, {
      action: {
        value: encodeValue({ command: "usage", arg: "mode", value: "tokens", userId: "U1" }),
      },
      userId: "U2",
      userName: "Eve",
    });

    expect(dispatchMock).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith({
      text: "That menu is for another user.",
      response_type: "ephemeral",
    });
  });

  it("tracks accepted arg-menu actions", async () => {
    const trackingHarness = createArgMenusHarness();
    const trackEvent = vi.fn();
    await registerCommands(trackingHarness.ctx, trackingHarness.account, trackEvent);
    const argMenuTrackingHandler = requireHandler(
      trackingHarness.actions,
      /^openclaw_cmdarg/,
      "arg-menu action",
    );

    await runArgMenuAction(argMenuTrackingHandler, {
      action: {
        value: encodeValue({ command: "usage", arg: "mode", value: "tokens", userId: "U1" }),
      },
    });

    expect(trackEvent).toHaveBeenCalledTimes(1);
  });

  it("falls back to postEphemeral with token when respond is unavailable", async () => {
    await runArgMenuAction(argMenuHandler, {
      action: { value: "garbage" },
      includeRespond: false,
    });

    const payload = firstCallPayload(harness.postEphemeral, "postEphemeral");
    expect(payload.token).toBe("bot-token");
    expect(payload.channel).toBe("C1");
    expect(payload.user).toBe("U1");
  });

  it("treats malformed percent-encoding as an invalid button", async () => {
    await runArgMenuAction(argMenuHandler, {
      action: { value: "cmdarg|%E0%A4%A|mode|on|U1" },
      includeRespond: false,
    });

    const payload = firstCallPayload(harness.postEphemeral, "postEphemeral");
    expect(payload.token).toBe("bot-token");
    expect(payload.channel).toBe("C1");
    expect(payload.user).toBe("U1");
    expect(payload.text).toBe("Sorry, that button is no longer valid.");
  });
});

function createPolicyHarness(overrides?: {
  groupPolicy?: "open" | "allowlist";
  channelsConfig?: Record<string, { enabled?: boolean; requireMention?: boolean }>;
  channelId?: string;
  channelName?: string;
  allowFrom?: string[];
  useAccessGroups?: boolean;
  shouldDropMismatchedSlackEvent?: (body: unknown) => boolean;
  resolveChannelName?: () => Promise<{ name?: string; type?: string }>;
}) {
  const commands = new Map<unknown, (args: unknown) => Promise<void>>();
  const postEphemeral = vi.fn().mockResolvedValue({ ok: true });
  const app = {
    client: { chat: { postEphemeral } },
    command: (name: unknown, handler: (args: unknown) => Promise<void>) => {
      commands.set(name, handler);
    },
  };

  const channelId = overrides?.channelId ?? "C_UNLISTED";
  const channelName = overrides?.channelName ?? "unlisted";

  const ctx = {
    cfg: { commands: { native: false } },
    runtime: {},
    botToken: "bot-token",
    botUserId: "bot",
    teamId: "T1",
    allowFrom: overrides?.allowFrom ?? ["*"],
    dmEnabled: true,
    dmPolicy: "open",
    groupDmEnabled: false,
    groupDmChannels: [],
    defaultRequireMention: true,
    groupPolicy: overrides?.groupPolicy ?? "open",
    useAccessGroups: overrides?.useAccessGroups ?? true,
    channelsConfig: overrides?.channelsConfig,
    slashCommand: {
      enabled: true,
      name: "openclaw",
      ephemeral: true,
      sessionPrefix: "slack:slash",
    },
    textLimit: 4000,
    app,
    isChannelAllowed: () => true,
    shouldDropMismatchedSlackEvent: (body: unknown) =>
      overrides?.shouldDropMismatchedSlackEvent?.(body) ?? false,
    resolveChannelName:
      overrides?.resolveChannelName ?? (async () => ({ name: channelName, type: "channel" })),
    resolveUserName: async () => ({ name: "Ada" }),
  } as unknown;

  const account = { accountId: "acct", config: { commands: { native: false } } } as unknown;

  return { commands, ctx, account, postEphemeral, channelId, channelName };
}

async function runSlashHandler(params: {
  commands: Map<unknown, (args: unknown) => Promise<void>>;
  body?: unknown;
  command: Partial<{
    user_id: string;
    user_name: string;
    channel_id: string;
    channel_name: string;
    text: string;
    trigger_id: string;
  }> &
    Pick<{ channel_id: string; channel_name: string }, "channel_id" | "channel_name">;
}): Promise<{ respond: ReturnType<typeof vi.fn>; ack: ReturnType<typeof vi.fn> }> {
  const handler = [...params.commands.values()][0];
  if (!handler) {
    throw new Error("Missing slash handler");
  }

  const respond = vi.fn().mockResolvedValue(undefined);
  const ack = vi.fn().mockResolvedValue(undefined);

  await handler({
    body: params.body,
    command: {
      user_id: "U1",
      user_name: "Ada",
      text: "hello",
      trigger_id: "t1",
      ...params.command,
    },
    ack,
    respond,
  });

  return { respond, ack };
}

async function registerAndRunPolicySlash(params: {
  harness: ReturnType<typeof createPolicyHarness>;
  body?: unknown;
  command?: Partial<{
    user_id: string;
    user_name: string;
    channel_id: string;
    channel_name: string;
    text: string;
    trigger_id: string;
  }>;
}) {
  await registerCommands(params.harness.ctx, params.harness.account);
  return await runSlashHandler({
    commands: params.harness.commands,
    body: params.body,
    command: {
      channel_id: params.command?.channel_id ?? params.harness.channelId,
      channel_name: params.command?.channel_name ?? params.harness.channelName,
      ...params.command,
    },
  });
}

function expectChannelBlockedResponse(respond: ReturnType<typeof vi.fn>) {
  expect(dispatchMock).not.toHaveBeenCalled();
  expect(respond).toHaveBeenCalledWith({
    text: "This channel is not allowed.",
    response_type: "ephemeral",
  });
}

function expectUnauthorizedResponse(respond: ReturnType<typeof vi.fn>) {
  expect(dispatchMock).not.toHaveBeenCalled();
  expect(respond).toHaveBeenCalledWith({
    text: "You are not authorized to use this command.",
    response_type: "ephemeral",
  });
}

describe("slack slash commands channel policy", () => {
  it("drops mismatched slash payloads before dispatch", async () => {
    const harness = createPolicyHarness({
      shouldDropMismatchedSlackEvent: () => true,
    });
    const { respond, ack } = await registerAndRunPolicySlash({
      harness,
      body: {
        api_app_id: "A_MISMATCH",
        team_id: "T_MISMATCH",
      },
    });

    expect(ack).toHaveBeenCalledTimes(1);
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(respond).not.toHaveBeenCalled();
  });

  it("allows unlisted channels when groupPolicy is open", async () => {
    const harness = createPolicyHarness({
      groupPolicy: "open",
      channelsConfig: { C_LISTED: { requireMention: true } },
      channelId: "C_UNLISTED",
      channelName: "unlisted",
    });
    const { respond } = await registerAndRunPolicySlash({ harness });

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(responseTexts(respond)).not.toContain("This channel is not allowed.");
  });

  it("blocks explicitly denied channels when groupPolicy is open", async () => {
    const harness = createPolicyHarness({
      groupPolicy: "open",
      channelsConfig: { C_DENIED: { enabled: false } },
      channelId: "C_DENIED",
      channelName: "denied",
    });
    const { respond } = await registerAndRunPolicySlash({ harness });

    expectChannelBlockedResponse(respond);
  });

  it("blocks unlisted channels when groupPolicy is allowlist", async () => {
    const harness = createPolicyHarness({
      groupPolicy: "allowlist",
      channelsConfig: { C_LISTED: { requireMention: true } },
      channelId: "C_UNLISTED",
      channelName: "unlisted",
    });
    const { respond } = await registerAndRunPolicySlash({ harness });

    expectChannelBlockedResponse(respond);
  });
});

describe("slack slash commands access groups", () => {
  it("fails closed when channel type lookup returns empty for channels", async () => {
    const harness = createPolicyHarness({
      allowFrom: [],
      channelId: "C_UNKNOWN",
      channelName: "unknown",
      resolveChannelName: async () => ({}),
    });
    const { respond } = await registerAndRunPolicySlash({ harness });

    expectUnauthorizedResponse(respond);
  });

  it("still treats D-prefixed channel ids as DMs when lookup fails", async () => {
    const harness = createPolicyHarness({
      allowFrom: ["*"],
      channelId: "D123",
      channelName: "notdirectmessage",
      resolveChannelName: async () => ({}),
    });
    const { respond } = await registerAndRunPolicySlash({
      harness,
      command: {
        channel_id: "D123",
        channel_name: "notdirectmessage",
      },
    });

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(responseTexts(respond)).not.toContain("You are not authorized to use this command.");
    const dispatchArg = firstDispatchArg() as {
      ctx?: { CommandAuthorized?: boolean };
    };
    expect(dispatchArg?.ctx?.CommandAuthorized).toBe(true);
  });

  it("computes CommandAuthorized for DM slash commands when dmPolicy is open", async () => {
    const harness = createPolicyHarness({
      allowFrom: ["*"],
      channelId: "D999",
      channelName: "directmessage",
      resolveChannelName: async () => ({ name: "directmessage", type: "im" }),
    });
    await registerAndRunPolicySlash({
      harness,
      command: {
        user_id: "U_ATTACKER",
        user_name: "Mallory",
        channel_id: "D999",
        channel_name: "directmessage",
      },
    });

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const dispatchArg = firstDispatchArg() as {
      ctx?: { CommandAuthorized?: boolean };
    };
    expect(dispatchArg?.ctx?.CommandAuthorized).toBe(true);
  });

  it("classifies MPIM slash commands as group chat context", async () => {
    const harness = createPolicyHarness({
      channelId: "G_MPIM",
      channelName: "group-dm",
      resolveChannelName: async () => ({ name: "group-dm", type: "mpim" }),
    });
    await registerAndRunPolicySlash({ harness });

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const dispatchArg = firstDispatchArg() as {
      ctx?: { ChatType?: string; From?: string };
    };
    expect(dispatchArg?.ctx?.ChatType).toBe("group");
    expect(dispatchArg?.ctx?.From).toBe("slack:group:G_MPIM");
  });

  it("enforces access-group gating when lookup fails for private channels", async () => {
    const harness = createPolicyHarness({
      allowFrom: [],
      channelId: "G123",
      channelName: "private",
      resolveChannelName: async () => ({}),
    });
    const { respond } = await registerAndRunPolicySlash({ harness });

    expectUnauthorizedResponse(respond);
  });
});

describe("slack slash command session metadata", () => {
  const { recordSessionMetaFromInboundMock } = getSlackSlashMocks();

  it("calls recordSessionMetaFromInbound after dispatching a slash command", async () => {
    const harness = createPolicyHarness({ groupPolicy: "open" });
    await registerAndRunPolicySlash({ harness });

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(recordSessionMetaFromInboundMock).toHaveBeenCalledTimes(1);
    const call = firstMockArg(
      recordSessionMetaFromInboundMock as unknown as MockCallSource,
      0,
      "session meta",
    ) as {
      sessionKey?: string;
      ctx?: { GroupSpace?: string; OriginatingChannel?: string };
    };
    expect(call.ctx?.OriginatingChannel).toBe("slack");
    expect(call.ctx?.GroupSpace).toBe("T1");
    expect(call.sessionKey).toBeTypeOf("string");
    expect(call.sessionKey).not.toBe("");
  });

  it("awaits session metadata persistence before dispatch", async () => {
    const recordStarted = createDeferred<void>();
    const deferred = createDeferred<void>();
    recordSessionMetaFromInboundMock.mockClear().mockImplementation(() => {
      recordStarted.resolve();
      return deferred.promise;
    });

    const harness = createPolicyHarness({ groupPolicy: "open" });
    await registerCommands(harness.ctx, harness.account);

    const runPromise = runSlashHandler({
      commands: harness.commands,
      command: {
        channel_id: harness.channelId,
        channel_name: harness.channelName,
      },
    });

    await recordStarted.promise;
    expect(recordSessionMetaFromInboundMock).toHaveBeenCalledTimes(1);
    expect(dispatchMock).not.toHaveBeenCalled();

    deferred.resolve();
    await runPromise;

    expect(dispatchMock).toHaveBeenCalledTimes(1);
  });
});
