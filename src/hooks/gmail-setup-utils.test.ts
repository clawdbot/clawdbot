import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import {
  ensureTailscaleEndpoint,
  resetGmailSetupUtilsCachesForTest,
  resolvePythonExecutablePath,
  runGcloud,
} from "./gmail-setup-utils.js";

const itUnix = process.platform === "win32" ? it.skip : it;
const runCommandWithTimeoutMock = vi.fn();

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: (...args: unknown[]) => runCommandWithTimeoutMock(...args),
}));

beforeEach(() => {
  runCommandWithTimeoutMock.mockClear();
  resetGmailSetupUtilsCachesForTest();
});

describe("resolvePythonExecutablePath", () => {
  itUnix(
    "resolves a working python path and caches the result",
    async () => {
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
          runCommandWithTimeoutMock.mockResolvedValue({
            stdout: `${realPython}\n`,
            stderr: "",
            code: 0,
            signal: null,
            killed: false,
          });

          const resolved = await resolvePythonExecutablePath();
          expect(resolved).toBe(realPython);

          await withEnvAsync({ PATH: "/bin" }, async () => {
            const cached = await resolvePythonExecutablePath();
            expect(cached).toBe(realPython);
          });
          expect(runCommandWithTimeoutMock).toHaveBeenCalledTimes(1);
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
            PATH: `${shimDir}${path.delimiter}/usr/bin`,
          },
          async () => {
            runCommandWithTimeoutMock
              .mockResolvedValueOnce({
                stdout: `${realPython}\n`,
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
                env: { CLOUDSDK_PYTHON: realPython },
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
    await withEnvAsync(
      {
        CLOUDSDK_PYTHON: "/tmp/attacker-python",
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
          env: { CLOUDSDK_PYTHON: undefined },
        });
      },
    );
  });
});

describe("ensureTailscaleEndpoint", () => {
  it("includes stdout and exit code when tailscale serve fails", async () => {
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
});
