import fs from "node:fs";
import path from "node:path";
import type { ChannelRuntimeSurface } from "openclaw/plugin-sdk/channel-contract";
// Slack helper module supports monitor helpers behavior.
import { closeOpenClawStateDatabaseForTest } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { vi } from "vitest";
import type { Mock } from "vitest";

type SlackHandler = (args: unknown) => Promise<void>;
type SlackMiddleware = (args: { next: () => Promise<void> } & Record<string, unknown>) => unknown;
type SlackProviderMonitor = (params: {
  botToken: string;
  appToken: string;
  abortSignal: AbortSignal;
  config?: Record<string, unknown>;
  channelRuntime?: ChannelRuntimeSurface;
  runtime?: RuntimeEnv;
  setStatus?: (next: Record<string, unknown>) => void;
}) => Promise<unknown>;
type SlackStartupAuthClientFactory = typeof import("./client.js").createSlackStartupAuthClient;

const SLACK_INGRESS_LIFECYCLE_CONTEXT_KEY = "openclawIngressLifecycle";

type SlackRunOnceOptions = {
  botToken?: string;
  appToken?: string;
  awaitDispatch?: boolean;
};

function withSlackDispatchLifecycle(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Slack event arguments must be an object");
  }
  const eventArgs = args as Record<string, unknown>;
  const existingContext =
    eventArgs.context && typeof eventArgs.context === "object" && !Array.isArray(eventArgs.context)
      ? (eventArgs.context as Record<string, unknown>)
      : {};
  return {
    ...eventArgs,
    context: {
      ...existingContext,
      [SLACK_INGRESS_LIFECYCLE_CONTEXT_KEY]: {
        admission: "exclusive",
        abortSignal: new AbortController().signal,
        onAdopted: vi.fn(),
        onDeferred: vi.fn(),
        onAbandoned: vi.fn(),
      },
    },
  };
}

type SlackTestState = {
  config: Record<string, unknown>;
  appConstructorArgs?: Record<string, unknown>;
  appStartMock: Mock<(...args: unknown[]) => Promise<unknown>>;
  appStopMock: Mock<(...args: unknown[]) => Promise<unknown>>;
  sendMock: Mock<(...args: unknown[]) => Promise<unknown>>;
  replyMock: Mock<(...args: unknown[]) => unknown>;
  updateLastRouteMock: Mock<(...args: unknown[]) => unknown>;
  reactMock: Mock<(...args: unknown[]) => unknown>;
  reactionAddMock: Mock<(...args: unknown[]) => unknown>;
  reactionRemoveMock: Mock<(...args: unknown[]) => unknown>;
  readAllowFromStoreMock: Mock<(...args: unknown[]) => Promise<unknown>>;
  upsertPairingRequestMock: Mock<(...args: unknown[]) => Promise<unknown>>;
  resolveSlackUserAllowlistMock: Mock<
    (params: { entries: string[] }) => Promise<Array<{ input: string; resolved: boolean }>>
  >;
  socketModeLogger?: { error: (...args: unknown[]) => void };
  createSlackStartupAuthClientMock: Mock<SlackStartupAuthClientFactory>;
  createSlackStartupAuthClientActual?: SlackStartupAuthClientFactory;
};

// globalThis-backed singleton: with isolate=false, a vi.resetModules() in any
// sibling file recreates this module while the cached __slackClient on
// globalThis keeps routing reactions to the OLD instance's mocks — tests then
// assert on fresh mocks that never receive calls. One shared state object
// keeps every module incarnation and the cached client converged.
const slackTestState: SlackTestState = vi.hoisted(() => {
  const globalState = globalThis as { __slackTestState?: SlackTestState };
  globalState["__slackTestState"] ??= {
    config: {} as Record<string, unknown>,
    appConstructorArgs: undefined,
    appStartMock: vi.fn(),
    appStopMock: vi.fn(),
    sendMock: vi.fn(),
    replyMock: vi.fn(),
    updateLastRouteMock: vi.fn(),
    reactMock: vi.fn(),
    reactionAddMock: vi.fn(),
    reactionRemoveMock: vi.fn(),
    readAllowFromStoreMock: vi.fn(),
    upsertPairingRequestMock: vi.fn(),
    resolveSlackUserAllowlistMock: vi.fn(),
    socketModeLogger: undefined,
    createSlackStartupAuthClientMock: vi.fn(),
  } as SlackTestState;
  return globalState["__slackTestState"];
});

export const getSlackTestState = (): SlackTestState => slackTestState;

