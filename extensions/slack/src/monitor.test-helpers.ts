import { Mock, vi } from "vitest";

type SlackHandler = (args: unknown) => Promise<void>;
type SlackMiddleware = (args: { next: () => Promise<void> } & Record<string, unknown>) => unknown;
type SlackProviderMonitor = (params: {
  botToken: string;
  appToken: string;
  abortSignal: AbortSignal;
  config?: Record<string, unknown>;
}) => Promise<unknown>;

type SlackTestState = {
  config: Record<string, unknown>;
  sendMock: Mock<(...args: unknown[]) => Promise<unknown>>;
  replyMock: Mock<(...args: unknown[]) => unknown>;
  updateLastRouteMock: Mock<(...args: unknown[]) => unknown>;
  reactMock: Mock<(...args: unknown[]) => unknown>;
  readAllowFromStoreMock: Mock<(...args: unknown[]) => Promise<unknown>>;
  upsertPairingRequestMock: Mock<(...args: unknown[]) => Promise<unknown>>;
};

const slackTestState: SlackTestState = vi.hoisted(() => ({
  config: {} as Record<string, unknown>,
  sendMock: vi.fn(),
  replyMock: vi.fn(),
  updateLastRouteMock: vi.fn(),
  reactMock: vi.fn(),
  readAllowFromStoreMock: vi.fn(),
  upsertPairingRequestMock: vi.fn(),
}));

export const getSlackTestState = (): SlackTestState => slackTestState;

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

function ensureSlackTestRuntime(): {
  handlers: Map<string, SlackHandler>;
  client: SlackClient;
} {
  const globalState = globalThis as {
    __slackHandlers?: Map<string, SlackHandler>;
    __slackClient?: SlackClient;
  };
  if (!globalState.__slackHandlers) {
    globalState.__slackHandlers = new Map<string, SlackHandler>();
  }
  if (!globalState.__slackClient) {
    globalState.__slackClient = {
      auth: { test: vi.fn().mockResolvedValue({ user_id: "bot-user" }) },
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
        add: (...args: unknown[]) => slackTestState.reactMock(...args),
        remove: (...args: unknown[]) => slackTestState.reactMock(...args),
      },
    };
  }
  return {
    handlers: globalState.__slackHandlers,
    client: globalState.__slackClient,
  };
}

export const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

export async function waitForSlackEvent(name: string) {
  for (let i = 0; i < 10; i += 1) {
    if (getSlackHandlers()?.has(name)) {
      return;
    }
    await flush();
  }
}

export function startSlackMonitor(
  monitorSlackProvider: SlackProviderMonitor,
  opts?: { botToken?: string; appToken?: string },
) {
  const controller = new AbortController();
  const run = monitorSlackProvider({
    botToken: opts?.botToken ?? "bot-token",
    appToken: opts?.appToken ?? "app-token",
    abortSignal: controller.signal,
    config: slackTestState.config,
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
}

export async function runSlackEventOnce(
  monitorSlackProvider: SlackProviderMonitor,
  name: string,
  args: unknown,
  opts?: { botToken?: string; appToken?: string },
) {
  const { controller, run } = startSlackMonitor(monitorSlackProvider, opts);
  const handler = await getSlackHandlerOrThrow(name);
  await handler(args);
  await stopSlackMonitor({ controller, run });
}

export async function runSlackMessageOnce(
  monitorSlackProvider: SlackProviderMonitor,
  args: unknown,
  opts?: { botToken?: string; appToken?: string },
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

export function resetSlackTestState(config: Record<string, unknown> = defaultSlackTestConfig()) {
  slackTestState.config = config;
  slackTestState.sendMock.mockReset().mockResolvedValue(undefined);
  slackTestState.replyMock.mockReset();
  slackTestState.updateLastRouteMock.mockReset();
  slackTestState.reactMock.mockReset();
  slackTestState.readAllowFromStoreMock.mockReset().mockResolvedValue([]);
  slackTestState.upsertPairingRequestMock.mockReset().mockResolvedValue({
    code: "PAIRCODE",
    created: true,
  });
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

vi.mock("./monitor/reply.runtime.js", async () => {
  const actual = await vi.importActual<typeof import("./monitor/reply.runtime.js")>(
    "./monitor/reply.runtime.js",
  );
  const replyResolver: typeof actual.getReplyFromConfig = (...args) =>
    slackTestState.replyMock(...args) as ReturnType<typeof actual.getReplyFromConfig>;
  return {
    ...actual,
    dispatchInboundMessage: (params: Parameters<typeof actual.dispatchInboundMessage>[0]) =>
      actual.dispatchInboundMessage({
        ...params,
        replyResolver,
      }),
    getReplyFromConfig: replyResolver,
  };
});

vi.mock("./resolve-channels.js", () => ({
  resolveSlackChannelAllowlist: async ({ entries }: { entries: string[] }) =>
    entries.map((input) => ({ input, resolved: false })),
}));

vi.mock("./resolve-users.js", () => ({
  resolveSlackUserAllowlist: async ({ entries }: { entries: string[] }) =>
    entries.map((input) => ({ input, resolved: false })),
}));

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
    recordInboundSession: vi.fn().mockResolvedValue(undefined),
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

    constructor(args?: { receiver?: unknown }) {
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
    start = vi.fn().mockResolvedValue(undefined);
    stop = vi.fn().mockResolvedValue(undefined);
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
  }
  return {
    App,
    HTTPReceiver,
    SocketModeReceiver,
    default: { App, HTTPReceiver, SocketModeReceiver },
  };
});
