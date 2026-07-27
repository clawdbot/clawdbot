// Tlon monitor tests cover authentication retry scheduling.
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import { describe, expect, it, vi } from "vitest";

const { authenticateMock, sleepWithAbortMock } = vi.hoisted(() => ({
  authenticateMock: vi.fn(),
  sleepWithAbortMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/runtime-env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/runtime-env")>();
  return {
    ...actual,
    sleepWithAbort: sleepWithAbortMock,
  };
});

vi.mock("../runtime.js", () => ({
  getTlonRuntime: () => ({
    config: {
      current: () => ({
        channels: {
          tlon: {
            code: "code",
            ship: "~zod",
            url: "https://urbit.example.com",
          },
        },
      }),
    },
    logging: {
      getChildLogger: () => ({}),
    },
  }),
}));

vi.mock("../urbit/auth.js", () => ({
  authenticate: authenticateMock,
}));

import { monitorTlonProvider } from "./index.js";

describe("monitorTlonProvider authentication retry", () => {
  it("uses the shared abort-aware sleep for retry backoff", async () => {
    const controller = new AbortController();
    const runtime = { error: vi.fn(), exit: vi.fn(), log: vi.fn() } satisfies RuntimeEnv;
    authenticateMock.mockRejectedValueOnce(new Error("login failed"));
    sleepWithAbortMock.mockRejectedValueOnce(new Error("aborted"));

    await expect(
      monitorTlonProvider({
        abortSignal: controller.signal,
        runtime,
      }),
    ).rejects.toThrow("aborted");

    expect(authenticateMock).toHaveBeenCalledTimes(1);
    expect(sleepWithAbortMock).toHaveBeenCalledWith(1_000, controller.signal);
  });
});
