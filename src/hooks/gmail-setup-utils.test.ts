import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const itUnix = process.platform === "win32" ? it.skip : it;

beforeEach(() => {
  vi.resetModules();
});

describe("resolvePythonExecutablePath", () => {
  itUnix(
    "resolves a working python path and caches the result",
    async () => {
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-python-"));
      const originalPath = process.env.PATH;
      try {
        const realPython = path.join(tmp, "python-real");
        await fs.writeFile(realPython, "#!/bin/sh\nexit 0\n", "utf-8");
        await fs.chmod(realPython, 0o755);

        const shimDir = path.join(tmp, "shims");
        await fs.mkdir(shimDir, { recursive: true });
        const shim = path.join(shimDir, "python3");
        await fs.writeFile(
          shim,
          `#!/bin/sh\nif [ "$1" = "-c" ]; then\n  echo "${realPython}"\n  exit 0\nfi\nexit 1\n`,
          "utf-8",
        );
        await fs.chmod(shim, 0o755);

        process.env.PATH = `${shimDir}${path.delimiter}/usr/bin`;

        const { resolvePythonExecutablePath } = await import("./gmail-setup-utils.js");

        const resolved = await resolvePythonExecutablePath();
        expect(resolved).toBe(realPython);

        process.env.PATH = "/bin";
        const cached = await resolvePythonExecutablePath();
        expect(cached).toBe(realPython);
      } finally {
        process.env.PATH = originalPath;
        await fs.rm(tmp, { recursive: true, force: true });
      }
    },
    60_000,
  );
});

describe("ensureTailscaleEndpoint", () => {
  it("includes stdout and exit code when tailscale serve fails", async () => {
    vi.doMock("../process/exec.js", () => ({
      runCommandWithTimeout: vi.fn(),
    }));

    const { ensureTailscaleEndpoint } = await import("./gmail-setup-utils.js");
    const { runCommandWithTimeout } = await import("../process/exec.js");
    const runCommand = vi.mocked(runCommandWithTimeout);

    runCommand
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
    vi.doMock("../process/exec.js", () => ({
      runCommandWithTimeout: vi.fn(),
    }));

    const { ensureTailscaleEndpoint } = await import("./gmail-setup-utils.js");
    const { runCommandWithTimeout } = await import("../process/exec.js");
    const runCommand = vi.mocked(runCommandWithTimeout);

    runCommand.mockResolvedValueOnce({
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
