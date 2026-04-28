import { rmSync } from "node:fs";
import fs from "node:fs/promises";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loginWeb } from "./login.js";
import { createWaSocket, formatError, waitForWaConnection } from "./session.js";

const rmMock = vi.spyOn(fs, "rm");
const testState = vi.hoisted(() => ({
  authDir: `${(process.env.TMPDIR ?? "/tmp").replace(/\/+$/, "")}/openclaw-wa-creds-${process.pid}-${Math.random().toString(16).slice(2)}`,
}));

function resolveTestAuthDir() {
  return testState.authDir;
}

vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", async () => {
  const actual = await vi.importActual<
    typeof import("openclaw/plugin-sdk/runtime-config-snapshot")
  >("openclaw/plugin-sdk/runtime-config-snapshot");
  return {
    ...actual,
    getRuntimeConfig: () =>
      ({
        channels: {
          whatsapp: {
            accounts: {
              default: { enabled: true, authDir: resolveTestAuthDir() },
            },
          },
        },
      }) as never,
  };
});

vi.mock("./session.js", async () => {
  const actual = await vi.importActual<typeof import("./session.js")>("./session.js");
  const authDir = resolveTestAuthDir();
  const sockA = { ws: { close: vi.fn() } };
  const sockB = { ws: { close: vi.fn() } };
  const createWaSocket = vi.fn(async () => (createWaSocket.mock.calls.length <= 1 ? sockA : sockB));
  const waitForWaConnection = vi.fn();
  const formatError = vi.fn((err: unknown) => `formatted:${String(err)}`);
  const getStatusCode = vi.fn(
    (err: unknown) =>
      (err as { output?: { statusCode?: number } })?.output?.statusCode ??
      (err as { status?: number })?.status ??
      (err as { error?: { output?: { statusCode?: number } } })?.error?.output?.statusCode,
  );
  return {
    ...actual,
    createWaSocket,
    waitForWaConnection,
    formatError,
    getStatusCode,
    WA_WEB_AUTH_DIR: authDir,
    logoutWeb: vi.fn(async (params: { authDir?: string }) => {
      await fs.rm(params.authDir ?? authDir, {
        recursive: true,
        force: true,
      });
      return true;
    }),
  };
});

const createWaSocketMock = vi.mocked(createWaSocket);
const waitForWaConnectionMock = vi.mocked(waitForWaConnection);
const formatErrorMock = vi.mocked(formatError);

async function flushTasks() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("loginWeb coverage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    createWaSocketMock.mockClear();
    waitForWaConnectionMock.mockReset().mockResolvedValue(undefined);
    formatErrorMock.mockReset().mockImplementation((err: unknown) => `formatted:${String(err)}`);
    rmMock.mockClear();
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });
  afterAll(() => {
    rmSync(testState.authDir, { recursive: true, force: true });
  });

  it("restarts once when WhatsApp requests code 515", async () => {
    waitForWaConnectionMock
      .mockRejectedValueOnce({ error: { output: { statusCode: 515 } } })
      .mockResolvedValueOnce(undefined);

    const runtime = { log: vi.fn(), error: vi.fn() } as never;
    const pendingLogin = loginWeb(false, waitForWaConnectionMock as never, runtime);
    await flushTasks();

    expect(createWaSocketMock).toHaveBeenCalledTimes(2);
    await pendingLogin;

    expect(createWaSocketMock).toHaveBeenCalledTimes(2);
    const firstSock = await createWaSocketMock.mock.results[0]?.value;
    expect(firstSock.ws.close).toHaveBeenCalled();
    vi.runAllTimers();
    const secondSock = await createWaSocketMock.mock.results[1]?.value;
    expect(secondSock.ws.close).toHaveBeenCalled();
  });

  it("clears creds and throws when logged out", async () => {
    waitForWaConnectionMock.mockRejectedValueOnce({
      output: { statusCode: 401 },
    });

    await expect(loginWeb(false, waitForWaConnectionMock as never)).rejects.toThrow(
      /cache cleared/i,
    );
    expect(rmMock).toHaveBeenCalledWith(testState.authDir, {
      recursive: true,
      force: true,
    });
  });

  it("formats and rethrows generic errors", async () => {
    waitForWaConnectionMock.mockRejectedValueOnce(new Error("boom"));
    await expect(loginWeb(false, waitForWaConnectionMock as never)).rejects.toThrow(
      "formatted:Error: boom",
    );
    expect(formatErrorMock).toHaveBeenCalled();
  });
});
