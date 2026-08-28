import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpawnResult } from "../process/exec.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";

const mocks = vi.hoisted(() => ({ run: vi.fn(), hasBinary: vi.fn() }));
vi.mock("../process/exec.js", () => ({ runCommandWithTimeout: mocks.run }));
vi.mock("../skills/loading/config.js", () => ({ hasBinary: mocks.hasBinary }));

const success = {
  code: 0,
  stdout: "",
  stderr: "",
  signal: null,
  killed: false,
  termination: "exit",
} satisfies SpawnResult;
const progress = Array.from({ length: 1000 }, (_, i) => `progress ${i}`).join("\r");
const noisy = {
  ...success,
  code: 7,
  stdout: `${"x".repeat(30_000)}\r\nstdout final detail 🦞\r\n`,
  stderr: `${progress}\r\n\u001b[31mstderr final detail\u001b[0m\r\n`,
};

async function rejection(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected command failure");
}

beforeEach(() => {
  vi.resetModules();
  mocks.run.mockReset();
  mocks.hasBinary.mockReset().mockReturnValue(true);
});
afterEach(() => vi.restoreAllMocks());

describe("Gmail setup failure diagnostics", () => {
  it.each(["gcloud", "login", "brew", "tailscale status", "tailscale serve"])(
    "%s retains bounded tails from both streams",
    async (boundary) =>
      withEnvAsync({ PATH: "" }, async () => {
        const utils = await import("./gmail-setup-utils.js");
        mocks.run.mockResolvedValue(noisy);
        const run = async () => {
          if (boundary === "login") {
            mocks.run.mockResolvedValueOnce({ ...success, code: 1 });
            return utils.ensureGcloudAuth();
          }
          if (boundary === "brew") {
            mocks.hasBinary.mockImplementation((bin: string) => bin === "brew");
            return withMockedPlatform("darwin", () => utils.ensureDependency("gog", ["gogcli"]));
          }
          if (boundary.startsWith("tailscale")) {
            if (boundary === "tailscale serve") {
              mocks.run.mockResolvedValueOnce({
                ...success,
                stdout: '{"Self":{"DNSName":"fixture.example."}}',
              });
            }
            return utils.ensureTailscaleEndpoint({ mode: "serve", path: "/gmail", port: 8788 });
          }
          return utils.runGcloud([
            "pubsub",
            "subscriptions",
            "update",
            "fixture",
            "--push-endpoint",
            "https://example.com/?token=do-not-echo-argv",
          ]);
        };
        const { message } = await rejection(run);
        expect(message.length).toBeLessThan(2000);
        expect(message).toContain("code=7");
        expect(message).toContain("stderr:");
        expect(message).toContain("stdout:");
        expect(message).toContain("stdout final detail 🦞");
        expect(message).toContain("stderr final detail");
        expect(message).toContain("progress 999");
        expect(message).toContain("…");
        expect(message).not.toContain("\r");
        expect(message).not.toContain(String.fromCharCode(27));
        expect(message).not.toContain("do-not-echo-argv");
        if (boundary === "brew") {
          expect(message).toMatch(/brew install.*gog/);
        }
      }),
  );

  it.each([
    {
      termination: "timeout",
      code: 124,
      signal: "SIGKILL",
      killed: true,
      reason: "termination=timeout",
    },
    {
      termination: "no-output-timeout",
      code: 124,
      signal: "SIGTERM",
      killed: true,
      reason: "termination=no-output-timeout",
    },
    {
      termination: "signal",
      code: null,
      signal: null,
      killed: false,
      reason: "termination=signal",
    },
    {
      termination: "signal",
      code: null,
      signal: "SIGTERM",
      killed: true,
      reason: "termination=signal",
    },
    {
      termination: "signal",
      code: null,
      signal: "SIGKILL",
      killed: true,
      outputLimitExceeded: true,
      reason: "termination=output-limit",
    },
    { termination: "exit", code: 124, signal: null, killed: false, reason: "termination=exit" },
  ] satisfies Array<Partial<SpawnResult> & { reason: string }>)(
    "retains $reason with code=$code even without output",
    async ({ reason, ...metadata }) =>
      withEnvAsync({ PATH: "" }, async () => {
        const { runGcloud } = await import("./gmail-setup-utils.js");
        mocks.run.mockResolvedValue({ ...success, ...metadata });
        const { message } = await rejection(() => runGcloud(["config", "list"]));
        expect(message).toContain(reason);
        expect(message).toContain(`code=${metadata.code}`);
        if (metadata.signal) {
          expect(message).toContain(`signal=${metadata.signal}`);
        }
        if (metadata.killed) {
          expect(message).toContain("killed=true");
        }
        if (metadata.termination === "exit") {
          expect(message).not.toMatch(/timeout|timed out/);
        }
      }),
  );

  it("bounds invalid JSON diagnostics while retaining the parser cause and successful exit metadata", async () => {
    const { ensureTailscaleEndpoint } = await import("./gmail-setup-utils.js");
    mocks.run.mockResolvedValue({
      ...noisy,
      code: 0,
      stdout: `{"value":"${"x".repeat(30_000)}"}invalid-tail`,
    });
    const error = await rejection(() =>
      ensureTailscaleEndpoint({ mode: "serve", path: "/gmail", port: 8788 }),
    );
    expect(error.message.length).toBeLessThan(3000);
    expect(error.message).toContain("returned invalid JSON");
    expect(error.message).toContain("code=0");
    expect(error.message).toContain("stdout:");
    expect(error.message).toContain("invalid-tail");
    expect(error.message).toContain("stderr final detail");
    expect(error.cause).toBeInstanceOf(SyntaxError);
  });

  it("keeps successful gcloud output untouched", async () =>
    withEnvAsync({ PATH: "" }, async () => {
      const { runGcloud } = await import("./gmail-setup-utils.js");
      const result = { ...noisy, code: 0 };
      mocks.run.mockResolvedValue(result);
      expect(await runGcloud(["config", "list"])).toBe(result);
    }));
});

