// Zalouser tests cover inbound normalization and outbound bounds through public plugin paths.
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { withEnvAsync } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { API, Message } from "./zca-client.js";

const createZaloMock = vi.hoisted(() => vi.fn());
let sessionSequence = 0;

vi.mock("./zca-client.js", () => ({
  createZalo: createZaloMock,
  TextStyle: { Indent: 9 },
}));

import { setZalouserRuntime } from "./runtime.js";
import { saveStoredZaloCredentials } from "./session-state.js";
import {
  normalizeZaloInboundMessage,
  resolveZaloGroupContext,
  sendZaloTextMessage,
  startZaloListener,
} from "./zalo-js.js";

type ListenerOn = ReturnType<typeof vi.fn>;

function createMockApi(overrides: Partial<API> = {}): API {
  return {
    getContext: () => ({ imei: "test-imei", userAgent: "test-agent", language: "en" }),
    getCookie: () => ({ toJSON: () => ({ cookies: [{ key: "zpsid", value: "test" }] }) }),
    fetchAccountInfo: async () => ({
      userId: "555444333",
      username: "owner",
      displayName: "Owner",
      zaloName: "Owner",
      avatar: "",
    }),
    listener: {
      on: vi.fn(),
      off: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    },
    ...overrides,
  } as unknown as API;
}

async function withStoredSession<T>(params: {
  profile: string;
  api: API;
  run: () => Promise<T>;
}): Promise<T> {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-zalouser-message-"));
  saveStoredZaloCredentials(
    params.profile,
    {
      imei: "test-imei",
      cookie: [{ key: "zpsid", value: "test" }],
      userAgent: "test-agent",
      createdAt: new Date().toISOString(),
    },
    { OPENCLAW_STATE_DIR: stateDir },
  );
  createZaloMock.mockResolvedValueOnce({ login: vi.fn(async () => params.api) });
  try {
    return await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, params.run);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}

function findListener(listenerOn: ListenerOn, event: string): (message: Message) => void {
  const callback = listenerOn.mock.calls.find(([name]) => name === event)?.[1];
  if (typeof callback !== "function") {
    throw new Error(`Missing ${event} listener`);
  }
  return callback as (message: Message) => void;
}

function createInboundMessage(data: Record<string, unknown>): Message {
  return {
    type: 0,
    threadId: "123456789",
    isSelf: false,
    data: {
      uidFrom: "123456789",
      idTo: "987654321",
      content: "plain message",
      ...data,
    },
  };
}

beforeEach(() => {
  resetPluginStateStoreForTests();
  const runtime = createPluginRuntimeMock();
  runtime.state.openSyncKeyedStore = <T>(options: OpenKeyedStoreOptions) =>
    createPluginStateSyncKeyedStoreForTests<T>("zalouser", options);
  setZalouserRuntime(runtime);
  createZaloMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Zalo payload bounds", () => {
  it("keeps the 2,000-code-unit transport payload UTF-16 well-formed", async () => {
    const sendMessage = vi.fn(async () => ({ msgId: "message-1" }));
    const api = createMockApi({ sendMessage } as Partial<API>);

    await withStoredSession({
      profile: "payload-bounds",
      api,
      run: async () => {
        await expect(
          sendZaloTextMessage("thread-1", `${"x".repeat(1_999)}🚀tail`, {
            profile: "payload-bounds",
          }),
        ).resolves.toMatchObject({ ok: true });
      },
    });

    expect(sendMessage).toHaveBeenCalledWith("x".repeat(1_999), "thread-1", expect.anything());
  });
});