export function useRealSlackStartupAuthClientOnce(): void {
  const actual = slackTestState.createSlackStartupAuthClientActual;
  if (!actual) {
    throw new Error("real Slack WebClient factory is unavailable");
  }
  slackTestState.createSlackStartupAuthClientMock.mockImplementationOnce(actual);
}

type SlackClient = {
  auth: { test: Mock<(...args: unknown[]) => Promise<Record<string, unknown>>> };
  conversations: {
    info: Mock<(...args: unknown[]) => Promise<Record<string, unknown>>>;
    replies: Mock<(...args: unknown[]) => Promise<Record<string, unknown>>>;
    history: Mock<(...args: unknown[]) => Promise<Record<string, unknown>>>;
  };
  users: {
    info: Mock<(...args: unknown[]) => Promise<{ user: { profile: { display_name: string } } }>>;
  };
  assistant: {
    threads: {
      setStatus: Mock<(...args: unknown[]) => Promise<{ ok: boolean }>>;
    };
  };
  reactions: {
    add: (...args: unknown[]) => unknown;
    remove: (...args: unknown[]) => unknown;
  };
};

export const getSlackHandlers = () => ensureSlackTestRuntime().handlers;

export const getSlackClient = () => ensureSlackTestRuntime().client;

export function disposeSlackTestRuntime(): void {
  const globalState = globalThis as {
    __slackHandlers?: Map<string, SlackHandler>;
    __slackClient?: SlackClient;
  };
  Reflect.deleteProperty(globalState, "__slackHandlers");
  Reflect.deleteProperty(globalState, "__slackClient");
}

function ensureSlackTestRuntime(): {
  handlers: Map<string, SlackHandler>;
  client: SlackClient;
} {
  const globalState = globalThis as {
    __slackHandlers?: Map<string, SlackHandler>;
    __slackClient?: SlackClient;
  };
  if (!globalState["__slackHandlers"]) {
    globalState["__slackHandlers"] = new Map<string, SlackHandler>();
  }
  if (!globalState["__slackClient"]) {
    globalState["__slackClient"] = {
      auth: { test: vi.fn().mockResolvedValue({ user_id: "bot-user", bot_id: "bot-id" }) },
      conversations: {
        info: vi.fn().mockResolvedValue({
          channel: { name: "dm", is_im: true },
        }),
        replies: vi.fn().mockResolvedValue({ messages: [] }),
        history: vi.fn().mockResolvedValue({ messages: [] }),
      },
      users: {
        info: vi.fn().mockResolvedValue({
          user: { profile: { display_name: "Ada" } },
        }),
      },
      assistant: {
        threads: {
          setStatus: vi.fn().mockResolvedValue({ ok: true }),
        },
      },
      reactions: {
        add: () => undefined,
        remove: () => undefined,
      },
    };
  }
  const client = globalState["__slackClient"];
  // The non-isolated Slack lane keeps this global client across file-level module resets.
  // Rebind delegates so reaction assertions always target the current file's hoisted mocks.
  client.reactions = {
    add: (...args: unknown[]) => {
      slackTestState.reactionAddMock(...args);
      return slackTestState.reactMock(...args);
    },
    remove: (...args: unknown[]) => {
      slackTestState.reactionRemoveMock(...args);
      return slackTestState.reactMock(...args);
    },
  };
  return {
    handlers: globalState["__slackHandlers"],
    client,
  };
}

export const flush = () =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

async function waitForSlackEvent(name: string) {
  for (let i = 0; i < 10; i += 1) {
    if (getSlackHandlers()?.has(name)) {
      return;
    }
    await flush();
  }
}

export function startSlackMonitor(
  monitorSlackProvider: SlackProviderMonitor,
  opts?: {
    botToken?: string;
    appToken?: string;
    channelRuntime?: ChannelRuntimeSurface;
    runtime?: RuntimeEnv;
    setStatus?: (next: Record<string, unknown>) => void;
  },
) {
  const controller = new AbortController();
  const run = monitorSlackProvider({
    botToken: opts?.botToken ?? "bot-token",
    appToken: opts?.appToken ?? "app-token",
    abortSignal: controller.signal,
    config: slackTestState.config,
    channelRuntime: opts?.channelRuntime,
    runtime: opts?.runtime,
    setStatus: opts?.setStatus,
  });
  return { controller, run };
}

export async function getSlackHandlerOrThrow(name: string) {
  await waitForSlackEvent(name);
  const handler = getSlackHandlers()?.get(name);
  if (!handler) {
    throw new Error(`Slack ${name} handler not registered`);
  }
  return handler;
}

