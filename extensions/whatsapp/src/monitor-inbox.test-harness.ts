import { EventEmitter } from "node:events";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetLogger, setLoggerOverride } from "openclaw/plugin-sdk/runtime-env";
import { afterEach, beforeEach, expect, vi } from "vitest";
import {
  loadConfigMock,
  readAllowFromStoreMock as pairingReadAllowFromStoreMock,
  resetPairingSecurityMocks,
  upsertPairingRequestMock as pairingUpsertPairingRequestMock,
} from "./pairing-security.test-harness.js";

// Avoid exporting vitest mock types (TS2742 under pnpm + d.ts emit).
type AnyMockFn = any;

export const DEFAULT_ACCOUNT_ID = "default";

export const DEFAULT_WEB_INBOX_CONFIG = {
  channels: {
    whatsapp: {
      // Allow all in tests by default.
      allowFrom: ["*"],
    },
  },
  messages: {
    messagePrefix: undefined,
    responsePrefix: undefined,
  },
} as const;
export const mockLoadConfig: typeof loadConfigMock = loadConfigMock;
export const readAllowFromStoreMock = pairingReadAllowFromStoreMock;
export const upsertPairingRequestMock = pairingUpsertPairingRequestMock;

export type MockSock = {
  ev: EventEmitter;
  ws: { close: AnyMockFn };
  sendPresenceUpdate: AnyMockFn;
  sendMessage: AnyMockFn;
  readMessages: AnyMockFn;
  groupFetchAllParticipating: AnyMockFn;
  updateMediaMessage: AnyMockFn;
  logger: Record<string, unknown>;
  signalRepository: {
    lidMapping: {
      getPNForLID: AnyMockFn;
    };
  };
  user: { id: string };
};

const sessionState = vi.hoisted(() => ({
  sock: undefined as MockSock | undefined,
}));

const inboundRuntimeMocks = vi.hoisted(() => {
  const wrapperKeys = [
    "ephemeralMessage",
    "viewOnceMessage",
    "viewOnceMessageV2",
    "viewOnceMessageV2Extension",
    "documentWithCaptionMessage",
  ] as const;

  function normalizeMessageContent(message: unknown): unknown {
    let current = message;
    while (current && typeof current === "object") {
      const record = current as Record<string, unknown>;
      const wrapper = wrapperKeys
        .map((key) => record[key])
        .find(
          (candidate): candidate is { message: unknown } =>
            Boolean(candidate) &&
            typeof candidate === "object" &&
            "message" in (candidate as Record<string, unknown>) &&
            Boolean((candidate as { message?: unknown }).message),
        );
      if (!wrapper) {
        break;
      }
      current = wrapper.message;
    }
    return current;
  }

  return {
    downloadMediaMessage: vi.fn().mockResolvedValue(Buffer.from("fake-media-data")),
    isJidGroup: vi.fn((jid: string | undefined | null) =>
      typeof jid === "string" ? jid.endsWith("@g.us") : false,
    ),
    normalizeMessageContent: vi.fn(normalizeMessageContent),
    saveMediaBuffer: vi.fn().mockResolvedValue({
      id: "mid",
      path: "/tmp/mid",
      size: 1,
      contentType: "image/jpeg",
    }),
  };
});

function createResolvedMock() {
  return vi.fn().mockResolvedValue(undefined);
}

function createMockSock(): MockSock {
  const ev = new EventEmitter();
  return {
    ev,
    ws: { close: vi.fn() },
    sendPresenceUpdate: createResolvedMock(),
    sendMessage: createResolvedMock(),
    readMessages: createResolvedMock(),
    groupFetchAllParticipating: vi.fn().mockResolvedValue({}),
    updateMediaMessage: vi.fn(),
    logger: {},
    signalRepository: {
      lidMapping: {
        getPNForLID: vi.fn().mockResolvedValue(null),
      },
    },
    user: { id: "123@s.whatsapp.net" },
  };
}

vi.mock("./inbound/runtime-api.js", () => {
  return {
    DisconnectReason: { loggedOut: 401 },
    ...inboundRuntimeMocks,
  };
});

vi.mock("./session.js", async () => {
  return {
    createWaSocket: vi.fn().mockImplementation(async () => {
      if (!sessionState.sock) {
        throw new Error("mock WhatsApp socket not initialized");
      }
      return sessionState.sock;
    }),
    waitForWaConnection: vi.fn().mockResolvedValue(undefined),
    getStatusCode: vi.fn(() => 500),
    formatError: (err: unknown) => (err instanceof Error ? err.message : String(err)),
  };
});

export function getSock(): MockSock {
  if (!sessionState.sock) {
    throw new Error("mock WhatsApp socket not initialized");
  }
  return sessionState.sock;
}