describe("Zalo inbound normalization", () => {
  async function captureInbound(messages: Message[]): Promise<Array<Record<string, unknown>>> {
    const profile = `listener-${sessionSequence++}`;
    const listenerOn = vi.fn();
    const api = createMockApi({
      listener: {
        on: listenerOn,
        off: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      },
    } as Partial<API>);
    const received: Message[] = [];

    await withStoredSession({
      profile,
      api,
      run: async () => {
        const abortController = new AbortController();
        const listener = await startZaloListener({
          accountId: "default",
          profile,
          abortSignal: abortController.signal,
          onMessage: (message) => {
            received.push(message);
          },
          onError: vi.fn(),
        });
        const onMessage = findListener(listenerOn, "message");
        for (const message of messages) {
          onMessage(message);
        }
        listener.stop();
      },
    });

    return received
      .map((message) => normalizeZaloInboundMessage(message, "555444333"))
      .filter((message): message is NonNullable<typeof message> => message !== null)
      .map((message) => message as unknown as Record<string, unknown>);
  }

  it("extracts quote metadata and implicit mentions", async () => {
    const [message] = await captureInbound([
      createInboundMessage({
        content: "ok",
        ts: 1_764_000_000_000,
        quote: {
          globalMsgId: 987654321234,
          ownerId: "555444333_2",
          msg: "Previous bot message content",
        },
      }),
    ]);

    expect(message).toMatchObject({
      quotedGlobalMsgId: "987654321234",
      quotedOwnerId: "555444333",
      quotedBody: "Previous bot message content",
      implicitMention: true,
    });
  });

  it("omits absent quote metadata", async () => {
    const [message] = await captureInbound([createInboundMessage({ ts: 1_764_000_000_000 })]);

    expect(message?.quotedGlobalMsgId).toBeUndefined();
    expect(message?.quotedOwnerId).toBeUndefined();
    expect(message?.quotedBody).toBeUndefined();
  });

  it("normalizes second and millisecond timestamps", async () => {
    const messages = await captureInbound([
      createInboundMessage({ ts: 1_764_000_000 }),
      createInboundMessage({ ts: "1764000000.5" }),
      createInboundMessage({ ts: 1_764_000_000_000 }),
    ]);

    expect(messages.map((message) => message.timestampMs)).toEqual([
      1_764_000_000_000, 1_764_000_000_500, 1_764_000_000_000,
    ]);
  });

  it("falls back for partial or unsafe timestamps", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const messages = await captureInbound([
      createInboundMessage({ ts: "1764000000abc" }),
      createInboundMessage({ ts: "9007199254740993" }),
      createInboundMessage({ ts: 8_640_000_000_000_001 }),
    ]);

    expect(messages.map((message) => message.timestampMs)).toEqual([
      1_700_000_000_000, 1_700_000_000_000, 1_700_000_000_000,
    ]);
  });
});

describe("Zalo group context cache", () => {
  function createGroupApi(getGroupInfo: ReturnType<typeof vi.fn>): API {
    return createMockApi({ getGroupInfo } as Partial<API>);
  }

  it("refetches group context when the current clock is invalid", async () => {
    const getGroupInfo = vi.fn(async () => ({
      gridInfoMap: { "group-invalid-clock": { groupId: "group-invalid-clock", name: "Group" } },
    }));
    const api = createGroupApi(getGroupInfo);

    await withStoredSession({
      profile: "cache-invalid-clock",
      api,
      run: async () => {
        await resolveZaloGroupContext("cache-invalid-clock", "group-invalid-clock");
        vi.spyOn(Date, "now").mockReturnValue(Number.NaN);
        await resolveZaloGroupContext("cache-invalid-clock", "group-invalid-clock");
      },
    });

    expect(getGroupInfo).toHaveBeenCalledTimes(2);
  });

  it("does not cache group context when ttl expiry exceeds the Date range", async () => {
    const getGroupInfo = vi.fn(async () => ({
      gridInfoMap: { "group-overflow": { groupId: "group-overflow", name: "Overflow" } },
    }));
    const api = createGroupApi(getGroupInfo);
    vi.spyOn(Date, "now").mockReturnValue(8_640_000_000_000_000);

    await withStoredSession({
      profile: "cache-overflow",
      api,
      run: async () => {
        await resolveZaloGroupContext("cache-overflow", "group-overflow");
        await resolveZaloGroupContext("cache-overflow", "group-overflow");
      },
    });

    expect(getGroupInfo).toHaveBeenCalledTimes(2);
  });
});
