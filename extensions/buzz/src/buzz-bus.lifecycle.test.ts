import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { finalizeEvent, type Event } from "nostr-tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const relayMocks = vi.hoisted(() => ({
  connect: vi.fn<() => Promise<void>>(),
  auth: vi.fn<() => Promise<string>>(),
  publish: vi.fn<() => Promise<string>>(),
  subscriptionClose: vi.fn(),
  close: vi.fn(),
  onevent: undefined as ((event: Event) => void) | undefined,
  closeHandler: undefined as ((reason: string) => void) | undefined,
}));

vi.mock("nostr-tools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("nostr-tools")>();
  return {
    ...actual,
    Relay: class {
      onauth?: (template: unknown) => Promise<unknown>;
      connect = relayMocks.connect;
      auth = relayMocks.auth;
      publish = relayMocks.publish;
      close = relayMocks.close;

      subscribe(
        _filters: unknown,
        handlers: { onevent: (event: Event) => void; onclose: (reason: string) => void },
      ) {
        relayMocks.onevent = handlers.onevent;
        relayMocks.closeHandler = handlers.onclose;
        return { close: relayMocks.subscriptionClose };
      }
    },
  };
});

import { startBuzzBus } from "./buzz-bus.js";

const PRIVATE_KEY = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const SENDER_PRIVATE_KEY = "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20";
const ACCOUNT_ID = "default";
let previousStateDir: string | undefined;
let stateDir: string;

describe("Buzz bus lifecycle", () => {
  beforeEach(() => {
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    stateDir = mkdtempSync(path.join(tmpdir(), "openclaw-buzz-dedupe-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    vi.clearAllMocks();
    relayMocks.onevent = undefined;
    relayMocks.closeHandler = undefined;
    relayMocks.connect.mockResolvedValue();
    relayMocks.auth.mockRejectedValue(new Error("auth rejected"));
    relayMocks.publish.mockResolvedValue("");
  });

  afterEach(() => {
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("closes a connected relay when authentication fails", async () => {
    await expect(
      startBuzzBus({
        accountId: ACCOUNT_ID,
        relayUrl: "wss://buzz.example.com",
        privateKey: PRIVATE_KEY,
        channelIds: ["7c4a6d2a-2ed9-4b4e-a5e2-4d705ee9b34c"],
        onMessage: async () => {},
      }),
    ).rejects.toThrow("auth rejected");

    expect(relayMocks.connect).toHaveBeenCalledOnce();
    expect(relayMocks.close).toHaveBeenCalledOnce();
  });

  it("deduplicates replayed relay events by event id", async () => {
    relayMocks.auth.mockResolvedValue("ok");
    const onMessage = vi.fn(async () => {});
    const bus = await startBuzzBus({
      accountId: ACCOUNT_ID,
      relayUrl: "wss://buzz.example.com",
      privateKey: PRIVATE_KEY,
      channelIds: ["7c4a6d2a-2ed9-4b4e-a5e2-4d705ee9b34c"],
      onMessage,
    });
    const event = finalizeEvent(
      {
        kind: 9,
        created_at: 1_700_000_000,
        content: "hello",
        tags: [["h", "7c4a6d2a-2ed9-4b4e-a5e2-4d705ee9b34c"]],
      },
      Uint8Array.from(Buffer.from(SENDER_PRIVATE_KEY, "hex")),
    );

    relayMocks.onevent?.(event);
    relayMocks.onevent?.(event);

    await vi.waitFor(() => expect(onMessage).toHaveBeenCalledOnce());
    await bus.close();
  });

  it("isolates message failures from fatal relay failures", async () => {
    relayMocks.auth.mockResolvedValue("ok");
    const onMessageError = vi.fn();
    const onFatalError = vi.fn();
    const bus = await startBuzzBus({
      accountId: ACCOUNT_ID,
      relayUrl: "wss://buzz.example.com",
      privateKey: PRIVATE_KEY,
      channelIds: ["7c4a6d2a-2ed9-4b4e-a5e2-4d705ee9b34c"],
      onMessage: async () => {
        throw new Error("dispatch failed");
      },
      onMessageError,
      onFatalError,
    });
    const event = finalizeEvent(
      {
        kind: 9,
        created_at: 1_700_000_000,
        content: "hello",
        tags: [["h", "7c4a6d2a-2ed9-4b4e-a5e2-4d705ee9b34c"]],
      },
      Uint8Array.from(Buffer.from(SENDER_PRIVATE_KEY, "hex")),
    );

    relayMocks.onevent?.(event);

    await vi.waitFor(() => expect(onMessageError).toHaveBeenCalledWith(expect.any(Error)));
    expect(onFatalError).not.toHaveBeenCalled();
    await bus.close();
  });

  it("deduplicates replayed events after the bus restarts", async () => {
    relayMocks.auth.mockResolvedValue("ok");
    const event = finalizeEvent(
      {
        kind: 9,
        created_at: Math.floor(Date.now() / 1000),
        content: "hello",
        tags: [["h", "7c4a6d2a-2ed9-4b4e-a5e2-4d705ee9b34c"]],
      },
      Uint8Array.from(Buffer.from(SENDER_PRIVATE_KEY, "hex")),
    );
    const firstOnMessage = vi.fn(async () => {});
    const firstBus = await startBuzzBus({
      accountId: ACCOUNT_ID,
      relayUrl: "wss://buzz.example.com",
      privateKey: PRIVATE_KEY,
      channelIds: ["7c4a6d2a-2ed9-4b4e-a5e2-4d705ee9b34c"],
      onMessage: firstOnMessage,
    });
    relayMocks.onevent?.(event);
    await vi.waitFor(() => expect(firstOnMessage).toHaveBeenCalledOnce());
    await firstBus.close();

    const secondOnMessage = vi.fn(async () => {});
    const secondBus = await startBuzzBus({
      accountId: ACCOUNT_ID,
      relayUrl: "wss://buzz.example.com",
      privateKey: PRIVATE_KEY,
      channelIds: ["7c4a6d2a-2ed9-4b4e-a5e2-4d705ee9b34c"],
      onMessage: secondOnMessage,
    });
    relayMocks.onevent?.(event);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 100);
    });

    expect(secondOnMessage).not.toHaveBeenCalled();
    await secondBus.close();
  });
});
