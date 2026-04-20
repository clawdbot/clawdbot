import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { resetLogger, setLoggerOverride } from "openclaw/plugin-sdk/runtime-env";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { renderQrPngBase64 } from "./qr-image.js";

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
      expect.stringContaining("✅ Recovered from creds.json.bak; web session ready."),
    );
    consoleLog.mockRestore();
  });
});

describe("renderQrPngBase64", () => {
  it("renders a PNG data payload", async () => {
    const b64 = await renderQrPngBase64("openclaw");
    const buf = Buffer.from(b64, "base64");
    expect(buf.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  });

  it("avoids dynamic require of qrcode-terminal vendor modules", async () => {
    const sourcePath = resolve(process.cwd(), "src/media/qr-image.ts");
    const source = await readFile(sourcePath, "utf-8");
    expect(source).not.toContain("createRequire(");
    expect(source).not.toContain('require("qrcode-terminal/vendor/QRCode")');
    expect(source).toContain("qrcode-terminal/vendor/QRCode/index.js");
    expect(source).toContain("qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel.js");
  });
});
