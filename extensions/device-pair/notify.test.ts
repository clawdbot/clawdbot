// Device Pair tests cover notify plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEVICE_PAIR_NOTIFY_SUBSCRIBER_MAX_ENTRIES,
  DEVICE_PAIR_NOTIFY_SUBSCRIBER_NAMESPACE,
  notifySubscriberStoreKey,
  type NotifySubscription,
} from "./notify-state.js";

const listDevicePairingMock = vi.hoisted(() => vi.fn(async () => ({ pending: [] })));

vi.mock("./api.js", () => ({
  listDevicePairing: listDevicePairingMock,
}));

import { handleNotifyCommand } from "./notify.js";

afterAll(() => {
  vi.doUnmock("./api.js");
  vi.resetModules();
});

describe("device-pair notify persistence", () => {
  let stateDir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    resetPluginStateStoreForTests();
    vi.clearAllMocks();
    listDevicePairingMock.mockResolvedValue({ pending: [] });
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "device-pair-notify-"));
    env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  });

  afterEach(async () => {
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  function openStore<T>(options: OpenKeyedStoreOptions) {
    return createPluginStateKeyedStoreForTests<T>("device-pair", {
      ...options,
      env: options.env ?? env,
    });
  }

  function createApi() {
    return createTestPluginApi({
      runtime: {
        state: {
          resolveStateDir: () => stateDir,
          openKeyedStore: openStore,
        },
      } as never,
    });
  }

  function openSubscriberStore() {
    return openStore<NotifySubscription>({
      namespace: DEVICE_PAIR_NOTIFY_SUBSCRIBER_NAMESPACE,
      maxEntries: DEVICE_PAIR_NOTIFY_SUBSCRIBER_MAX_ENTRIES,
    });
  }

  it("matches persisted telegram thread ids across number and string roundtrips", async () => {
    const subscriber: NotifySubscription = {
      to: "chat-123",
      accountId: "telegram-default",
      messageThreadId: 271,
      mode: "persistent",
      addedAtMs: 1,
    };
    await openSubscriberStore().register(notifySubscriberStoreKey(subscriber), subscriber);
    const api = createApi();

    const status = await handleNotifyCommand({
      api,
      ctx: {
        channel: "telegram",
        senderId: "chat-123",
        accountId: "telegram-default",
        messageThreadId: "271",
      },
      action: "status",
    });

    expect(status.text).toContain("Pair request notifications: enabled for this chat.");
    expect(status.text).toContain("Mode: persistent");

    await handleNotifyCommand({
      api,
      ctx: {
        channel: "telegram",
        senderId: "chat-123",
        accountId: "telegram-default",
        messageThreadId: "271",
      },
      action: "off",
    });

    await expect(openSubscriberStore().entries()).resolves.toStrictEqual([]);
  });

  it("does not remove a different persisted subscriber when notify fields contain pipes", async () => {
    const firstSubscriber: NotifySubscription = {
      to: "chat|123",
      accountId: "acct",
      mode: "persistent",
      addedAtMs: 1,
    };
    const secondSubscriber: NotifySubscription = {
      to: "chat",
      accountId: "123|acct",
      mode: "persistent",
      addedAtMs: 2,
    };
    const store = openSubscriberStore();
    await store.register(notifySubscriberStoreKey(firstSubscriber), firstSubscriber);
    await store.register(notifySubscriberStoreKey(secondSubscriber), secondSubscriber);
    const api = createApi();

    await handleNotifyCommand({
      api,
      ctx: {
        channel: "telegram",
        senderId: "chat",
        accountId: "123|acct",
      },
      action: "off",
    });

    const status = await handleNotifyCommand({
      api,
      ctx: {
        channel: "telegram",
        senderId: "chat",
        accountId: "123|acct",
      },
      action: "status",
    });
    expect(status.text).toContain("Pair request notifications: disabled for this chat.");

    await expect(openSubscriberStore().entries()).resolves.toMatchObject([
      {
        key: notifySubscriberStoreKey(firstSubscriber),
        value: firstSubscriber,
      },
    ]);
  });
});
