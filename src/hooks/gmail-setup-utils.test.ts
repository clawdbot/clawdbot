import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpawnResult } from "../process/exec.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";

const itUnix = process.platform === "win32" ? it.skip : it;
const { runCommandWithTimeoutMock } = vi.hoisted(() => ({
  runCommandWithTimeoutMock: vi.fn(),
}));

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: runCommandWithTimeoutMock,
}));

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

beforeEach(() => {
  runCommandWithTimeoutMock.mockReset();
});
afterEach(() => vi.restoreAllMocks());

async function loadGmailSetupUtils() {
  vi.resetModules();
  return await import("./gmail-setup-utils.js");
}

describe("ensureDependency binary availability", () => {
  afterEach(() => runCommandWithTimeoutMock.mockReset());

  it.each([true, false])(
    "checks the installed executable when installer creates it: %s",
    async (createsBinary) => {
      const { ensureDependency } = await loadGmailSetupUtils();
      await withTestDir({ prefix: "openclaw-dependency-probe-" }, async (root) => {
        const binDir = path.join(root, "bin");
        await fs.mkdir(binDir);
        const writeExecutable = async (name: string) => {
          const executable = path.join(binDir, name);
          await fs.writeFile(executable, "#!/bin/sh\nexit 0\n");
          await fs.chmod(executable, 0o755);
        };
        await writeExecutable("brew");
        await withEnvAsync({ PATH: binDir, XDG_CONFIG_HOME: path.join(root, "config") }, () =>
          withMockedPlatform("darwin", async () => {
            runCommandWithTimeoutMock.mockImplementation(async (argv: string[]) => {
              expect(argv).toEqual(["brew", "install", "fixture-probe-formula"]);
              if (createsBinary) {
                await writeExecutable("fixture-gmail-tool");
              }
              return {
                stdout: "",
                stderr: "",
                code: 0,
                signal: null,
                killed: false,
                termination: "exit",
              };
            });

            const install = () => ensureDependency("fixture-gmail-tool", ["fixture-probe-formula"]);
            if (createsBinary) {
              await expect(install()).resolves.toBeUndefined();
              await expect(install()).resolves.toBeUndefined();
            } else {
              await expect(install()).rejects.toThrow(
                "fixture-gmail-tool still not available after brew install",
              );
            }
            expect(process.env.PATH).toBe(binDir);
            expect(runCommandWithTimeoutMock).toHaveBeenCalledTimes(1);
          }),
        );
      });
    },
  );
});

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

