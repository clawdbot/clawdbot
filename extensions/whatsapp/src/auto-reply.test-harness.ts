import "./test-helpers.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resetInboundDedupe } from "openclaw/plugin-sdk/reply-runtime";
import { resetLogger, setLoggerOverride } from "openclaw/plugin-sdk/runtime-env";
import { mockPinnedHostnameResolution } from "openclaw/plugin-sdk/testing";
import { afterAll, afterEach, beforeAll, beforeEach, vi, type Mock } from "vitest";
import type { WebInboundMessage, WebListenerCloseReason } from "./inbound.js";
import {
  resetBaileysMocks as _resetBaileysMocks,
  resetLoadConfigMock as _resetLoadConfigMock,
} from "./test-helpers.js";

export {
  resetBaileysMocks,
  resetLoadConfigMock,
  setLoadConfigMock,
  setRuntimeConfigSourceSnapshotMock,
} from "./test-helpers.js";

// Avoid exporting inferred vitest mock types (TS2742 under pnpm + d.ts emit).
type AnyExport = any;
type MockWebListener = {
  close: () => Promise<void>;
  onClose: Promise<WebListenerCloseReason>;
  signalClose: () => void;
  sendMessage: () => Promise<{ messageId: string }>;
  sendPoll: () => Promise<{ messageId: string }>;
  sendReaction: () => Promise<void>;
  sendComposingTo: () => Promise<void>;
};
type UnknownMock = Mock<(...args: unknown[]) => unknown>;
type AsyncUnknownMock = Mock<(...args: unknown[]) => Promise<unknown>>;
type WebAutoReplyRuntime = {
  log: UnknownMock;
  error: UnknownMock;
  exit: UnknownMock;
};
type WebAutoReplyMonitorHarness = {
  runtime: WebAutoReplyRuntime;
  controller: AbortController;
  run: Promise<unknown>;
};

export const TEST_NET_IP = "93.184.216.34";

