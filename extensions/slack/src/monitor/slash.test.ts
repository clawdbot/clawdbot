import type { ChatCommandDefinition } from "openclaw/plugin-sdk/command-auth-native";
// Slack tests cover slash plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { NativeCommandSpec } from "openclaw/plugin-sdk/native-command-registry";
import { clearPluginCommands, registerPluginCommand } from "openclaw/plugin-sdk/plugin-runtime";
import {
  createEmptyPluginRegistry,
  getActivePluginRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { dispatchReplyWithBufferedBlockDispatcher } from "openclaw/plugin-sdk/reply-dispatch-runtime";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getSlackSlashMocks, resetSlackSlashMocks } from "./slash.test-harness.js";

vi.mock("openclaw/plugin-sdk/agent-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/agent-runtime")>(
    "openclaw/plugin-sdk/agent-runtime",
  );
  return {
    ...actual,
    loadPreparedModelCatalog: vi.fn(async () => []),
  };
});

type StaticCommandChoice = string | { value: string; label: string };

const slashCommandFixtures = vi.hoisted(() => {
  const defineMenuCommand = (params: {
    name: string;
    choices: StaticCommandChoice[];
    argName?: string;
  }): ChatCommandDefinition => ({
    key: params.name,
    nativeName: params.name,
    description: `Slack ${params.name} test command`,
    textAliases: [],
    acceptsArgs: true,
    argsParsing: "positional",
    argsMenu: "auto",
    args: [
      {
        name: params.argName ?? "period",
        description: params.argName ?? "period",
        type: "string",
        choices: params.choices,
      },
    ],
    scope: "native",
  });
  const commands: ChatCommandDefinition[] = [
    {
      key: "login",
      nativeName: "login",
      description: "Login",
      textAliases: [],
      acceptsArgs: true,
      argsParsing: "none",
      scope: "native",
    },
    defineMenuCommand({
      name: "reportlong",
      choices: ["day", "week", "month", "quarter", "year", "x".repeat(100)],
    }),
    defineMenuCommand({
      name: "reportlongbutton",
      choices: [{ value: "x".repeat(170), label: "Long button label ".repeat(8) }],
    }),
    defineMenuCommand({
      name: "reporthugebutton",
      choices: Array.from({ length: 250 }, (_value, index) => ({
        value: `${String(index + 1)}-${"x".repeat(170)}`,
        label: `Long button label ${index + 1}`,
      })),
    }),
    defineMenuCommand({
      name: "reporthugevalue",
      choices: [
        { value: "valid", label: "Valid" },
        { value: "x".repeat(2500), label: "Overlong" },
      ],
    }),
    defineMenuCommand({
      name: "reportexternal",
      choices: [
        ...Array.from({ length: 140 }, (_value, index) => ({
          value: `period-${index + 1}`,
          label: `Period ${index + 1}`,
        })),
        // The emoji straddles Slack's 75-character plain-text limit.
        { value: "emoji-overflow", label: `${"a".repeat(74)}😀 emojioverflow` },
      ],
    }),
    defineMenuCommand({
      name: "unsafeconfirm",
      argName: "mode_*`~<&>",
      choices: ["on", "off"],
    }),
    defineMenuCommand({
      name: "longconfirm",
      argName: `mode_${"x".repeat(320)}`,
      choices: ["on", "off"],
    }),
  ];
  const specs = commands.map(
    (command): NativeCommandSpec => ({
      name: command.nativeName!,
      description: command.description,
      acceptsArgs: true,
      args: command.args,
    }),
  );
  return {
    commandsByName: new Map(commands.map((command) => [command.nativeName!, command])),
    specs: [
      ...specs,
      { name: "agentstatus", description: "Status", acceptsArgs: false },
    ] satisfies NativeCommandSpec[],
  };
});

const pluginCommandFixtures = vi.hoisted(() => ({
  specs: [] as Array<
    NativeCommandSpec & {
      channels?: string[];
      execute?: (args?: string) => Promise<{ text: string }>;
    }
  >,
}));

const retainNativeCatalog = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/plugin-command-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/plugin-command-runtime")>();
  return {
    ...actual,
    createPluginCommandRuntime: () => {
      const runtime = actual.createPluginCommandRuntime();
      return {
        ...runtime,
        retainNativeCatalog: (provider: string) => {
          retainNativeCatalog(provider);
          runtime.retainNativeCatalog(provider);
        },
      };
    },
  };
});

const skillCommandFixtures = vi.hoisted(() => ({
  commands: [] as Array<{ name: string; skillName: string; description: string }>,
}));

vi.mock("./slash-commands.runtime.js", async () => {
  const actual = await vi.importActual<typeof import("./slash-commands.runtime.js")>(
    "./slash-commands.runtime.js",
  );
  return {
    ...actual,
    findCommandByNativeName: (
      ...args: Parameters<typeof actual.findCommandByNativeName>
    ): ReturnType<typeof actual.findCommandByNativeName> =>
      slashCommandFixtures.commandsByName.get(args[0]) ??
      (args[0] === "agentstatus"
        ? actual.findCommandByNativeName("status", undefined, args[2])
        : undefined) ??
      // Plugin discovery can recursively load Slack while this test is importing
      // its monitor. The built-in command definitions are the behavior under test.
      actual.findCommandByNativeName(args[0], undefined, args[2]),
    listNativeCommandSpecsForConfig: (
      ...args: Parameters<typeof actual.listNativeCommandSpecsForConfig>
    ): ReturnType<typeof actual.listNativeCommandSpecsForConfig> => [
      ...actual.listNativeCommandSpecsForConfig(args[0], {
        ...args[1],
        provider: undefined,
      }),
      ...slashCommandFixtures.specs,
    ],
  };
});