describe("Gmail setup decisions", () => {
  it.each([
    { code: 0, stdout: "account@example.com\n", login: false },
    { code: 0, stdout: " \n", login: true },
    { code: 1, stdout: "account@example.com\n", login: true },
  ])("auth list code=$code login=$login", async ({ code, stdout, login }) =>
    withEnvAsync({ PATH: "" }, async () => {
      const { ensureGcloudAuth } = await import("./gmail-setup-utils.js");
      mocks.run.mockResolvedValueOnce({ ...success, code, stdout }).mockResolvedValue(success);
      await ensureGcloudAuth();
      expect(mocks.run).toHaveBeenCalledTimes(login ? 2 : 1);
      if (login) {
        expect(mocks.run.mock.calls[1]?.[0].slice(1)).toEqual(["auth", "login"]);
      }
    }),
  );

  it.each([0, 1])("provisions only according to describe exit code %i", async (code) =>
    withEnvAsync({ PATH: "" }, async () => {
      const { ensureTopic, ensureSubscription } = await import("./gmail-setup-utils.js");
      mocks.run.mockResolvedValueOnce({ ...success, code }).mockResolvedValue(success);
      await ensureTopic("project", "topic");
      expect(mocks.run.mock.calls.map(([args]) => args.slice(1, 4))).toEqual(
        code === 0
          ? [["pubsub", "topics", "describe"]]
          : [
              ["pubsub", "topics", "describe"],
              ["pubsub", "topics", "create"],
            ],
      );
      mocks.run
        .mockReset()
        .mockResolvedValueOnce({ ...success, code })
        .mockResolvedValue(success);
      await ensureSubscription("project", "subscription", "topic", "https://example.com/push");
      expect(mocks.run.mock.calls.map(([args]) => args.slice(1, 4))).toEqual([
        ["pubsub", "subscriptions", "describe"],
        ["pubsub", "subscriptions", code === 0 ? "update" : "create"],
      ]);
    }),
  );

  it.each([
    { state: "installed", platform: "darwin", expected: undefined },
    { state: "missing", platform: "linux", expected: "gog not installed; install it and retry" },
    {
      state: "no brew",
      platform: "darwin",
      expected: "Homebrew not installed (install brew and retry)",
    },
    {
      state: "post install missing",
      platform: "darwin",
      expected: "gog still not available after brew install",
    },
  ] as const)("retains dependency guidance: $state", async ({ state, platform, expected }) => {
    const { ensureDependency } = await import("./gmail-setup-utils.js");
    mocks.hasBinary.mockImplementation(
      (bin: string) =>
        state === "installed" || (state === "post install missing" && bin === "brew"),
    );
    mocks.run.mockResolvedValue(success);
    await withMockedPlatform(platform, async () => {
      const result = ensureDependency("gog", ["gogcli"]);
      if (expected) {
        await expect(result).rejects.toThrow(expected);
      } else {
        await expect(result).resolves.toBeUndefined();
      }
    });
    expect(mocks.run).toHaveBeenCalledTimes(state === "post install missing" ? 1 : 0);
  });
});