vi.mock("./session.js", async () => {
  const actual = await vi.importActual<typeof import("./session.js")>("./session.js");
  return {
    ...actual,
    createWaSocket: vi.fn(async () => ({
      ev: {
        on: vi.fn(),
        off: vi.fn(),
      },
      ws: { close: vi.fn() },
      user: { id: "123@s.whatsapp.net" },
    })),
    waitForWaConnection: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("openclaw/plugin-sdk/agent-runtime", () => ({
  abortEmbeddedPiRun: vi.fn().mockReturnValue(false),
  appendCronStyleCurrentTimeLine: (text: string) => text,
  isEmbeddedPiRunActive: vi.fn().mockReturnValue(false),
  isEmbeddedPiRunStreaming: vi.fn().mockReturnValue(false),
  queueEmbeddedPiMessage: vi.fn().mockReturnValue(false),
  resolveEmbeddedSessionLane: (key: string) => `session:${key.trim() || "main"}`,
  resolveIdentityNamePrefix: (cfg: { messages?: { responsePrefix?: string } }, _agentId: string) =>
    cfg.messages?.responsePrefix,
  resolveMessagePrefix: (cfg: { messages?: { messagePrefix?: string } }) =>
    cfg.messages?.messagePrefix,
  runEmbeddedPiAgent: vi.fn(),
}));

export async function rmDirWithRetries(
  dir: string,
  opts?: { attempts?: number; delayMs?: number },
): Promise<void> {
  const attempts = opts?.attempts ?? 10;
  const delayMs = opts?.delayMs ?? 5;
  // Some tests can leave async session-store writes in-flight; recursive deletion can race and throw ENOTEMPTY.
  // Let Node handle retries (faster than re-walking the tree in JS on each retry).
  try {
    await fs.rm(dir, {
      recursive: true,
      force: true,
      maxRetries: attempts,
      retryDelay: delayMs,
    });
    return;
  } catch {
    // Fall back for older Node implementations (or unexpected retry behavior).
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        await fs.rm(dir, { recursive: true, force: true });
        return;
      } catch (retryErr) {
        const code =
          retryErr && typeof retryErr === "object" && "code" in retryErr
            ? String((retryErr as { code?: unknown }).code)
            : null;
        if (code === "ENOTEMPTY" || code === "EBUSY" || code === "EPERM") {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }
        throw retryErr;
      }
    }

    await fs.rm(dir, { recursive: true, force: true });
  }
}

let previousHome: string | undefined;
let tempHome: string | undefined;
let tempHomeRoot: string | undefined;
let tempHomeId = 0;

export function installWebAutoReplyTestHomeHooks() {
  beforeAll(async () => {
    tempHomeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-web-home-suite-"));
  });

  beforeEach(async () => {
    resetInboundDedupe();
    previousHome = process.env.HOME;
    tempHome = path.join(tempHomeRoot ?? os.tmpdir(), `case-${++tempHomeId}`);
    await fs.mkdir(tempHome, { recursive: true });
    process.env.HOME = tempHome;
  });

  afterEach(async () => {
    process.env.HOME = previousHome;
    tempHome = undefined;
  });

  afterAll(async () => {
    if (tempHomeRoot) {
      await rmDirWithRetries(tempHomeRoot);
      tempHomeRoot = undefined;
    }
    tempHomeId = 0;
  });
}

export async function makeSessionStore(
  entries: Record<string, unknown> = {},
): Promise<{ storePath: string; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-"));
  const storePath = path.join(dir, "sessions.json");
  await fs.writeFile(storePath, JSON.stringify(entries));
  const cleanup = async () => {
    await rmDirWithRetries(dir);
  };
  return {
    storePath,
    cleanup,
  };
}

export function installWebAutoReplyUnitTestHooks(opts?: { pinDns?: boolean }) {
  let resolvePinnedHostnameSpy: { mockRestore: () => unknown } | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    _resetBaileysMocks();
    _resetLoadConfigMock();
    if (opts?.pinDns) {
      resolvePinnedHostnameSpy = mockPinnedHostnameResolution([TEST_NET_IP]);
    }
  });

  afterEach(() => {
    resolvePinnedHostnameSpy?.mockRestore();
    resolvePinnedHostnameSpy = undefined;
    resetLogger();
    setLoggerOverride(null);
    vi.useRealTimers();
  });
}

export function createWebListenerFactoryCapture(): AnyExport {
  let capturedOnMessage: ((msg: WebInboundMessage) => Promise<void>) | undefined;
  let capturedOptions:
    | {
        onMessage: (msg: WebInboundMessage) => Promise<void>;
        debounceMs?: number;
        selfChatMode?: boolean;
      }
    | undefined;
  const listenerFactory = async (opts: {
    onMessage: (msg: WebInboundMessage) => Promise<void>;
    debounceMs?: number;
    selfChatMode?: boolean;
  }) => {
    capturedOnMessage = opts.onMessage;
    capturedOptions = opts;
    return { close: vi.fn() };
  };

  return {
    listenerFactory,
    getOnMessage: () => capturedOnMessage,
    getLastOptions: () => capturedOptions,
  };
}

export function createMockWebListener(): MockWebListener {
  return {
    close: vi.fn(async () => undefined),
    onClose: new Promise<WebListenerCloseReason>(() => {}),
    signalClose: vi.fn(),
    sendMessage: vi.fn(async () => ({ messageId: "msg-1" })),
    sendPoll: vi.fn(async () => ({ messageId: "poll-1" })),
    sendReaction: vi.fn(async () => undefined),
    sendComposingTo: vi.fn(async () => undefined),
  };
}