describe("runGcloud interpreter resolution", () => {
  itUnix(
    "resolves a working python path and caches the result",
    async () => {
      const { runGcloud } = await loadGmailSetupUtils();
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-python-"));
      try {
        const realPython = path.join(tmp, "python-real");
        await fs.writeFile(realPython, "#!/bin/sh\nexit 0\n", "utf-8");
        await fs.chmod(realPython, 0o755);

        const shimDir = path.join(tmp, "shims");
        await fs.mkdir(shimDir, { recursive: true });
        const shim = path.join(shimDir, "python3");
        await fs.writeFile(shim, "#!/bin/sh\nexit 0\n", "utf-8");
        await fs.chmod(shim, 0o755);

        await withEnvAsync({ PATH: `${shimDir}${path.delimiter}/usr/bin` }, async () => {
          runCommandWithTimeoutMock
            .mockResolvedValueOnce({
              ...success,
              stdout: `${realPython}\n3.12\n`,
            })
            .mockResolvedValue(success);

          await runGcloud(["config", "list"]);

          await withEnvAsync({ PATH: "/bin" }, async () => {
            await runGcloud(["config", "list"]);
          });
          expect(runCommandWithTimeoutMock).toHaveBeenCalledTimes(3);
          expect(runCommandWithTimeoutMock).toHaveBeenLastCalledWith(["gcloud", "config", "list"], {
            timeoutMs: 120_000,
            env: { CLOUDSDK_PYTHON: realPython, CLOUDSDK_PYTHON_ARGS: undefined },
          });
        });
      } finally {
        await fs.rm(tmp, { recursive: true, force: true });
      }
    },
    60_000,
  );

  itUnix(
    "skips Python versions below and above gcloud's supported range",
    async () => {
      const { runGcloud } = await loadGmailSetupUtils();
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-python-ver-"));
      try {
        const oldPython = path.join(tmp, "python-old");
        await fs.writeFile(oldPython, "#!/bin/sh\nexit 0\n", "utf-8");
        await fs.chmod(oldPython, 0o755);
        const goodPython = path.join(tmp, "python-good");
        await fs.writeFile(goodPython, "#!/bin/sh\nexit 0\n", "utf-8");
        await fs.chmod(goodPython, 0o755);

        const shimDirs = ["old", "future", "supported"].map((name) =>
          path.join(tmp, `${name}-shims`),
        );
        for (const shimDir of shimDirs) {
          await fs.mkdir(shimDir, { recursive: true });
          const shim = path.join(shimDir, "python3");
          await fs.writeFile(shim, "#!/bin/sh\nexit 0\n", "utf-8");
          await fs.chmod(shim, 0o755);
        }

        await withEnvAsync({ PATH: shimDirs.join(path.delimiter) }, async () => {
          runCommandWithTimeoutMock
            // python3 -> Python 3.9 (unsupported by gcloud): must be skipped.
            .mockResolvedValueOnce({
              ...success,
              stdout: `${oldPython}\n3.9\n`,
            })
            // A future Python beyond gcloud's current cap must also be skipped.
            .mockResolvedValueOnce({
              ...success,
              stdout: `${path.join(tmp, "python-future")}\n3.15\n`,
            })
            // Python 3.12 is supported and should be selected.
            .mockResolvedValueOnce({
              ...success,
              stdout: `${goodPython}\n3.12\n`,
            })
            .mockResolvedValue(success);

          await runGcloud(["config", "list"]);

          expect(runCommandWithTimeoutMock).toHaveBeenLastCalledWith(["gcloud", "config", "list"], {
            timeoutMs: 120_000,
            env: { CLOUDSDK_PYTHON: goodPython, CLOUDSDK_PYTHON_ARGS: undefined },
          });
        });
      } finally {
        await fs.rm(tmp, { recursive: true, force: true });
      }
    },
    60_000,
  );
});

describe("runGcloud", () => {
  itUnix(
    "overrides an inherited CLOUDSDK_PYTHON value with a resolved interpreter",
    async () => {
      const { runGcloud } = await loadGmailSetupUtils();
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gcloud-python-"));
      try {
        const realPython = path.join(tmp, "python-real");
        await fs.writeFile(realPython, "#!/bin/sh\nexit 0\n", "utf-8");
        await fs.chmod(realPython, 0o755);

        const shimDir = path.join(tmp, "shims");
        await fs.mkdir(shimDir, { recursive: true });
        const shim = path.join(shimDir, "python3");
        await fs.writeFile(shim, "#!/bin/sh\nexit 0\n", "utf-8");
        await fs.chmod(shim, 0o755);

        await withEnvAsync(
          {
            CLOUDSDK_PYTHON: path.join(tmp, "evil", "python"),
            CLOUDSDK_PYTHON_ARGS: "-cprint('attacker')",
            PATH: `${shimDir}${path.delimiter}/usr/bin`,
          },
          async () => {
            runCommandWithTimeoutMock
              .mockResolvedValueOnce({
                ...success,
                stdout: `${realPython}\n3.12\n`,
              })
              .mockResolvedValueOnce(success);

            await runGcloud(["config", "list"]);

            expect(runCommandWithTimeoutMock).toHaveBeenLastCalledWith(
              ["gcloud", "config", "list"],
              {
                timeoutMs: 120_000,
                env: { CLOUDSDK_PYTHON: realPython, CLOUDSDK_PYTHON_ARGS: undefined },
              },
            );
          },
        );
      } finally {
        await fs.rm(tmp, { recursive: true, force: true });
      }
    },
    60_000,
  );

  itUnix("unsets inherited CLOUDSDK_PYTHON when no trusted interpreter is found", async () => {
    const { runGcloud } = await loadGmailSetupUtils();
    await withEnvAsync(
      {
        CLOUDSDK_PYTHON: "/tmp/attacker-python",
        CLOUDSDK_PYTHON_ARGS: "-cprint('attacker')",
        PATH: "",
      },
      async () => {
        runCommandWithTimeoutMock.mockResolvedValueOnce(success);

        await runGcloud(["config", "list"]);

        expect(runCommandWithTimeoutMock).toHaveBeenCalledTimes(1);
        expect(runCommandWithTimeoutMock).toHaveBeenCalledWith(["gcloud", "config", "list"], {
          timeoutMs: 120_000,
          env: { CLOUDSDK_PYTHON: undefined, CLOUDSDK_PYTHON_ARGS: undefined },
        });
      },
    );
  });
});