export async function stopSlackMonitor(params: {
  controller: AbortController;
  run: Promise<unknown>;
}) {
  await flush();
  params.controller.abort();
  await params.run;
  // A stopped provider's handlers must not satisfy the next start's
  // waitForSlackEvent — see the reset-time clear above.
  (globalThis as { __slackHandlers?: Map<string, SlackHandler> })["__slackHandlers"]?.clear();
}

async function runSlackEventOnce(
  monitorSlackProvider: SlackProviderMonitor,
  name: string,
  args: unknown,
  opts?: SlackRunOnceOptions,
) {
  const { controller, run } = startSlackMonitor(monitorSlackProvider, opts);
  const handler = await getSlackHandlerOrThrow(name);
  // Normal Bolt handlers return after queue admission. Terminal-state tests use the
  // durable-ingress lifecycle so this helper can await the actual dispatch boundary.
  const handlerArgs = opts?.awaitDispatch ? withSlackDispatchLifecycle(args) : args;
  try {
    await handler(handlerArgs);
  } finally {
    await stopSlackMonitor({ controller, run });
  }
}

export async function runSlackMessageOnce(
  monitorSlackProvider: SlackProviderMonitor,
  args: unknown,
  opts?: SlackRunOnceOptions,
) {
  await runSlackEventOnce(monitorSlackProvider, "message", args, opts);
}

export const defaultSlackTestConfig = () => ({
  messages: {
    responsePrefix: "PFX",
    ackReaction: "👀",
    ackReactionScope: "group-mentions",
  },
  channels: {
    slack: {
      dm: { enabled: true, policy: "open", allowFrom: ["*"] },
      groupPolicy: "open",
    },
  },
});

let lastSlackTestStateDir: string | undefined;

export function resetSlackTestState(config: Record<string, unknown> = defaultSlackTestConfig()) {
  // Fresh persistent state per test: the dispatch-dedupe guard writes logical
  // message keys to the state DB, and fixture ts values repeat across tests,
  // so a carried-over DB would dedupe unrelated test messages. realpath keeps
  // macOS /var vs /private/var symlinks out of resolver assertions.
  closeOpenClawStateDatabaseForTest();
  // Clear worker-global Bolt handler registrations from previous test files:
  // with isolate=false a stale "message" handler makes waitForSlackEvent
  // return before THIS test's provider registers, dispatching through the old
  // provider's closure config (reactions silently suppressed, replies fine).
  (globalThis as { __slackHandlers?: Map<string, SlackHandler> })["__slackHandlers"]?.clear();
  if (lastSlackTestStateDir) {
    fs.rmSync(lastSlackTestStateDir, { recursive: true, force: true });
  }
  lastSlackTestStateDir = fs.realpathSync(
    fs.mkdtempSync(path.join(resolvePreferredOpenClawTmpDir(), "openclaw-slack-monitor-state-")),
  );
  process.env.OPENCLAW_STATE_DIR = lastSlackTestStateDir;
  slackTestState.config = config;
  slackTestState.appConstructorArgs = undefined;
  slackTestState.socketModeLogger = undefined;
  slackTestState.appStartMock.mockReset().mockResolvedValue(undefined);
  slackTestState.appStopMock.mockReset().mockResolvedValue(undefined);
  slackTestState.sendMock.mockReset().mockResolvedValue(undefined);
  slackTestState.replyMock.mockReset();
  slackTestState.updateLastRouteMock.mockReset();
  slackTestState.reactMock.mockReset();
  slackTestState.reactionAddMock.mockReset();
  slackTestState.reactionRemoveMock.mockReset();
  slackTestState.readAllowFromStoreMock.mockReset().mockResolvedValue([]);
  slackTestState.upsertPairingRequestMock.mockReset().mockResolvedValue({
    code: "PAIRCODE",
    created: true,
  });
  slackTestState.resolveSlackUserAllowlistMock
    .mockReset()
    .mockImplementation(async ({ entries }) =>
      entries.map((input) => ({ input, resolved: false })),
    );
  slackTestState.createSlackStartupAuthClientMock
    .mockReset()
    .mockReturnValue(getSlackClient() as unknown as ReturnType<SlackStartupAuthClientFactory>);
  const client = getSlackClient();
  client.auth.test.mockReset().mockResolvedValue({
    user_id: "bot-user",
    bot_id: "bot-id",
    app_id: "A_TEST",
    team_id: "T_TEST",
    is_enterprise_install: false,
  });
  client.conversations.info.mockReset().mockResolvedValue({
    channel: { name: "dm", is_im: true },
  });
  client.conversations.replies.mockReset().mockResolvedValue({ messages: [] });
  client.conversations.history.mockReset().mockResolvedValue({ messages: [] });
  client.users.info.mockReset().mockResolvedValue({
    user: { profile: { display_name: "Ada" } },
  });
  client.assistant.threads.setStatus.mockReset().mockResolvedValue({ ok: true });
  getSlackHandlers()?.clear();
}

