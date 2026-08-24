// Gmail setup utility tests cover setup file generation and config handling.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
const itUnix = process.platform === "win32" ? it.skip : it;
const runCommandWithTimeoutMock = vi.fn();

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: (...args: unknown[]) => runCommandWithTimeoutMock(...args),
}));

beforeEach(() => {
  vi.resetModules();
  runCommandWithTimeoutMock.mockClear();
});

async function loadGmailSetupUtils() {
  return await import("./gmail-setup-utils.js");
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
              stdout: `${realPython}\n3.12\n`,
              stderr: "",
              code: 0,
              signal: null,
              killed: false,
            })
            .mockResolvedValue({
              stdout: "",
              stderr: "",
              code: 0,
              signal: null,
              killed: false,
            });

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
              stdout: `${oldPython}\n3.9\n`,
              stderr: "",
              code: 0,
              signal: null,
              killed: false,
            })
            // A future Python beyond gcloud's current cap must also be skipped.
            .mockResolvedValueOnce({
              stdout: `${path.join(tmp, "python-future")}\n3.15\n`,
              stderr: "",
              code: 0,
              signal: null,
              killed: false,
            })
            // Python 3.12 is supported and should be selected.
            .mockResolvedValueOnce({
              stdout: `${goodPython}\n3.12\n`,
              stderr: "",
              code: 0,
              signal: null,
              killed: false,
            })
            .mockResolvedValue({
              stdout: "",
              stderr: "",
              code: 0,
              signal: null,
              killed: false,
            });

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
                stdout: `${realPython}\n3.12\n`,
                stderr: "",
                code: 0,
                signal: null,
                killed: false,
              })
              .mockResolvedValueOnce({
                stdout: "",
                stderr: "",
                code: 0,
                signal: null,
                killed: false,
              });

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
        runCommandWithTimeoutMock.mockResolvedValueOnce({
          stdout: "",
          stderr: "",
          code: 0,
          signal: null,
          killed: false,
        });

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
        stdout: JSON.stringify({ Self: { DNSName: "host.tailnet.ts.net." } }),
        stderr: "",
        code: 0,
        signal: null,
        killed: false,
      })
      .mockResolvedValueOnce({
        stdout: "tailscale output",
        stderr: "Warning: client version mismatch",
        code: 1,
        signal: null,
        killed: false,
      });

    let message = "";
    try {
      await ensureTailscaleEndpoint({
        mode: "serve",
        path: "/gmail-pubsub",
        port: 8788,
      });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }

    expect(message).toContain("code=1");
    expect(message).toContain("stderr: Warning: client version mismatch");
    expect(message).toContain("stdout: tailscale output");
  });

  it("includes JSON parse failure details with stdout", async () => {
    const { ensureTailscaleEndpoint } = await loadGmailSetupUtils();
    runCommandWithTimeoutMock.mockResolvedValueOnce({
      stdout: "not-json",
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
    });

    let message = "";
    try {
      await ensureTailscaleEndpoint({
        mode: "funnel",
        path: "/gmail-pubsub",
        port: 8788,
      });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }

    expect(message).toContain("returned invalid JSON");
    expect(message).toContain("stdout: not-json");
    expect(message).toContain("code=0");
  });

  it("passes abort signal to tailscale status and serve commands", async () => {
    const { ensureTailscaleEndpoint } = await loadGmailSetupUtils();
    const abortController = new AbortController();
    runCommandWithTimeoutMock
      .mockResolvedValueOnce({
        stdout: JSON.stringify({ Self: { DNSName: "host.tailnet.ts.net." } }),
        stderr: "",
        code: 0,
        signal: null,
        killed: false,
      })
      .mockResolvedValueOnce({
        stdout: "",
        stderr: "",
        code: 0,
        signal: null,
        killed: false,
      });

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
