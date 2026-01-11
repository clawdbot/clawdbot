import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetLogger, setLoggerOverride } from "../logging.js";

vi.mock("./session.js", () => {
  const ev = new EventEmitter();
  const sock = {
    ev,
    ws: { close: vi.fn() },
    sendPresenceUpdate: vi.fn(),
    sendMessage: vi.fn(),
  };
  return {
    createWaSocket: vi.fn().mockResolvedValue(sock),
    waitForWaConnection: vi.fn().mockResolvedValue(undefined),
  };
});

import { loginWeb } from "./login.js";
import type { waitForWaConnection } from "./session.js";

const { createWaSocket } = await import("./session.js");

describe("web login", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    resetLogger();
    setLoggerOverride(null);
  });

  it("loginWeb waits for connection and closes", async () => {
    const sock = await createWaSocket();
    const close = vi.spyOn(sock.ws, "close");
    const waiter: typeof waitForWaConnection = vi
      .fn()
      .mockResolvedValue(undefined);
    await loginWeb(false, waiter);
    await new Promise((resolve) => setTimeout(resolve, 550));
    expect(close).toHaveBeenCalled();
  });
});