describe("ensureTailscaleEndpoint", () => {
  it("includes stdout and exit code when tailscale serve fails", async () => {
    const { ensureTailscaleEndpoint } = await loadGmailSetupUtils();
    runCommandWithTimeoutMock
      .mockResolvedValueOnce({
        ...success,
        stdout: JSON.stringify({ Self: { DNSName: "host.tailnet.ts.net." } }),
      })
      .mockResolvedValueOnce({
        ...success,
        stdout: "tailscale output",
        stderr: "Warning: client version mismatch",
        code: 1,
      });

    const { message } = await rejection(() =>
      ensureTailscaleEndpoint({
        mode: "serve",
        path: "/gmail-pubsub",
        port: 8788,
      }),
    );

    expect(message).toContain("code=1");
    expect(message).toContain("stderr: Warning: client version mismatch");
    expect(message).toContain("stdout: tailscale output");
  });

  it("includes JSON parse failure details with stdout", async () => {
    const { ensureTailscaleEndpoint } = await loadGmailSetupUtils();
    runCommandWithTimeoutMock.mockResolvedValueOnce({
      ...success,
      stdout: "not-json",
    });

    const { message } = await rejection(() =>
      ensureTailscaleEndpoint({
        mode: "funnel",
        path: "/gmail-pubsub",
        port: 8788,
      }),
    );

    expect(message).toContain("returned invalid JSON");
    expect(message).toContain("stdout: not-json");
    expect(message).toContain("code=0");
  });

  it("passes abort signal to tailscale status and serve commands", async () => {
    const { ensureTailscaleEndpoint } = await loadGmailSetupUtils();
    const abortController = new AbortController();
    runCommandWithTimeoutMock
      .mockResolvedValueOnce({
        ...success,
        stdout: JSON.stringify({ Self: { DNSName: "host.tailnet.ts.net." } }),
      })
      .mockResolvedValueOnce(success);

    await ensureTailscaleEndpoint({
      mode: "serve",
      path: "/gmail-pubsub",
      port: 8788,
      signal: abortController.signal,
    });

    expect(runCommandWithTimeoutMock).toHaveBeenNthCalledWith(
      1,
      ["tailscale", "status", "--json"],
      {
        timeoutMs: 30_000,
        signal: abortController.signal,
      },
    );
    expect(runCommandWithTimeoutMock).toHaveBeenNthCalledWith(
      2,
      ["tailscale", "serve", "--bg", "--set-path", "/gmail-pubsub", "--yes", "8788"],
      {
        timeoutMs: 30_000,
        signal: abortController.signal,
      },
    );
  });
});