vi.mock("./slash-skill-commands.runtime.js", async () => {
  const actual = await vi.importActual<typeof import("./slash-skill-commands.runtime.js")>(
    "./slash-skill-commands.runtime.js",
  );
  return {
    ...actual,
    listSkillCommandsForAgents: () => skillCommandFixtures.commands,
  };
});

type RegisterFn = (params: {
  ctx: unknown;
  account: unknown;
}) => Promise<{ mode: "single"; name: string } | { mode: "native" } | { mode: "disabled" }>;
const { registerSlackMonitorSlashCommands } = (await import("./slash.js")) as {
  registerSlackMonitorSlashCommands: RegisterFn;
};

const { dispatchMock } = getSlackSlashMocks();
setActivePluginRegistry(createEmptyPluginRegistry());

beforeEach(() => {
  pluginCommandFixtures.specs = [];
  skillCommandFixtures.commands = [];
  clearRuntimeConfigSnapshot();
  resetSlackSlashMocks();
  clearPluginCommands();
  retainNativeCatalog.mockClear();
});

afterEach(() => {
  pluginCommandFixtures.specs = [];
  skillCommandFixtures.commands = [];
  clearRuntimeConfigSnapshot();
  clearPluginCommands();
});

async function registerCommands(ctx: unknown, account: unknown, trackEvent?: () => void) {
  const registry = getActivePluginRegistry();
  for (const spec of pluginCommandFixtures.specs) {
    if (registry?.commands.some((entry) => entry.command.name === spec.name)) {
      continue;
    }
    expect(
      registerPluginCommand(`test-${spec.name}`, {
        name: spec.name,
        description: spec.description,
        acceptsArgs: spec.acceptsArgs,
        channels: spec.channels,
        handler: async ({ args }) => (spec.execute ? await spec.execute(args) : { text: "plugin" }),
      }),
    ).toEqual({ ok: true });
  }
  return await registerSlackMonitorSlashCommands({
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

function createArgMenusHarness(
  cfg: OpenClawConfig = { commands: { native: true, nativeSkills: false } },
  scope?: {
    installationIdentity?:
      | { kind: "workspace"; teamId: string }
      | { kind: "enterprise"; enterpriseId: string };
    teamId?: string;
  },
) {
  const commands = new Map<string | RegExp, (args: unknown) => Promise<void>>();
  const commandRegistrations: Array<string | RegExp> = [];
  const actions = new Map<string | RegExp, (args: unknown) => Promise<void>>();
  const options = new Map<string, (args: unknown) => Promise<void>>();
  const optionsReceiverContexts: unknown[] = [];

  const postEphemeral = vi.fn().mockResolvedValue({ ok: true });
  const listenerClient = { chat: { postEphemeral } };
  const installationIdentity = scope?.installationIdentity ?? {
    kind: "workspace" as const,
    teamId: scope?.teamId ?? "T1",
  };
  const boltContext =
    installationIdentity.kind === "enterprise"
      ? {
          teamId: scope?.teamId,
          enterpriseId: installationIdentity.enterpriseId,
          isEnterpriseInstall: true,
        }
      : { teamId: installationIdentity.teamId, isEnterpriseInstall: false };
  const withBoltScope = (args: unknown) => {
    const typed = args as { context?: Record<string, unknown>; client?: unknown };
    return {
      ...typed,
      context: { ...boltContext, ...typed.context },
      client: typed.client ?? listenerClient,
    };
  };
  const app = {
    client: listenerClient,
    command: (name: string | RegExp, handler: (args: unknown) => Promise<void>) => {
      commandRegistrations.push(name);
      commands.set(name, async (args) => await handler(withBoltScope(args)));
    },
    action: (id: string | RegExp, handler: (args: unknown) => Promise<void>) => {
      actions.set(id, async (args) => await handler(withBoltScope(args)));
    },
    options(this: unknown, id: string, handler: (args: unknown) => Promise<void>) {
      optionsReceiverContexts.push(this);
      options.set(id, async (args) => await handler(withBoltScope(args)));
    },
  };

  const ctx = {
    cfg,
    runtime: {},
    botToken: "bot-token",
    botUserId: "bot",
    teamId: installationIdentity.kind === "enterprise" ? "" : installationIdentity.teamId,
    installationIdentity,
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
      enabled: false,
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
    commandRegistrations,
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

function setAsyncDispatchMock(
  implementation: (params: { replyOptions?: Record<PropertyKey, unknown> }) => Promise<unknown>,
) {
  (
    dispatchMock as unknown as {
      mockImplementation: (callback: typeof implementation) => unknown;
    }
  ).mockImplementation(implementation);
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

async function getCommandArgMenuValues(handler: (args: unknown) => Promise<void>) {
  const { respond } = await runCommandHandler(handler);
  const payload = firstCallPayload(respond, "response") as {
    blocks?: Array<{
      type: string;
      elements?: Array<{ value?: string; options?: Array<{ value?: string }> }>;
    }>;
  };
  const encodedValues = (payload.blocks ?? [])
    .filter((block) => block.type === "actions")
    .flatMap((block) =>
      (block.elements ?? []).flatMap((element) => {
        const values = (element.options ?? []).flatMap((option) =>
          option.value ? [option.value] : [],
        );
        if (element.value) {
          values.unshift(element.value);
        }
        return values;
      }),
    );
  return encodedValues.flatMap((value) => {
    const encodedChoice = value.split("|")[3];
    return encodedChoice ? [decodeURIComponent(encodedChoice)] : [];
  });
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

function mockSixDispatchedReplies() {
  const { deliverSlackSlashRepliesMock } = getSlackSlashMocks();
  deliverSlackSlashRepliesMock.mockImplementation(async (params: unknown) => {
    const { replies, responseBudget } = params as {
      replies: Array<{ text: string }>;
      responseBudget: { respond: (payload: { text: string }) => Promise<unknown> };
    };
    for (const reply of replies) {
      await responseBudget.respond({ text: reply.text });
    }
  });
  dispatchMock.mockImplementation((params: unknown) => {
    const deliver = (
      params as {
        dispatcherOptions: {
          deliver: (payload: { text: string }, info: { kind: "final" }) => Promise<void>;
        };
      }
    ).dispatcherOptions.deliver;
    for (let index = 0; index < 6; index += 1) {
      void deliver({ text: `reply ${String(index + 1)}` }, { kind: "final" });
    }
    return { counts: { final: 6, tool: 0, block: 0 } };
  });
}

describe("Slack native command argument menus", () => {
  let harness: ReturnType<typeof createArgMenusHarness>;
  let loginHandler: (args: unknown) => Promise<void>;
  let toolsHandler: (args: unknown) => Promise<void>;
  let ttsHandler: (args: unknown) => Promise<void>;
  let usageHandler: (args: unknown) => Promise<void>;
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
    loginHandler = requireHandler(harness.commands, "/login", "/login");
    toolsHandler = requireHandler(harness.commands, "/tools", "/tools");
    ttsHandler = requireHandler(harness.commands, "/tts", "/tts");
    usageHandler = requireHandler(harness.commands, "/usage", "/usage");
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

  it("delivers native /login block replies before the command finishes", async () => {
    const loginFinished = createDeferred<void>();
    const codeDelivered = createDeferred<void>();
    const { deliverSlackSlashRepliesMock } = getSlackSlashMocks();
    deliverSlackSlashRepliesMock.mockImplementation(async (params: unknown) => {
      const replies = (params as { replies: Array<{ text?: string }> }).replies;
      if (replies.some((reply) => reply.text === "Use code ABCD")) {
        codeDelivered.resolve();
      }
    });
    const asyncDispatchMock = dispatchMock as unknown as {
      mockImplementation: (
        implementation: (params: unknown) => Promise<unknown>,
      ) => typeof dispatchMock;
    };
    asyncDispatchMock.mockImplementation(async (params: unknown) => {
      const deliver = (
        params as {
          dispatcherOptions: {
            deliver: (
              payload: { text: string },
              info: { kind: "block" | "final" },
            ) => Promise<void>;
          };
        }
      ).dispatcherOptions.deliver;
      await deliver({ text: "Use code ABCD" }, { kind: "block" });
      await loginFinished.promise;
      await deliver({ text: "Codex login complete." }, { kind: "final" });
      return { counts: { final: 1, tool: 0, block: 1 } };
    });

    const runPromise = runCommandHandler(loginHandler);
    await codeDelivered.promise;
    expect(deliverSlackSlashRepliesMock).toHaveBeenCalledOnce();
    expect(deliverSlackSlashRepliesMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ replies: [{ text: "Use code ABCD" }] }),
    );

    loginFinished.resolve();
    await runPromise;
    expect(deliverSlackSlashRepliesMock).toHaveBeenCalledTimes(2);
    expect(deliverSlackSlashRepliesMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ replies: [{ text: "Codex login complete." }] }),
    );
  });

  it("batches non-login block streams with the terminal reply", async () => {
    const { deliverSlackSlashRepliesMock } = getSlackSlashMocks();
    const asyncDispatchMock = dispatchMock as unknown as {
      mockImplementation: (
        implementation: (params: unknown) => Promise<unknown>,
      ) => typeof dispatchMock;
    };
    asyncDispatchMock.mockImplementation(async (params: unknown) => {
      const deliver = (
        params as {
          dispatcherOptions: {
            deliver: (
              payload: { text: string },
              info: { kind: "block" | "final" },
            ) => Promise<void>;
          };
        }
      ).dispatcherOptions.deliver;
      for (let index = 1; index <= 5; index += 1) {
        await deliver({ text: `progress ${String(index)}` }, { kind: "block" });
      }
      await deliver({ text: "final answer" }, { kind: "final" });
      return { counts: { final: 1, tool: 0, block: 5 } };
    });

    await runCommandHandler(agentStatusHandler);

    expect(deliverSlackSlashRepliesMock).toHaveBeenCalledOnce();
    expect(deliverSlackSlashRepliesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [
          { text: "progress 1" },
          { text: "progress 2" },
          { text: "progress 3" },
          { text: "progress 4" },
          { text: "progress 5" },
          { text: "final answer" },
        ],
      }),
    );
  });

  it("batches accepted payloads in order while omitting a hook-cancelled payload", async () => {
    const { deliverSlackSlashRepliesMock, turnPlanMock } = getSlackSlashMocks();
    const asyncDispatchMock = dispatchMock as unknown as {
      mockImplementation: (
        implementation: (params: unknown) => Promise<unknown>,
      ) => typeof dispatchMock;
    };
    asyncDispatchMock.mockImplementation(async (params: unknown) => {
      const deliver = (
        params as {
          dispatcherOptions: {
            deliver: (payload: { text: string }, info: { kind: "final" }) => Promise<void>;
          };
        }
      ).dispatcherOptions.deliver;
      const plan = turnPlanMock.mock.calls.at(-1)?.[0] as {
        delivery: {
          onDelivered?: (payload: unknown, info: unknown, result: unknown) => Promise<void> | void;
        };
      };
      await deliver({ text: "first" }, { kind: "final" });
      await plan.delivery.onDelivered?.(
        { text: "cancelled" },
        { kind: "final" },
        {
          visibleReplySent: false,
          suppression: { reason: "cancelled_by_reply_payload_sending_hook" },
        },
      );
      await deliver({ text: "third" }, { kind: "final" });
      return { counts: { final: 2, tool: 0, block: 0 } };
    });

    await runCommandHandler(agentStatusHandler);

    expect(deliverSlackSlashRepliesMock).toHaveBeenCalledOnce();
    expect(deliverSlackSlashRepliesMock).toHaveBeenCalledWith(
      expect.objectContaining({ replies: [{ text: "first" }, { text: "third" }] }),
    );
  });

  it("does not call the response URL when every payload is hook-cancelled", async () => {
    const { deliverSlackSlashRepliesMock, turnPlanMock } = getSlackSlashMocks();
    const asyncDispatchMock = dispatchMock as unknown as {
      mockImplementation: (implementation: () => Promise<unknown>) => typeof dispatchMock;
    };
    asyncDispatchMock.mockImplementation(async () => {
      const plan = turnPlanMock.mock.calls.at(-1)?.[0] as {
        delivery: {
          onDelivered?: (payload: unknown, info: unknown, result: unknown) => Promise<void> | void;
        };
      };
      await plan.delivery.onDelivered?.(
        { text: "cancelled" },
        { kind: "final" },
        {
          visibleReplySent: false,
          suppression: { reason: "cancelled_by_reply_payload_sending_hook" },
        },
      );
      return { counts: { final: 0, tool: 0, block: 0 } };
    });

    await runCommandHandler(agentStatusHandler);

    expect(deliverSlackSlashRepliesMock).not.toHaveBeenCalled();
  });

  it("prefers the configured slash command over native commands", async () => {
    pluginCommandFixtures.specs = [
      { name: "slackplugin", description: "Plugin command", acceptsArgs: false },
    ];
    const configuredHarness = createArgMenusHarness();
    (
      configuredHarness.ctx as {
        slashCommand: { enabled: boolean };
      }
    ).slashCommand.enabled = true;
    const registration = await registerCommands(configuredHarness.ctx, configuredHarness.account);

    expect(registration).toEqual({ mode: "single", name: "openclaw" });
    expect(
      [...configuredHarness.commands.keys()].some(
        (command) => command instanceof RegExp && command.test("/openclaw"),
      ),
    ).toBe(true);
    expect(configuredHarness.commands.has("/usage")).toBe(false);
    expect(retainNativeCatalog).not.toHaveBeenCalled();
  });

  it("does not register native argument handlers for a configured slash command", async () => {
    const configuredHarness = createArgMenusHarness();
    const slashCommand = (
      configuredHarness.ctx as {
        slashCommand: { enabled: boolean; name: string };
      }
    ).slashCommand;
    slashCommand.enabled = true;
    slashCommand.name = "acme";

    await expect(
      registerCommands(configuredHarness.ctx, configuredHarness.account),
    ).resolves.toEqual({ mode: "single", name: "acme" });

    expect(configuredHarness.actions.size).toBe(0);
    expect(configuredHarness.options.size).toBe(0);
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

  it("registers unique plugin commands and silently keeps primary names on collision", async () => {
    pluginCommandFixtures.specs = [
      { name: "slackplugin", description: "Unique plugin command", acceptsArgs: false },
      { name: "reportlong", description: "Colliding plugin command", acceptsArgs: false },
    ];
    const testHarness = createArgMenusHarness();
    const runtimeLog = vi.fn();
    const runtimeError = vi.fn();
    (
      testHarness.ctx as { runtime: { log: typeof runtimeLog; error: typeof runtimeError } }
    ).runtime = { log: runtimeLog, error: runtimeError };

    await registerCommands(testHarness.ctx, testHarness.account);

    expect(testHarness.commands.has("/slackplugin")).toBe(true);
    expect(testHarness.commandRegistrations.filter((name) => name === "/slackplugin")).toHaveLength(
      1,
    );
    expect(testHarness.commandRegistrations.filter((name) => name === "/reportlong")).toHaveLength(
      1,
    );
    expect(runtimeLog).not.toHaveBeenCalled();
    expect(runtimeError).not.toHaveBeenCalled();
    expect(retainNativeCatalog).toHaveBeenCalledOnce();
    expect(retainNativeCatalog).toHaveBeenCalledWith("slack");
  });

  it("executes the exact selected plugin candidate with its native arguments", async () => {
    const execute = vi.fn(async (args?: string) => ({ text: `plugin:${args}` }));
    pluginCommandFixtures.specs = [
      {
        name: "slackplugin",
        description: "Unique plugin command",
        acceptsArgs: true,
        execute,
      },
    ];
    setAsyncDispatchMock(
      async (params) => await dispatchReplyWithBufferedBlockDispatcher(params as never),
    );
    const pluginHarness = createArgMenusHarness();
    await registerCommands(pluginHarness.ctx, pluginHarness.account);
    const handler = requireHandler(pluginHarness.commands, "/slackplugin", "plugin command");

    await handler({
      command: createSlashCommand({ text: "now please" }),
      ack: vi.fn().mockResolvedValue(undefined),
      respond: vi.fn().mockResolvedValue(undefined),
    });

    expect(execute).toHaveBeenCalledWith("now please");
  });

  it.each(["login", "reportlong"])(
    "does not execute a plugin skipped behind the primary /%s command",
    async (name) => {
      const execute = vi.fn(async () => ({ text: "wrong owner" }));
      pluginCommandFixtures.specs = [
        { name, description: "Skipped plugin", acceptsArgs: false, execute },
      ];
      setAsyncDispatchMock(
        async (params) => await dispatchReplyWithBufferedBlockDispatcher(params as never),
      );
      const collisionHarness = createArgMenusHarness();
      await registerCommands(collisionHarness.ctx, collisionHarness.account);
      const handler = requireHandler(collisionHarness.commands, `/${name}`, `${name} command`);

      await runCommandHandler(handler);

      expect(execute).not.toHaveBeenCalled();
      expect(retainNativeCatalog).not.toHaveBeenCalled();
    },
  );

  it("filters a same-name plugin owned by another channel", async () => {
    const execute = vi.fn(async () => ({ text: "wrong channel" }));
    pluginCommandFixtures.specs = [
      {
        name: "reportlong",
        description: "Telegram-only plugin",
        acceptsArgs: false,
        channels: ["telegram"],
        execute,
      },
    ];
    const channelHarness = createArgMenusHarness();
    await registerCommands(channelHarness.ctx, channelHarness.account);

    await runCommandHandler(
      requireHandler(channelHarness.commands, "/reportlong", "report command"),
    );

    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    ["same name", "skill-only"],
    ["dash/underscore", "foo-bar"],
  ])("keeps the selected route skill for a %s plugin collision", async (_label, pluginName) => {
    const skillName = pluginName === "foo-bar" ? "foo_bar" : pluginName;
    skillCommandFixtures.commands = [
      { name: skillName, skillName: "Selected Skill", description: "Selected skill" },
    ];
    const execute = vi.fn(async () => ({ text: "wrong owner" }));
    pluginCommandFixtures.specs = [
      { name: pluginName, description: "Colliding plugin", acceptsArgs: false, execute },
    ];
    const skillHarness = createArgMenusHarness({ commands: { native: true, nativeSkills: true } });
    (skillHarness.account as { config: OpenClawConfig }).config = {
      commands: { native: true, nativeSkills: true },
    };
    await registerCommands(skillHarness.ctx, skillHarness.account);

    await runCommandHandler(
      requireHandler(skillHarness.commands, `/${skillName}`, "skill command"),
    );

    expect(execute).not.toHaveBeenCalled();
  });

  it("deduplicates a skill after the Slack status native rename", async () => {
    skillCommandFixtures.commands = [
      {
        name: "agentstatus",
        skillName: "Agent Status Skill",
        description: "Skill agent status",
      },
    ];
    const config: OpenClawConfig = { commands: { native: true, nativeSkills: true } };
    const testHarness = createArgMenusHarness(config);
    (testHarness.account as { config: OpenClawConfig }).config = config;

    await registerCommands(testHarness.ctx, testHarness.account);

    expect(testHarness.commandRegistrations.filter((name) => name === "/agentstatus")).toHaveLength(
      1,
    );
  });

  it.each([
    { agentRuntime: "codex", includesUltra: false },
    { agentRuntime: "openclaw", includesUltra: true },
  ] as const)(
    "renders runtime-specific /think choices for $agentRuntime",
    async ({ agentRuntime, includesUltra }) => {
      const testHarness = createArgMenusHarness({
        commands: { native: true, nativeSkills: false },
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.6-luna" },
            models: {
              "openai/gpt-5.6-luna": { agentRuntime: { id: agentRuntime } },
            },
          },
        },
      });
      await registerCommands(testHarness.ctx, testHarness.account);
      const handler = requireHandler(testHarness.commands, "/think", "/think");

      const values = await getCommandArgMenuValues(handler);

      expect(values.length).toBeGreaterThan(0);
      expect(values.includes("ultra")).toBe(includesUltra);
    },
  );

  it("falls back to static menus when app.options() throws during registration", async () => {
    const testHarness = createArgMenusHarness();
    const runtimeLog = vi.fn();
    (testHarness.ctx as { runtime: { log: typeof runtimeLog } }).runtime = { log: runtimeLog };
    testHarness.app.options = () => {
      throw new Error("Cannot read properties of undefined (reading 'listeners')");
    };

    // Registration should not throw despite app.options() throwing
    await registerCommands(testHarness.ctx, testHarness.account);
    expect(testHarness.commands.size).toBeGreaterThan(0);
    expect(runtimeLog).toHaveBeenCalledTimes(1);
    expect(runtimeLog).toHaveBeenCalledWith(
      expect.stringContaining(
        "slack: external arg-menu registration failed; falling back to static slash command menus.",
      ),
    );
    expect(
      Array.from(testHarness.actions.keys()).some(
        (key) => key instanceof RegExp && String(key) === String(/^openclaw_cmdarg/),
      ),
    ).toBe(true);

    // The /reportexternal command (140 choices) should fall back to static_select
    // instead of external_select since options registration failed
    const handler = requireHandler(testHarness.commands, "/reportexternal", "/reportexternal");
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
    const { respond } = await runCommandHandler(toolsHandler);
    const actions = expectArgMenuLayout(respond);
    const elementType = actions?.elements?.[0]?.type;
    expect(elementType).toBe("button");
    expect(actions?.elements?.[0]?.action_id).toBe("openclaw_cmdarg_0_0");
    expect(actions?.elements?.[1]?.action_id).toBe("openclaw_cmdarg_0_1");
    expect(actions?.elements?.[0]).toHaveProperty("confirm");
  });

  it("shows a static_select menu when choices exceed button row size", async () => {
    const { respond } = await runCommandHandler(ttsHandler);
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
    const element = await getFirstActionElementFromCommand(usageHandler);
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
        value: encodeValue({ command: "tools", arg: "mode", value: "compact", userId: "U1" }),
      },
    });

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const call = firstDispatchArg() as { ctx?: { Body?: string } };
    expect(call.ctx?.Body).toBe("/tools compact");
  });

  it("keeps the Enterprise Grid team on deferred argument-menu actions", async () => {
    const enterpriseHarness = createArgMenusHarness(
      { commands: { native: true, nativeSkills: false } },
      {
        installationIdentity: { kind: "enterprise", enterpriseId: "EGRID" },
        teamId: "TGRID1",
      },
    );
    await registerCommands(enterpriseHarness.ctx, enterpriseHarness.account);
    const enterpriseArgMenuHandler = requireHandler(
      enterpriseHarness.actions,
      /^openclaw_cmdarg/,
      "Enterprise arg-menu action",
    );

    await runArgMenuAction(enterpriseArgMenuHandler, {
      action: {
        value: encodeValue({ command: "tools", arg: "mode", value: "compact", userId: "U1" }),
      },
    });

    expect(getSlackSlashMocks().resolveAgentRouteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: "TGRID1",
        peer: { kind: "direct", id: "team:TGRID1:user:U1" },
      }),
    );
    expect(firstDispatchArg().ctx?.OriginatingTo).toBe("team:TGRID1:user:U1");
  });

  it("does not apply the response_url call cap to Web API action replies", async () => {
    mockSixDispatchedReplies();

    await runArgMenuAction(argMenuHandler, {
      action: {
        value: encodeValue({ command: "usage", arg: "mode", value: "tokens", userId: "U1" }),
      },
      includeRespond: false,
    });

    expect(harness.postEphemeral).toHaveBeenCalledTimes(6);
  });

  it("keeps table fallback tokens literal in Web API action replies", async () => {
    const tableFallback = "Account\tOwner\nprod\t<@U123> & <!channel>";
    const { deliverSlackSlashRepliesMock } = getSlackSlashMocks();
    deliverSlackSlashRepliesMock.mockImplementation(async (params: unknown) => {
      const responseBudget = (
        params as {
          responseBudget: {
            respond: (payload: { text: string; mrkdwn?: false }) => Promise<unknown>;
          };
        }
      ).responseBudget;
      await responseBudget.respond({ text: tableFallback, mrkdwn: false });
    });
    dispatchMock.mockImplementation((params: unknown) => {
      const deliver = (
        params as {
          dispatcherOptions: {
            deliver: (payload: { text: string }, info: { kind: "final" }) => Promise<void>;
          };
        }
      ).dispatcherOptions.deliver;
      void deliver({ text: "table reply" }, { kind: "final" });
      return { counts: { final: 1, tool: 0, block: 0 } };
    });

    await runArgMenuAction(argMenuHandler, {
      action: {
        value: encodeValue({ command: "usage", arg: "mode", value: "tokens", userId: "U1" }),
      },
      includeRespond: false,
    });

    expect(harness.postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({ text: tableFallback, mrkdwn: false }),
    );
  });

  it("keeps the response_url call cap on action responders", async () => {
    mockSixDispatchedReplies();

    const respond = await runArgMenuAction(argMenuHandler, {
      action: {
        value: encodeValue({ command: "usage", arg: "mode", value: "tokens", userId: "U1" }),
      },
    });

    expect(respond).toHaveBeenCalledTimes(5);
    expect(harness.postEphemeral).not.toHaveBeenCalled();
  });

  it("keeps the response_url call cap on actual slash command replies", async () => {
    mockSixDispatchedReplies();

    const { respond } = await runCommandHandler(agentStatusHandler);

    expect(respond).toHaveBeenCalledTimes(5);
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
          value: encodeValue({ command: "tts", arg: "action", value: "status", userId: "U1" }),
        },
      },
    });

    expectSingleDispatchedSlashBody("/tts status");
  });

  it("dispatches the command when an overflow option is chosen", async () => {
    await runArgMenuAction(argMenuHandler, {
      action: {
        selected_option: {
          value: encodeValue({
            command: "usage",
            arg: "mode",
            value: "cost",
            userId: "U1",
          }),
        },
      },
    });

    expectSingleDispatchedSlashBody("/usage cost");
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

  it("truncates served option labels on a surrogate boundary", async () => {
    const { blockId } = await runCommandAndResolveActionsBlock(reportExternalHandler);
    expect(blockId).toContain("openclaw_cmdarg_ext:");

    const ackOptions = vi.fn().mockResolvedValue(undefined);
    await argMenuOptionsHandler({
      ack: ackOptions,
      body: {
        user: { id: "U1" },
        value: "emojioverflow",
        actions: [{ block_id: blockId }],
      },
    });

    const optionsPayload = firstCallPayload(ackOptions, "options ack") as {
      options?: Array<{ text?: { text?: string }; value?: string }>;
    };
    // The "emojioverflow" query matches only the long emoji label, so exactly one
    // option is served.
    const served = optionsPayload.options ?? [];
    expect(served).toHaveLength(1);
    const text = served[0]?.text?.text ?? "";
    // Plain_text option labels are capped at 75 chars and must not end on a lone
    // surrogate half, which Slack rejects. The label was long enough to truncate.
    expect(text.length).toBeGreaterThan(0);
    expect(text.length).toBeLessThanOrEqual(75);
    expect(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text),
    ).toBe(false);
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
  slashEphemeral?: boolean;
  slashCommandEnabled?: boolean;
  slashCommandName?: string;
  teamId?: string;
  installationIdentity?:
    | { kind: "workspace"; teamId: string }
    | { kind: "enterprise"; enterpriseId: string };
  shouldDropMismatchedSlackEvent?: (body: unknown) => boolean;
  resolveChannelName?: () => Promise<{ name?: string; type?: string }>;
}) {
  const commands = new Map<unknown, (args: unknown) => Promise<void>>();
  const postEphemeral = vi.fn().mockResolvedValue({ ok: true });
  const listenerClient = { chat: { postEphemeral } };
  const installationIdentity = overrides?.installationIdentity ?? {
    kind: "workspace" as const,
    teamId: overrides?.teamId ?? "T1",
  };
  const boltContext =
    installationIdentity.kind === "enterprise"
      ? {
          teamId: overrides?.teamId,
          enterpriseId: installationIdentity.enterpriseId,
          isEnterpriseInstall: true,
        }
      : { teamId: installationIdentity.teamId, isEnterpriseInstall: false };
  const app = {
    client: listenerClient,
    command: (name: unknown, handler: (args: unknown) => Promise<void>) => {
      commands.set(name, async (args) => {
        const typed = args as { context?: Record<string, unknown>; client?: unknown };
        await handler({
          ...typed,
          context: { ...boltContext, ...typed.context },
          client: typed.client ?? listenerClient,
        });
      });
    },
  };

  const channelId = overrides?.channelId ?? "C_UNLISTED";
  const channelName = overrides?.channelName ?? "unlisted";

  const ctx = {
    cfg: { commands: { native: false } },
    runtime: {},
    botToken: "bot-token",
    botUserId: "bot",
    teamId: installationIdentity.kind === "enterprise" ? "" : installationIdentity.teamId,
    installationIdentity,
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
      enabled: overrides?.slashCommandEnabled ?? true,
      name: overrides?.slashCommandName ?? "openclaw",
      ephemeral: overrides?.slashEphemeral ?? true,
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

describe("Slack App Home command presentation", () => {
  it("returns the configured single command when it is registered", async () => {
    const harness = createPolicyHarness({ slashCommandName: "acme" });

    await expect(registerCommands(harness.ctx, harness.account)).resolves.toEqual({
      mode: "single",
      name: "acme",
    });
    expect(harness.commands.size).toBe(1);
  });

  it("omits the single command when slash commands are disabled", async () => {
    const harness = createPolicyHarness({ slashCommandEnabled: false });

    await expect(registerCommands(harness.ctx, harness.account)).resolves.toEqual({
      mode: "disabled",
    });
    expect(harness.commands.size).toBe(0);
  });

  it("omits the single command when native commands take precedence", async () => {
    const harness = createArgMenusHarness();

    await expect(registerCommands(harness.ctx, harness.account)).resolves.toEqual({
      mode: "native",
    });
    expect(harness.commands.size).toBeGreaterThan(0);
  });
});

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

  it.each<{
    name: string;
    policy: NonNullable<Parameters<typeof createPolicyHarness>[0]>;
    blocked: boolean;
  }>([
    {
      name: "allows unlisted channels when groupPolicy is open",
      policy: {
        groupPolicy: "open",
        channelsConfig: { C_LISTED: { requireMention: true } },
        channelId: "C_UNLISTED",
        channelName: "unlisted",
      },
      blocked: false,
    },
    {
      name: "blocks explicitly denied channels when groupPolicy is open",
      policy: {
        groupPolicy: "open",
        channelsConfig: { C_DENIED: { enabled: false } },
        channelId: "C_DENIED",
        channelName: "denied",
      },
      blocked: true,
    },
    {
      name: "blocks unlisted channels when groupPolicy is allowlist",
      policy: {
        groupPolicy: "allowlist",
        channelsConfig: { C_LISTED: { requireMention: true } },
        channelId: "C_UNLISTED",
        channelName: "unlisted",
      },
      blocked: true,
    },
  ])("$name", async ({ policy, blocked }) => {
    const harness = createPolicyHarness(policy);
    const { respond } = await registerAndRunPolicySlash({ harness });

    if (blocked) {
      expectChannelBlockedResponse(respond);
      return;
    }
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(responseTexts(respond)).not.toContain("This channel is not allowed.");
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

  it.each([
    {
      name: "blocks MPIM slash commands from senders outside the configured allowFrom",
      userId: "U_ATTACKER",
      allowed: false,
    },
    {
      name: "allows MPIM slash commands from senders in the configured allowFrom",
      userId: "U_OWNER",
      allowed: true,
    },
  ])("$name", async ({ userId, allowed }) => {
    const harness = createPolicyHarness({
      allowFrom: ["U_OWNER"],
      channelId: "G_MPIM",
      channelName: "group-dm",
      resolveChannelName: async () => ({ name: "group-dm", type: "mpim" }),
      ...(!allowed ? { useAccessGroups: false } : {}),
    });
    const { respond } = await registerAndRunPolicySlash({
      harness,
      command: { user_id: userId },
    });

    if (!allowed) {
      expect(dispatchMock).not.toHaveBeenCalled();
      expect(respond).toHaveBeenCalledWith({
        text: "You are not authorized to use this command here.",
        response_type: "ephemeral",
      });
      return;
    }
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(responseTexts(respond)).not.toContain(
      "You are not authorized to use this command here.",
    );
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
  const { deliverSlackSlashRepliesMock, recordSessionMetaFromInboundMock, resolveAgentRouteMock } =
    getSlackSlashMocks();

  it("refreshes slash routing config between invocations", async () => {
    const harness = createPolicyHarness({
      channelId: "D123",
      channelName: "directmessage",
      resolveChannelName: async () => ({ name: "directmessage", type: "im" }),
    });
    const sourceCfg = (harness.ctx as { cfg: OpenClawConfig }).cfg;
    const runtimeCfg = {
      ...sourceCfg,
      session: { dmScope: "per-channel-peer" },
    } as OpenClawConfig;
    resolveAgentRouteMock.mockImplementation((params: { cfg: OpenClawConfig }) => ({
      agentId: "main",
      accountId: "acct",
      sessionKey:
        params.cfg.session?.dmScope === "per-channel-peer"
          ? "agent:main:slack:direct:U1"
          : "agent:main:main",
    }));
    await registerCommands(harness.ctx, harness.account);

    await runSlashHandler({
      commands: harness.commands,
      command: {
        channel_id: harness.channelId,
        channel_name: harness.channelName,
      },
    });
    setRuntimeConfigSnapshot(runtimeCfg, runtimeCfg);
    await runSlashHandler({
      commands: harness.commands,
      command: {
        channel_id: harness.channelId,
        channel_name: harness.channelName,
      },
    });

    expect(dispatchMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        ctx: expect.objectContaining({ CommandTargetSessionKey: "agent:main:main" }),
      }),
    );
    expect(dispatchMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        ctx: expect.objectContaining({
          CommandTargetSessionKey: "agent:main:slack:direct:U1",
        }),
      }),
    );
  });

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

  it("partitions Enterprise Grid slash sessions and replies by event team", async () => {
    const harness = createPolicyHarness({
      groupPolicy: "open",
      slashEphemeral: false,
      installationIdentity: { kind: "enterprise", enterpriseId: "EGRID" },
      teamId: "TGRID1",
      channelId: "CGRID1",
      channelName: "grid",
    });

    await registerAndRunPolicySlash({ harness });

    expect(resolveAgentRouteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: "TGRID1",
        peer: { kind: "channel", id: "team:TGRID1:channel:CGRID1" },
      }),
    );
    expect(firstDispatchArg().ctx).toMatchObject({
      From: "slack:channel:team:TGRID1:channel:CGRID1",
      To: "slash:team:TGRID1:user:U1",
      OriginatingTo: "team:TGRID1:channel:CGRID1",
      SessionKey: expect.stringContaining("team:tgrid1:user:u1"),
    });
  });

  it("passes canonical hook correlation to slash reply delivery", async () => {
    dispatchMock.mockImplementation((params: unknown) => {
      const deliver = (
        params as {
          dispatcherOptions: {
            deliver: (payload: { text: string }, info: { kind: "final" }) => Promise<void>;
          };
        }
      ).dispatcherOptions.deliver;
      void deliver({ text: "final answer" }, { kind: "final" });
      void deliver({ text: "second answer" }, { kind: "final" });
      return { counts: { final: 2, tool: 0, block: 0 } };
    });
    const harness = createPolicyHarness({ groupPolicy: "open" });
    await registerAndRunPolicySlash({ harness });
    const dispatchArg = firstDispatchArg() as {
      ctx?: { OriginatingTo?: string; SessionKey?: string };
    };
    const responseBudget = (
      deliverSlackSlashRepliesMock.mock.calls.at(-1)?.[0] as
        | { responseBudget?: unknown }
        | undefined
    )?.responseBudget;

    expect(deliverSlackSlashRepliesMock).toHaveBeenCalledOnce();
    expect(deliverSlackSlashRepliesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [{ text: "final answer" }, { text: "second answer" }],
        messageSentHookTarget: dispatchArg.ctx?.OriginatingTo,
        sessionKeyForInternalHooks: dispatchArg.ctx?.SessionKey,
        accountId: "acct",
        isGroup: true,
        groupId: harness.channelId,
      }),
    );
    expect(responseBudget).toBeDefined();
  });

  it("targets the channel for public slash reply hooks", async () => {
    dispatchMock.mockImplementation((params: unknown) => {
      const deliver = (
        params as {
          dispatcherOptions: {
            deliver: (payload: { text: string }, info: { kind: "final" }) => Promise<void>;
          };
        }
      ).dispatcherOptions.deliver;
      void deliver({ text: "public answer" }, { kind: "final" });
      return { counts: { final: 1, tool: 0, block: 0 } };
    });
    const harness = createPolicyHarness({
      groupPolicy: "open",
      slashEphemeral: false,
    });
    await registerAndRunPolicySlash({ harness });

    expect(firstDispatchArg().ctx?.OriginatingTo).toBe(`channel:${harness.channelId}`);
    expect(deliverSlackSlashRepliesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        messageSentHookTarget: `channel:${harness.channelId}`,
        isGroup: true,
        groupId: harness.channelId,
      }),
    );
  });

  it("starts routed session metadata recording before dispatch without blocking delivery", async () => {
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
    await vi.waitFor(() => {
      expect(dispatchMock).toHaveBeenCalledTimes(1);
    });

    deferred.resolve();
    await runPromise;
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
