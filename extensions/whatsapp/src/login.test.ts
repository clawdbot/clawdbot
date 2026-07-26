// Whatsapp tests cover login plugin behavior.
import { EventEmitter } from "node:events";
import { resetLogger, setLoggerOverride, success } from "openclaw/plugin-sdk/runtime-env";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./session.js", async () => {
  const actual = await vi.importActual<typeof import("./session.js")>("./session.js");
  const ev = new EventEmitter();
  const sock = {
    ev,
    ws: { close: vi.fn() },
    sendPresenceUpdate: vi.fn(),
    sendMessage: vi.fn(),
  };
  return {
    ...actual,
    createWaSocket: vi.fn().mockResolvedValue(sock),
    waitForWaConnection: vi.fn().mockResolvedValue(undefined),
    readWebAuthExistsForDecision: vi.fn(async () => ({
      outcome: "stable" as const,
      exists: true,
    })),
  };
});

vi.mock("./auth-store.js", async () => {
  const actual = await vi.importActual<typeof import("./auth-store.js")>("./auth-store.js");
  return {
    ...actual,
    restoreCredsFromBackupIfNeeded: vi.fn(async () => false),
  };
});

import type { waitForWaConnection } from "./session.js";
let loginWeb: typeof import("./login.js").loginWeb;
let createWaSocket: typeof import("./session.js").createWaSocket;
let restoreCredsFromBackupIfNeeded: typeof import("./auth-store.js").restoreCredsFromBackupIfNeeded;

describe("web login", () => {
  beforeAll(async () => {
    ({ loginWeb } = await import("./login.js"));
    ({ createWaSocket } = await import("./session.js"));
    ({ restoreCredsFromBackupIfNeeded } = await import("./auth-store.js"));
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetLogger();
    setLoggerOverride(null);
  });

  it("loginWeb waits for connection and closes", async () => {
    const sock = await (
      createWaSocket as unknown as () => Promise<{ ws: { close: () => void } }>
    )();
    const close = vi.spyOn(sock.ws, "close");
    const waiter: typeof waitForWaConnection = vi.fn().mockResolvedValue(undefined);
    await loginWeb(false, waiter);
    expect(close).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(499);
    expect(close).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("prints a backup recovery success message when creds are restored from backup", async () => {
    const waiter: typeof waitForWaConnection = vi.fn().mockResolvedValue(undefined);
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(restoreCredsFromBackupIfNeeded).mockResolvedValueOnce(true);

    await loginWeb(false, waiter);

    expect(consoleLog).toHaveBeenCalledWith(
      success("✅ Recovered from creds.json.bak; web session ready."),
    );
    consoleLog.mockRestore();
  });

  it("rejects a delayed credential write failure even when old auth is still readable", async () => {
    const persistenceError = new Error("credential write failed");
    const waiter: typeof waitForWaConnection = vi.fn(() => new Promise<void>(() => {}));
    const pendingLogin = loginWeb(false, waiter, undefined, undefined, {
      beforeCredentialPersistence: async () => {},
    });
    for (let index = 0; index < 5; index += 1) {
      await Promise.resolve();
    }
    expect(vi.mocked(createWaSocket)).toHaveBeenCalled();
    const socketOptions = vi.mocked(createWaSocket).mock.calls.at(-1)?.[2] as
      | { onCredentialPersistenceError?: (error: unknown) => void }
      | undefined;

    socketOptions?.onCredentialPersistenceError?.(persistenceError);

    await expect(pendingLogin).rejects.toBe(persistenceError);
  });

  it("waits for Baileys post-open key persistence before reporting login success", async () => {
    let releaseKeyRead = () => {};
    let releaseKeyWrite = () => {};
    const keyRead = new Promise<void>((resolve) => {
      releaseKeyRead = resolve;
    });
    const keyWrite = new Promise<void>((resolve) => {
      releaseKeyWrite = resolve;
    });
    const waiter: typeof waitForWaConnection = vi.fn().mockResolvedValue(undefined);
    const pendingLogin = loginWeb(false, waiter, undefined, undefined, {
      beforeCredentialPersistence: async () => {},
    });
    for (let index = 0; index < 5; index += 1) {
      await Promise.resolve();
    }
    expect(vi.mocked(createWaSocket)).toHaveBeenCalled();
    const socketOptions = vi.mocked(createWaSocket).mock.calls.at(-1)?.[2] as
      | { onCredentialPersistenceTask?: (task: Promise<unknown>) => void }
      | undefined;
    socketOptions?.onCredentialPersistenceTask?.(keyRead);
    void keyRead.then(() => socketOptions?.onCredentialPersistenceTask?.(keyWrite));
    await vi.advanceTimersByTimeAsync(0);
    let settled = false;
    void pendingLogin.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseKeyRead();
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseKeyWrite();
    await expect(pendingLogin).resolves.toBeUndefined();
  });
});