describe("Gmail setup diagnostics and decisions", () => {
  const hasBinaryMock = vi.fn<(bin: string) => boolean>();
  let configEval: typeof import("../shared/config-eval.js");
  let utils: typeof import("./gmail-setup-utils.js");

  beforeAll(async () => {
    vi.resetModules();
    configEval = await import("../shared/config-eval.js");
    utils = await import("./gmail-setup-utils.js");
  });

  beforeEach(() => {
    // Keep real filesystem probes in the binary-availability cases above.
    hasBinaryMock.mockReset().mockReturnValue(true);
    vi.spyOn(configEval, "hasBinary").mockImplementation(hasBinaryMock);
  });

  it.each(["gcloud", "login", "brew", "tailscale status", "tailscale serve"])(
    "%s retains bounded tails from both streams",
    async (boundary) =>
      withEnvAsync({ PATH: "" }, async () => {
        runCommandWithTimeoutMock.mockResolvedValue(noisy);
        const run = async () => {
          if (boundary === "login") {
            runCommandWithTimeoutMock.mockResolvedValueOnce({ ...success, code: 1 });
            return utils.ensureGcloudAuth();
          }
          if (boundary === "brew") {
            hasBinaryMock.mockImplementation((bin: string) => bin === "brew");
            return withMockedPlatform("darwin", () => utils.ensureDependency("gog", ["gogcli"]));
          }
          if (boundary.startsWith("tailscale")) {
            if (boundary === "tailscale serve") {
              runCommandWithTimeoutMock.mockResolvedValueOnce({
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
        const { runGcloud } = utils;
        runCommandWithTimeoutMock.mockResolvedValue({ ...success, ...metadata });
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
    const { ensureTailscaleEndpoint } = utils;
    runCommandWithTimeoutMock.mockResolvedValue({
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
      const { runGcloud } = utils;
      const result = { ...noisy, code: 0 };
      runCommandWithTimeoutMock.mockResolvedValue(result);
      expect(await runGcloud(["config", "list"])).toBe(result);
    }));
  it.each([
    { code: 0, stdout: "account@example.com\n", login: false },
    { code: 0, stdout: " \n", login: true },
    { code: 1, stdout: "account@example.com\n", login: true },
  ])("auth list code=$code login=$login", async ({ code, stdout, login }) =>
    withEnvAsync({ PATH: "" }, async () => {
      const { ensureGcloudAuth } = utils;
      runCommandWithTimeoutMock
        .mockResolvedValueOnce({ ...success, code, stdout })
        .mockResolvedValue(success);
      await ensureGcloudAuth();
      expect(runCommandWithTimeoutMock).toHaveBeenCalledTimes(login ? 2 : 1);
      if (login) {
        expect(runCommandWithTimeoutMock.mock.calls[1]?.[0].slice(1)).toEqual(["auth", "login"]);
      }
    }),
  );

  it.each([0, 1])("provisions only according to describe exit code %i", async (code) =>
    withEnvAsync({ PATH: "" }, async () => {
      const { ensureTopic, ensureSubscription } = utils;
      runCommandWithTimeoutMock
        .mockResolvedValueOnce({ ...success, code })
        .mockResolvedValue(success);
      await ensureTopic("project", "topic");
      expect(runCommandWithTimeoutMock.mock.calls.map(([args]) => args.slice(1, 4))).toEqual(
        code === 0
          ? [["pubsub", "topics", "describe"]]
          : [
              ["pubsub", "topics", "describe"],
              ["pubsub", "topics", "create"],
            ],
      );
      runCommandWithTimeoutMock
        .mockReset()
        .mockResolvedValueOnce({ ...success, code })
        .mockResolvedValue(success);
      await ensureSubscription("project", "subscription", "topic", "https://example.com/push");
      expect(runCommandWithTimeoutMock.mock.calls.map(([args]) => args.slice(1, 4))).toEqual([
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
    const { ensureDependency } = utils;
    hasBinaryMock.mockImplementation(
      (bin: string) =>
        state === "installed" || (state === "post install missing" && bin === "brew"),
    );
    runCommandWithTimeoutMock.mockResolvedValue(success);
    await withMockedPlatform(platform, async () => {
      const result = ensureDependency("gog", ["gogcli"]);
      if (expected) {
        await expect(result).rejects.toThrow(expected);
      } else {
        await expect(result).resolves.toBeUndefined();
      }
    });
    expect(runCommandWithTimeoutMock).toHaveBeenCalledTimes(
      state === "post install missing" ? 1 : 0,
    );
  });
});