export function createScriptedWebListenerFactory(): AnyExport {
  const onMessages: Array<(msg: WebInboundMessage) => Promise<void>> = [];
  const closeResolvers: Array<(reason: unknown) => void> = [];
  const listeners: MockWebListener[] = [];

  const listenerFactory = vi.fn(
    async (opts: { onMessage: (msg: WebInboundMessage) => Promise<void> }) => {
      onMessages.push(opts.onMessage);
      let resolveClose: (reason: unknown) => void = () => {};
      const onClose = new Promise<WebListenerCloseReason>((res) => {
        resolveClose = res as (reason: unknown) => void;
        closeResolvers.push(resolveClose);
      });
      const listener: MockWebListener = {
        ...createMockWebListener(),
        onClose,
        signalClose: vi.fn((reason?: unknown) => resolveClose(reason)),
      };
      listeners.push(listener);
      return listener;
    },
  );

  return {
    listenerFactory,
    listeners,
    getOnMessage: (index = onMessages.length - 1) => onMessages[index],
    resolveClose: (index: number, reason?: unknown) => closeResolvers[index]?.(reason),
    getListenerCount: () => listenerFactory.mock.calls.length,
  };
}

export function createWebInboundDeliverySpies(): AnyExport {
  return {
    sendMedia: vi.fn(),
    reply: vi.fn().mockResolvedValue(undefined),
    sendComposing: vi.fn(),
  };
}

export function createWebAutoReplyRuntime(): WebAutoReplyRuntime {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
}

export function startWebAutoReplyMonitor(params: {
  monitorWebChannelFn: (...args: unknown[]) => Promise<unknown>;
  listenerFactory: unknown;
  sleep: UnknownMock | AsyncUnknownMock;
  signal?: AbortSignal;
  heartbeatSeconds?: number;
  messageTimeoutMs?: number;
  watchdogCheckMs?: number;
  reconnect?: { initialMs: number; maxMs: number; maxAttempts: number; factor: number };
}): WebAutoReplyMonitorHarness {
  const runtime = createWebAutoReplyRuntime();
  const controller = new AbortController();
  const run = params.monitorWebChannelFn(
    false,
    params.listenerFactory as never,
    true,
    async () => ({ text: "ok" }),
    runtime as never,
    params.signal ?? controller.signal,
    {
      heartbeatSeconds: params.heartbeatSeconds ?? 1,
      messageTimeoutMs: params.messageTimeoutMs,
      watchdogCheckMs: params.watchdogCheckMs,
      reconnect: params.reconnect ?? { initialMs: 10, maxMs: 10, maxAttempts: 3, factor: 1.1 },
      sleep: params.sleep,
    },
  );

  return { runtime, controller, run };
}

export async function sendWebGroupInboundMessage(params: {
  onMessage: (msg: WebInboundMessage) => Promise<void>;
  body: string;
  id: string;
  senderE164: string;
  senderName: string;
  mentionedJids?: string[];
  selfE164?: string;
  selfJid?: string;
  spies: ReturnType<typeof createWebInboundDeliverySpies>;
  conversationId?: string;
  accountId?: string;
}) {
  const conversationId = params.conversationId ?? "123@g.us";
  const accountId = params.accountId ?? "default";
  await params.onMessage({
    body: params.body,
    from: conversationId,
    conversationId,
    chatId: conversationId,
    chatType: "group",
    to: "+2",
    accountId,
    id: params.id,
    senderE164: params.senderE164,
    senderName: params.senderName,
    mentionedJids: params.mentionedJids,
    selfE164: params.selfE164,
    selfJid: params.selfJid,
    sendComposing: params.spies.sendComposing,
    reply: params.spies.reply,
    sendMedia: params.spies.sendMedia,
  } as WebInboundMessage);
}

export async function sendWebDirectInboundMessage(params: {
  onMessage: (msg: WebInboundMessage) => Promise<void>;
  body: string;
  id: string;
  from: string;
  to: string;
  spies: ReturnType<typeof createWebInboundDeliverySpies>;
  accountId?: string;
  timestamp?: number;
}) {
  const accountId = params.accountId ?? "default";
  await params.onMessage({
    accountId,
    id: params.id,
    from: params.from,
    conversationId: params.from,
    to: params.to,
    body: params.body,
    timestamp: params.timestamp ?? Date.now(),
    chatType: "direct",
    chatId: `direct:${params.from}`,
    sendComposing: params.spies.sendComposing,
    reply: params.spies.reply,
    sendMedia: params.spies.sendMedia,
  } as WebInboundMessage);
}