type MonitorWebInbox = typeof import("./inbound.js").monitorWebInbox;
type ResetWebInboundDedupe = typeof import("./inbound.js").resetWebInboundDedupe;
export type InboxOnMessage = NonNullable<Parameters<MonitorWebInbox>[0]["onMessage"]>;
export type InboxMonitorOptions = Parameters<MonitorWebInbox>[0];
let monitorWebInbox: MonitorWebInbox;
let resetWebInboundDedupe: ResetWebInboundDedupe;

function expectInboxPairingReplyText(
  text: string,
  params: {
    channel: string;
    idLine: string;
    code?: string;
  },
): string {
  const code = text.match(/Pairing code:\s*```[\r\n]+([A-Z2-9]{6,})/)?.[1];
  expect(code).toBeDefined();
  const resolvedCode = params.code ?? code ?? "";
  expect(text).toContain("OpenClaw: access not configured.");
  expect(text).toContain(params.idLine);
  expect(text).toContain("Pairing code:");
  expect(text).toContain(`\n\`\`\`\n${resolvedCode}\n\`\`\`\n`);
  expect(text).toContain(`pairing approve ${params.channel} ${resolvedCode}`);
  return resolvedCode;
}

export function getMonitorWebInbox(): MonitorWebInbox {
  if (!monitorWebInbox) {
    throw new Error("monitorWebInbox not initialized");
  }
  return monitorWebInbox;
}

export async function settleInboundWork() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

export async function waitForMessageCalls(onMessage: ReturnType<typeof vi.fn>, count: number) {
  await vi.waitFor(
    () => {
      expect(onMessage).toHaveBeenCalledTimes(count);
    },
    // Channel-suite workers can be saturated under no-isolate CI runs.
    { timeout: 5_000, interval: 5 },
  );
}

export async function startInboxMonitor(
  onMessage: InboxOnMessage,
  extraOptions: Partial<InboxMonitorOptions> = {},
) {
  if (!monitorWebInbox) {
    ({ monitorWebInbox } = await import("./inbound.js"));
  }
  const listener = await monitorWebInbox({
    verbose: false,
    onMessage,
    accountId: DEFAULT_ACCOUNT_ID,
    authDir: getAuthDir(),
    ...extraOptions,
  });
  return { listener, sock: getSock() };
}

export function buildNotifyMessageUpsert(params: {
  id: string;
  remoteJid: string;
  text: string;
  timestamp: number;
  pushName?: string;
  participant?: string;
}) {
  return {
    type: "notify",
    messages: [
      {
        key: {
          id: params.id,
          fromMe: false,
          remoteJid: params.remoteJid,
          participant: params.participant,
        },
        message: { conversation: params.text },
        messageTimestamp: params.timestamp,
        pushName: params.pushName,
      },
    ],
  };
}

export function expectPairingPromptSent(sock: MockSock, jid: string, senderE164: string) {
  expect(sock.sendMessage).toHaveBeenCalledTimes(1);
  const sendCall = sock.sendMessage.mock.calls[0];
  expect(sendCall?.[0]).toBe(jid);
  expectInboxPairingReplyText((sendCall?.[1] as { text?: string } | undefined)?.text ?? "", {
    channel: "whatsapp",
    idLine: `Your WhatsApp phone number: ${senderE164}`,
    code: "PAIRCODE",
  });
}

let authDir: string | undefined;

export function getAuthDir(): string {
  if (!authDir) {
    throw new Error("authDir not initialized; call installWebMonitorInboxUnitTestHooks()");
  }
  return authDir;
}

export function installWebMonitorInboxUnitTestHooks(opts?: { authDir?: boolean }) {
  const createAuthDir = opts?.authDir ?? true;

  beforeEach(async () => {
    vi.useRealTimers();
    vi.clearAllMocks();
    sessionState.sock = createMockSock();
    resetPairingSecurityMocks(DEFAULT_WEB_INBOX_CONFIG);
    if (!monitorWebInbox || !resetWebInboundDedupe) {
      const inboundModule = await import("./inbound.js");
      monitorWebInbox = inboundModule.monitorWebInbox;
      resetWebInboundDedupe = inboundModule.resetWebInboundDedupe;
    }
    resetWebInboundDedupe();
    if (createAuthDir) {
      authDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-"));
    } else {
      authDir = undefined;
    }
  });

  afterEach(() => {
    resetLogger();
    setLoggerOverride(null);
    vi.useRealTimers();
    if (authDir) {
      fsSync.rmSync(authDir, { recursive: true, force: true });
      authDir = undefined;
    }
  });
}