vi.mock("./monitor/config.runtime.js", async () => {
  const actual = await vi.importActual<typeof import("./monitor/config.runtime.js")>(
    "./monitor/config.runtime.js",
  );
  return {
    ...actual,
    loadConfig: () => slackTestState.config,
    readSessionUpdatedAt: vi.fn(() => undefined),
    recordSessionMetaFromInbound: vi.fn().mockResolvedValue(undefined),
    resolveStorePath: vi.fn(() => "/tmp/openclaw-sessions.json"),
    updateLastRoute: (...args: unknown[]) => slackTestState.updateLastRouteMock(...args),
  };
});

vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>();
  type DispatchParams = Parameters<typeof actual.dispatchChannelInboundTurn>[0];
  type ReplyResolver = NonNullable<DispatchParams["replyResolver"]>;
  const replyResolver: ReplyResolver = (...args) =>
    slackTestState.replyMock(...args) as ReturnType<ReplyResolver>;
  return {
    ...actual,
    dispatchChannelInboundTurn: (params: DispatchParams) =>
      actual.dispatchChannelInboundTurn({ ...params, replyResolver }),
  };
});

vi.mock("./resolve-channels.js", () => ({
  resolveSlackChannelAllowlist: async ({ entries }: { entries: string[] }) =>
    entries.map((input) => ({ input, resolved: false })),
}));

vi.mock("./resolve-users.js", () => ({
  resolveSlackUserAllowlist: (params: { entries: string[] }) =>
    slackTestState.resolveSlackUserAllowlistMock(params),
}));

vi.mock("./client.js", async () => {
  const actual = await vi.importActual<typeof import("./client.js")>("./client.js");
  slackTestState.createSlackStartupAuthClientActual = actual.createSlackStartupAuthClient;
  return {
    ...actual,
    createSlackStartupAuthClient: (...args: Parameters<SlackStartupAuthClientFactory>) =>
      slackTestState.createSlackStartupAuthClientMock(...args),
  };
});

vi.mock("./monitor/send.runtime.js", () => {
  return {
    sendMessageSlack: (...args: unknown[]) => slackTestState.sendMock(...args),
  };
});

vi.mock("./monitor/conversation.runtime.js", async () => {
  const actual = await vi.importActual<typeof import("./monitor/conversation.runtime.js")>(
    "./monitor/conversation.runtime.js",
  );
  return {
    ...actual,
    readChannelAllowFromStore: (...args: unknown[]) =>
      slackTestState.readAllowFromStoreMock(...args),
    upsertChannelPairingRequest: (...args: unknown[]) =>
      slackTestState.upsertPairingRequestMock(...args),
  };
});

vi.mock("@slack/bolt", () => {
  const { handlers, client: slackClient } = ensureSlackTestRuntime();
  class App {
    client = slackClient;
    receiver: unknown;
    middlewares: SlackMiddleware[] = [];

    constructor(args?: Record<string, unknown>) {
      slackTestState.appConstructorArgs = args;
      this.receiver = args?.receiver;
    }
    use(middleware: SlackMiddleware) {
      this.middlewares.push(middleware);
    }
    event(name: string, handler: SlackHandler) {
      handlers.set(name, async (args: unknown) => {
        const eventArgs =
          args && typeof args === "object" && !Array.isArray(args)
            ? (args as Record<string, unknown>)
            : {};
        const run = async (index: number): Promise<void> => {
          const middleware = this.middlewares[index];
          if (!middleware) {
            await handler(args);
            return;
          }
          await middleware({
            ...eventArgs,
            next: () => run(index + 1),
          });
        };
        await run(0);
      });
    }
    command() {
      /* no-op */
    }
    start = (...args: unknown[]) => slackTestState.appStartMock(...args);
    stop = (...args: unknown[]) => slackTestState.appStopMock(...args);
  }
  class HTTPReceiver {
    requestListener = vi.fn();
  }
  class SocketModeReceiver {
    client = {
      ...slackClient,
      on: vi.fn(),
      off: vi.fn(),
    };

    constructor(args: { logger?: { error: (...args: unknown[]) => void } }) {
      slackTestState.socketModeLogger = args.logger;
    }
  }
  return {
    App,
    HTTPReceiver,
    SocketModeReceiver,
    default: { App, HTTPReceiver, SocketModeReceiver },
  };
});
