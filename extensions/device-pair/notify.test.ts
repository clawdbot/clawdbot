import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

  beforeEach(async () => {
    vi.clearAllMocks();
    listDevicePairingMock.mockResolvedValue({ pending: [] });
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "device-pair-notify-"));
  });

  afterEach(async () => {
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("matches persisted telegram thread ids across number and string roundtrips", async () => {
    await fs.writeFile(
      path.join(stateDir, "device-pair-notify.json"),
      JSON.stringify(
        {
          subscribers: [
            {
              to: "chat-123",
              accountId: "telegram-default",
              messageThreadId: 271,
              mode: "persistent",
              addedAtMs: 1,
            },
          ],
          notifiedRequestIds: {},
        },
        null,
        2,
      ),
      "utf8",
    );

    const api = createTestPluginApi({
      runtime: {
        state: {
          resolveStateDir: () => stateDir,
        },
      } as never,
    });

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

    const persisted = JSON.parse(
      await fs.readFile(path.join(stateDir, "device-pair-notify.json"), "utf8"),
    ) as { subscribers: unknown[] };
    expect(persisted.subscribers).toEqual([]);
  });

  it("does not remove a different persisted subscriber when notify fields contain pipes", async () => {
    await fs.writeFile(
      path.join(stateDir, "device-pair-notify.json"),
      JSON.stringify(
        {
          subscribers: [
            {
              to: "chat|123",
              accountId: "acct",
              mode: "persistent",
              addedAtMs: 1,
            },
            {
              to: "chat",
              accountId: "123|acct",
              mode: "persistent",
              addedAtMs: 2,
            },
          ],
          notifiedRequestIds: {},
        },
        null,
        2,
      ),
      "utf8",
    );

    const api = createTestPluginApi({
      runtime: {
        state: {
          resolveStateDir: () => stateDir,
        },
      } as never,
    });

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

    const persisted = JSON.parse(
      await fs.readFile(path.join(stateDir, "device-pair-notify.json"), "utf8"),
    ) as { subscribers: Array<{ to: string; accountId?: string }> };
    expect(persisted.subscribers).toHaveLength(1);
    expect(persisted.subscribers[0]).toMatchObject({
      to: "chat|123",
      accountId: "acct",
    });
  });
});
