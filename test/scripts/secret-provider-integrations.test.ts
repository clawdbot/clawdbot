// Secret Provider Integrations tests cover secret provider integrations script behavior.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveWindowsTaskkillPath } from "../../scripts/lib/windows-taskkill.mjs";

const tempDirs: string[] = [];
const harnessPath = path.resolve("test/scripts/fixtures/secret-provider-integrations-harness.mjs");
const proofScriptPath = path.resolve("scripts/e2e/secret-provider-integrations.mjs");

function expectedTaskkillPath(): string {
  return resolveWindowsTaskkillPath();
}

function makeTempDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-secret-provider-proof-"));
  tempDirs.push(root);
  return root;
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  }
  throw new Error("condition was not met before timeout");
}

// writeFileSync is not atomic for concurrent readers: the pid file can exist
// before its payload is flushed, so wait for non-empty content or the parse
// races into NaN under parallel-suite load.
async function waitForPidFile(pidPath: string, timeoutMs = 10_000): Promise<number> {
  let content = "";
  await waitFor(() => {
    try {
      content = fs.readFileSync(pidPath, "utf8").trim();
    } catch {
      return false;
    }
    return content.length > 0;
  }, timeoutMs);
  return Number.parseInt(content, 10);
}

async function waitForChildClose(child: ReturnType<typeof spawn>, timeoutMs = 5_000) {
  return await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("child did not close before timeout"));
      }, timeoutMs);
      child.once("close", (code, signal) => {
        clearTimeout(timeout);
        resolve({ code, signal });
      });
    },
  );
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function writeStallingOpenClaw(
  root: string,
  options: {
    gatewayDescendantMarkerPath?: string;
    gatewayMarkerPath?: string;
    ignoreGatewaySigterm?: boolean;
  } = {},
): string {
  const descendantScript = options.gatewayDescendantMarkerPath
    ? [
        "import fs from 'node:fs';",
        "process.on('SIGTERM', () => {});",
        `setInterval(() => fs.appendFileSync(${JSON.stringify(
          options.gatewayDescendantMarkerPath,
        )}, "x"), 20);`,
      ].join("\n")
    : "";
  const scriptPath = path.join(root, "fake-openclaw.mjs");
  fs.writeFileSync(
    scriptPath,
    [
      "#!/usr/bin/env node",
      "import childProcess from 'node:child_process';",
      "import fs from 'node:fs';",
      "import { setTimeout as delay } from 'node:timers/promises';",
      "const args = process.argv.slice(2);",
      "if (args[0] === 'gateway' && args[1] === 'run') {",
      options.gatewayDescendantMarkerPath
        ? `  childProcess.spawn(process.execPath, ["--input-type=module", "--eval", ${JSON.stringify(
            descendantScript,
          )}], { stdio: "ignore" });`
        : "",
      options.ignoreGatewaySigterm
        ? "  process.once('SIGTERM', () => {});"
        : "  process.once('SIGTERM', () => process.exit(0));",
      "  process.once('SIGINT', () => process.exit(0));",
      options.gatewayMarkerPath
        ? `  setInterval(() => fs.appendFileSync(${JSON.stringify(options.gatewayMarkerPath)}, "x"), 20);`
        : "",
      "  await delay(60_000);",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'gateway' && (args[1] === 'call' || args[1] === 'status')) {",
      "  await delay(60_000);",
      "  process.exit(0);",
      "}",
      "console.error(`unexpected fake openclaw args: ${args.join(' ')}`);",
      "process.exit(2);",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return scriptPath;
}

function writeLeakingStartupOpenClaw(root: string): string {
  const scriptPath = path.join(root, "fake-leaking-openclaw.mjs");
  fs.writeFileSync(
    scriptPath,
    [
      "#!/usr/bin/env node",
      "const args = process.argv.slice(2);",
      "if (args[0] === 'gateway' && args[1] === 'run') {",
      "  process.stderr.write('x'.repeat(2048));",
      "  process.stderr.write('proof-gateway-token-v1');",
      "  process.exit(1);",
      "}",
      "process.exit(2);",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return scriptPath;
}

function writeSignaledStartupOpenClaw(root: string): string {
  const scriptPath = path.join(root, "fake-signaled-openclaw.mjs");
  fs.writeFileSync(
    scriptPath,
    [
      "#!/usr/bin/env node",
      "import { setTimeout as delay } from 'node:timers/promises';",
      "const args = process.argv.slice(2);",
      "if (args[0] === 'gateway' && args[1] === 'run') {",
      "  setTimeout(() => process.kill(process.pid, 'SIGTERM'), 50);",
      "  await new Promise(() => {});",
      "}",
      "if (args[0] === 'gateway' && (args[1] === 'call' || args[1] === 'status')) {",
      "  await delay(60_000);",
      "}",
      "process.exit(2);",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return scriptPath;
}

function writeNoisySecretsConfigureOpenClaw(root: string): string {
  const scriptPath = path.join(root, "fake-noisy-secrets-configure-openclaw.mjs");
  fs.writeFileSync(
    scriptPath,
    [
      "#!/usr/bin/env node",
      "const args = process.argv.slice(2);",
      "if (args[0] === 'secrets' && args[1] === 'configure') {",
      "  process.stdout.write('x'.repeat(4096));",
      "  process.exit(7);",
      "}",
      "process.exit(2);",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return scriptPath;
}

function runProofHarness(
  root: string,
  fakeOpenClaw: string,
  mode: "start" | "startup-fails" | "status",
  envOverrides: NodeJS.ProcessEnv = {},
) {
  return spawnSync(process.execPath, [harnessPath, proofScriptPath, root, mode], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      OPENCLAW_ENTRY: fakeOpenClaw,
      OPENCLAW_SECRET_PROOF_READY_MS: "60",
      OPENCLAW_SECRET_PROOF_RPC_MS: "1000",
      ...envOverrides,
    },
    timeout: 5_000,
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("secret provider integration proof harness", () => {
  it("runs pnpm-backed OpenClaw commands through the repo pnpm runner", async () => {
    const root = makeTempDir();
    const fakePnpm = path.join(root, "pnpm.cjs");
    fs.writeFileSync(fakePnpm, "#!/usr/bin/env node\n", { mode: 0o755 });
    const proof = await import(`${pathToFileURL(proofScriptPath).href}?case=${Date.now()}`);

    const command = await proof.resolveOpenClawCommand(
      ["gateway", "status"],
      { ...process.env, OPENCLAW_SECRET_PROOF_SENTINEL: "1" },
      {
        nodeExecPath: "/opt/node/bin/node",
        npmExecPath: fakePnpm,
        runner: { pnpm: true, baseArgs: ["openclaw"], label: "pnpm openclaw" },
      },
    );

    expect(command.command).toBe("/opt/node/bin/node");
    expect(command.args).toEqual([fakePnpm, "openclaw", "gateway", "status"]);
    expect(command.options.env.OPENCLAW_SECRET_PROOF_SENTINEL).toBe("1");
    expect(command.options.shell).toBe(false);
  });

  it("keeps stalled startup health probes inside the ready deadline", async () => {
    const root = makeTempDir();
    const fakeOpenClaw = writeStallingOpenClaw(root);
    const result = runProofHarness(root, fakeOpenClaw, "start");

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.message).toContain("gateway did not become ready");
    expect(payload.elapsedMs).toBeLessThan(750);
  });

  it("fails fast when startup exits by signal", () => {
    const root = makeTempDir();
    const fakeOpenClaw = writeSignaledStartupOpenClaw(root);
    const result = runProofHarness(root, fakeOpenClaw, "start", {
      OPENCLAW_SECRET_PROOF_READY_MS: "2000",
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.message).toContain("gateway exited during startup (signal SIGTERM)");
    expect(payload.elapsedMs).toBeLessThan(750);
  });

  it("kills a stalled startup gateway before returning a readiness failure", async () => {
    const root = makeTempDir();
    const markerPath = path.join(root, "gateway-marker.txt");
    const fakeOpenClaw = writeStallingOpenClaw(root, {
      gatewayDescendantMarkerPath: markerPath,
    });
    const result = runProofHarness(root, fakeOpenClaw, "start", {
      OPENCLAW_SECRET_PROOF_TEARDOWN_GRACE_MS: "100",
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.message).toContain("gateway did not become ready");
    expect(payload.elapsedMs).toBeLessThan(1250);

    const sizeAfterReturn = fs.existsSync(markerPath) ? fs.statSync(markerPath).size : 0;
    await new Promise((resolve) => {
      setTimeout(resolve, 250);
    });
    const sizeAfterWait = fs.existsSync(markerPath) ? fs.statSync(markerPath).size : 0;
    expect(sizeAfterWait).toBe(sizeAfterReturn);
  });

  it("bounds captured command output", async () => {
    const previousLimit = process.env.OPENCLAW_SECRET_PROOF_OUTPUT_BYTES;
    process.env.OPENCLAW_SECRET_PROOF_OUTPUT_BYTES = "1024";
    try {
      const proof = await import(
        `${pathToFileURL(proofScriptPath).href}?case=output-${Date.now()}`
      );
      const result = await proof.runCommand(process.execPath, [
        "--input-type=module",
        "--eval",
        "process.stdout.write('x'.repeat(4096));",
      ]);

      expect(result.stdout.length).toBeLessThan(1400);
      expect(result.stdout).toContain("stdout truncated after 1024 bytes");
    } finally {
      if (previousLimit === undefined) {
        delete process.env.OPENCLAW_SECRET_PROOF_OUTPUT_BYTES;
      } else {
        process.env.OPENCLAW_SECRET_PROOF_OUTPUT_BYTES = previousLimit;
      }
    }
  });

  it("clamps oversized command timeout env values before scheduling timers", async () => {
    const previousTimeout = process.env.OPENCLAW_SECRET_PROOF_COMMAND_MS;
    process.env.OPENCLAW_SECRET_PROOF_COMMAND_MS = String(Number.MAX_SAFE_INTEGER);
    try {
      const proof = await import(
        `${pathToFileURL(proofScriptPath).href}?case=command-timeout-clamp-${Date.now()}`
      );

      await expect(
        proof.runCommand(process.execPath, [
          "--input-type=module",
          "--eval",
          "setTimeout(() => process.exit(0), 25);",
        ]),
      ).resolves.toMatchObject({ code: 0 });
    } finally {
      if (previousTimeout === undefined) {
        delete process.env.OPENCLAW_SECRET_PROOF_COMMAND_MS;
      } else {
        process.env.OPENCLAW_SECRET_PROOF_COMMAND_MS = previousTimeout;
      }
    }
  });

  it("parses JSON command output without swallowing brace-heavy diagnostics", async () => {
    const proof = await import(`${pathToFileURL(proofScriptPath).href}?case=json-${Date.now()}`);

    expect(
      proof.parseJsonOutput(
        [
          "warning: ignored diagnostic {not json}",
          JSON.stringify({ ok: true, nested: { value: "kept" } }, null, 2),
          "debug: trailing diagnostic {also ignored}",
        ].join("\n"),
      ),
    ).toEqual({ ok: true, nested: { value: "kept" } });
  });

  it("records optional proof omissions as skips instead of passes", async () => {
    const proof = await import(`${pathToFileURL(proofScriptPath).href}?case=skip-${Date.now()}`);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const entry = await proof.runWithProof("PX", "optional live proof", async () =>
        proof.skipProof("missing live credential"),
      );

      expect(entry.status).toBe("skip");
      expect(entry.evidence).toBe("missing live credential");
      expect(log).toHaveBeenCalledWith(expect.stringContaining("[SKIP] PX optional live proof"));
    } finally {
      log.mockRestore();
    }
  });

  it("blocks skipped secret proofs unless local rehearsals explicitly allow skips", async () => {
    const previousAllowSkips = process.env.OPENCLAW_SECRET_PROOF_ALLOW_SKIPS;
    const proof = await import(
      `${pathToFileURL(proofScriptPath).href}?case=skip-block-${Date.now()}`
    );
    const entries = [{ name: "PX", status: "skip", elapsedMs: 1, evidence: "missing service" }];

    try {
      delete process.env.OPENCLAW_SECRET_PROOF_ALLOW_SKIPS;
      expect(proof.collectBlockingProofResults(entries)).toEqual(entries);

      process.env.OPENCLAW_SECRET_PROOF_ALLOW_SKIPS = "1";
      expect(proof.collectBlockingProofResults(entries)).toEqual([]);
    } finally {
      if (previousAllowSkips === undefined) {
        delete process.env.OPENCLAW_SECRET_PROOF_ALLOW_SKIPS;
      } else {
        process.env.OPENCLAW_SECRET_PROOF_ALLOW_SKIPS = previousAllowSkips;
      }
    }
  });

  it("fails allowed-failure probes when the command exits nonzero", async () => {
    const proof = await import(
      `${pathToFileURL(proofScriptPath).href}?case=allowed-failure-${Date.now()}`
    );

    expect(() =>
      proof.assertAllowedFailureCommandSucceeded(
        {
          code: 1,
          signal: null,
          stderr: "resolver invoked openai-profile",
          stdout: "openai-profile",
        },
        "auth-profile SecretRef model status probe",
        "openai-profile\nresolver invoked",
      ),
    ).toThrow("auth-profile SecretRef model status probe failed (1)");
  });

  it.runIf(process.platform !== "win32")("bounds captured PTY configure output", async () => {
    const root = makeTempDir();
    const fakeOpenClaw = writeNoisySecretsConfigureOpenClaw(root);
    const previousLimit = process.env.OPENCLAW_SECRET_PROOF_OUTPUT_BYTES;
    const previousEntry = process.env.OPENCLAW_ENTRY;
    process.env.OPENCLAW_SECRET_PROOF_OUTPUT_BYTES = "128";
    process.env.OPENCLAW_ENTRY = fakeOpenClaw;
    try {
      const proof = await import(
        `${pathToFileURL(proofScriptPath).href}?case=pty-output-${Date.now()}`
      );

      const error = await proof
        .runPtySecretsConfigurePreset({
          env: {
            ...process.env,
            OPENCLAW_ENTRY: fakeOpenClaw,
          },
        })
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("secrets configure preset failed (7)");
      expect((error as Error).message).toContain(
        "secrets configure stdout truncated after 128 bytes",
      );
      expect((error as Error).message.length).toBeLessThan(600);
    } finally {
      if (previousLimit === undefined) {
        delete process.env.OPENCLAW_SECRET_PROOF_OUTPUT_BYTES;
      } else {
        process.env.OPENCLAW_SECRET_PROOF_OUTPUT_BYTES = previousLimit;
      }
      if (previousEntry === undefined) {
        delete process.env.OPENCLAW_ENTRY;
      } else {
        process.env.OPENCLAW_ENTRY = previousEntry;
      }
    }
  });

  it.runIf(process.platform !== "win32")(
    "cleans PTY configure descendants before timeout failure",
    async () => {
      const root = makeTempDir();
      const fakeOpenClaw = path.join(root, "fake-openclaw-pty-timeout.mjs");
      const descendantPidPath = path.join(root, "descendant.pid");
      const readyPath = path.join(root, "ready");
      let descendantPid = 0;
      const previousEntry = process.env.OPENCLAW_ENTRY;
      const descendantScript = [
        "import fs from 'node:fs';",
        "process.on('SIGHUP', () => {});",
        "process.on('SIGTERM', () => {});",
        `fs.writeFileSync(${JSON.stringify(readyPath)}, 'ready');`,
        "setInterval(() => {}, 1000);",
      ].join("\n");
      fs.writeFileSync(
        fakeOpenClaw,
        [
          "#!/usr/bin/env node",
          "import childProcess from 'node:child_process';",
          "import fs from 'node:fs';",
          "const descendant = childProcess.spawn(process.execPath, [",
          "  '--input-type=module',",
          `  '--eval', ${JSON.stringify(descendantScript)},`,
          "], { stdio: 'ignore' });",
          `fs.writeFileSync(${JSON.stringify(descendantPidPath)}, String(descendant.pid));`,
          "setInterval(() => {}, 1000);",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      process.env.OPENCLAW_ENTRY = fakeOpenClaw;
      const proof = await import(
        `${pathToFileURL(proofScriptPath).href}?case=pty-timeout-${Date.now()}`
      );

      try {
        const result = proof.runPtySecretsConfigurePreset(
          {
            env: {
              ...process.env,
              OPENCLAW_ENTRY: fakeOpenClaw,
            },
          },
          { timeoutKillGraceMs: 50, timeoutMs: 500 },
        );
        result.catch(() => {});
        await waitFor(() => fs.existsSync(readyPath));
        descendantPid = await waitForPidFile(descendantPidPath);
        expect(Number.isInteger(descendantPid)).toBe(true);
        expect(isProcessAlive(descendantPid)).toBe(true);

        await expect(result).rejects.toThrow("secrets configure preset timed out");
        await waitFor(() => !isProcessAlive(descendantPid));
      } finally {
        if (descendantPid && isProcessAlive(descendantPid)) {
          process.kill(descendantPid, "SIGKILL");
        }
        if (previousEntry === undefined) {
          delete process.env.OPENCLAW_ENTRY;
        } else {
          process.env.OPENCLAW_ENTRY = previousEntry;
        }
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "fails mandatory commands that exit by signal",
    async () => {
      const proof = await import(
        `${pathToFileURL(proofScriptPath).href}?case=signal-${Date.now()}`
      );

      await expect(
        proof.runCommand(process.execPath, [
          "--input-type=module",
          "--eval",
          "process.kill(process.pid, 'SIGTERM');",
        ]),
      ).rejects.toThrow("command terminated by signal (SIGTERM)");
    },
  );

  it.each([
    ["OPENCLAW_SECRET_PROOF_COMMAND_MS", "150ms"],
    ["OPENCLAW_SECRET_PROOF_READY_MS", "0"],
    ["OPENCLAW_SECRET_PROOF_OUTPUT_BYTES", "4mb"],
    ["OPENCLAW_SECRET_PROOF_RESOLVER_STDIN_BYTES", "4mb"],
  ])("rejects malformed proof env limit %s=%s", async (name, value) => {
    const previous = process.env[name];
    process.env[name] = value;
    try {
      await expect(
        import(`${pathToFileURL(proofScriptPath).href}?case=env-${name}-${Date.now()}`),
      ).rejects.toThrow(`${name} must be a positive integer`);
    } finally {
      if (previous === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = previous;
      }
    }
  });

  it("bounds generated resolver stdin before reading the secret store", async () => {
    const root = makeTempDir();
    const stateDir = path.join(root, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    const storePath = path.join(stateDir, "proof-secret-store.json");
    fs.writeFileSync(
      storePath,
      `${JSON.stringify({ mode: "ok", calls: 0, values: { "proof/id": "ok" } }, null, 2)}\n`,
      "utf8",
    );
    const previousLimit = process.env.OPENCLAW_SECRET_PROOF_RESOLVER_STDIN_BYTES;
    process.env.OPENCLAW_SECRET_PROOF_RESOLVER_STDIN_BYTES = "64";

    try {
      const proof = await import(
        `${pathToFileURL(proofScriptPath).href}?case=resolver-stdin-${Date.now()}`
      );
      const plugin = proof.writeProofPlugin({ stateDir });
      const result = spawnSync(process.execPath, [plugin.resolverPath], {
        cwd: plugin.pluginRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          PROOF_SECRET_STORE_PATH: storePath,
        },
        input: JSON.stringify({ ids: ["proof/id"], padding: "x".repeat(512) }),
        timeout: 5_000,
      });

      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(`${result.stderr}${result.stdout}`).toContain("resolver stdin exceeded 64 bytes");
      expect(JSON.parse(fs.readFileSync(storePath, "utf8")).calls).toBe(0);
    } finally {
      if (previousLimit === undefined) {
        delete process.env.OPENCLAW_SECRET_PROOF_RESOLVER_STDIN_BYTES;
      } else {
        process.env.OPENCLAW_SECRET_PROOF_RESOLVER_STDIN_BYTES = previousLimit;
      }
    }
  });

  it("fails when proof temp cleanup cannot remove the root", async () => {
    const proof = await import(`${pathToFileURL(proofScriptPath).href}?case=cleanup-${Date.now()}`);
    const rmSync = vi.spyOn(fs, "rmSync").mockImplementation(() => {
      throw new Error("device busy");
    });

    try {
      await expect(
        proof.cleanupEnv("/tmp/openclaw-secret-provider-proof-stuck", {
          attempts: 3,
          retryDelayMs: 1,
        }),
      ).rejects.toThrow("failed to remove secret proof temp root");
      expect(rmSync).toHaveBeenCalledTimes(3);
    } finally {
      rmSync.mockRestore();
    }
  });

  it("signals Windows command process trees with graceful taskkill first", async () => {
    const proof = await import(
      `${pathToFileURL(proofScriptPath).href}?case=windows-command-${Date.now()}`
    );
    const child = {
      kill: vi.fn(),
      pid: 12345,
    };
    const runTaskkill = vi.fn(() => ({ error: undefined, status: 0 }));

    proof.terminateProcessTree(child, "SIGTERM", {
      platform: "win32",
      runTaskkill,
    });
    expect(runTaskkill).toHaveBeenNthCalledWith(
      1,
      expectedTaskkillPath(),
      ["/PID", "12345", "/T"],
      {
        stdio: "ignore",
      },
    );

    proof.terminateProcessTree(child, "SIGKILL", {
      platform: "win32",
      runTaskkill,
    });
    expect(runTaskkill).toHaveBeenNthCalledWith(
      2,
      expectedTaskkillPath(),
      ["/PID", "12345", "/T", "/F"],
      {
        stdio: "ignore",
      },
    );
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("force-kills Windows command trees when graceful taskkill fails", async () => {
    const proof = await import(
      `${pathToFileURL(proofScriptPath).href}?case=windows-command-fallback-${Date.now()}`
    );
    const child = {
      kill: vi.fn(),
      pid: 12345,
    };
    const runTaskkill = vi
      .fn()
      .mockReturnValueOnce({ error: undefined, status: 1 })
      .mockReturnValueOnce({ error: undefined, status: 0 });

    proof.terminateProcessTree(child, "SIGTERM", {
      platform: "win32",
      runTaskkill,
    });

    expect(runTaskkill).toHaveBeenNthCalledWith(
      1,
      expectedTaskkillPath(),
      ["/PID", "12345", "/T"],
      {
        stdio: "ignore",
      },
    );
    expect(runTaskkill).toHaveBeenNthCalledWith(
      2,
      expectedTaskkillPath(),
      ["/PID", "12345", "/T", "/F"],
      {
        stdio: "ignore",
      },
    );
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("signals Windows PTY process trees with taskkill", async () => {
    const proof = await import(
      `${pathToFileURL(proofScriptPath).href}?case=windows-pty-${Date.now()}`
    );
    const child = {
      kill: vi.fn(),
      pid: 12345,
    };
    const runTaskkill = vi.fn(() => ({ error: undefined, status: 0 }));

    proof.signalPtyProcessTree(child, "SIGHUP", {
      platform: "win32",
      runTaskkill,
    });
    expect(runTaskkill).toHaveBeenNthCalledWith(
      1,
      expectedTaskkillPath(),
      ["/PID", "12345", "/T"],
      {
        stdio: "ignore",
      },
    );

    proof.signalPtyProcessTree(child, "SIGKILL", {
      platform: "win32",
      runTaskkill,
    });
    expect(runTaskkill).toHaveBeenNthCalledWith(
      2,
      expectedTaskkillPath(),
      ["/PID", "12345", "/T", "/F"],
      {
        stdio: "ignore",
      },
    );
    expect(child.kill).not.toHaveBeenCalled();
  });

  it.runIf(process.platform !== "win32")("kills timed-out command process groups", async () => {
    const root = makeTempDir();
    const markerPath = path.join(root, "command-descendant-marker.txt");
    const scriptPath = path.join(root, "spawn-descendant.mjs");
    const descendantScript = [
      "import fs from 'node:fs';",
      `fs.appendFileSync(${JSON.stringify(markerPath)}, "x");`,
      "process.on('SIGTERM', () => {});",
      `setInterval(() => fs.appendFileSync(${JSON.stringify(markerPath)}, "x"), 20);`,
    ].join("\n");
    fs.writeFileSync(
      scriptPath,
      [
        "import childProcess from 'node:child_process';",
        "import { setTimeout as delay } from 'node:timers/promises';",
        `childProcess.spawn(process.execPath, ["--input-type=module", "--eval", ${JSON.stringify(
          descendantScript,
        )}], { stdio: "ignore" });`,
        "process.on('SIGTERM', () => process.exit(0));",
        "await delay(60_000);",
        "",
      ].join("\n"),
    );
    const proof = await import(`${pathToFileURL(proofScriptPath).href}?case=timeout-${Date.now()}`);

    await expect(
      proof.runCommand(process.execPath, [scriptPath], {
        timeoutKillGraceMs: 50,
        timeoutMs: 150,
      }),
    ).rejects.toThrow(/command timed out/u);

    const sizeAfterReturn = fs.existsSync(markerPath) ? fs.statSync(markerPath).size : 0;
    await new Promise((resolve) => {
      setTimeout(resolve, 250);
    });
    const sizeAfterWait = fs.existsSync(markerPath) ? fs.statSync(markerPath).size : 0;
    expect(sizeAfterWait).toBe(sizeAfterReturn);
  });

  it.runIf(process.platform !== "win32")(
    "preserves timeout kill grace for descendants after the leader exits",
    async () => {
      const root = makeTempDir();
      const cleanupPath = path.join(root, "command-descendant-cleanup.txt");
      const descendantPidPath = path.join(root, "command-descendant.pid");
      const scriptPath = path.join(root, "spawn-cleaning-descendant.mjs");
      const descendantScript = [
        "import fs from 'node:fs';",
        `fs.writeFileSync(${JSON.stringify(descendantPidPath)}, String(process.pid));`,
        "process.on('SIGTERM', () => {",
        `  setTimeout(() => { fs.writeFileSync(${JSON.stringify(
          cleanupPath,
        )}, "clean"); process.exit(0); }, 75);`,
        "});",
        "setInterval(() => {}, 1000);",
      ].join("\n");
      fs.writeFileSync(
        scriptPath,
        [
          "import childProcess from 'node:child_process';",
          "import { setTimeout as delay } from 'node:timers/promises';",
          `childProcess.spawn(process.execPath, ["--input-type=module", "--eval", ${JSON.stringify(
            descendantScript,
          )}], { stdio: "ignore" });`,
          "process.on('SIGTERM', () => process.exit(0));",
          "await delay(60_000);",
          "",
        ].join("\n"),
      );
      const proof = await import(
        `${pathToFileURL(proofScriptPath).href}?case=timeout-grace-${Date.now()}`
      );
      let descendantPid = 0;

      try {
        const command = proof.runCommand(process.execPath, [scriptPath], {
          timeoutMs: 150,
        });

        descendantPid = await waitForPidFile(descendantPidPath);
        expect(Number.isInteger(descendantPid)).toBe(true);
        expect(isProcessAlive(descendantPid)).toBe(true);

        await expect(command).rejects.toThrow(/command timed out/u);
        expect(fs.readFileSync(cleanupPath, "utf8")).toBe("clean");
        expect(isProcessAlive(descendantPid)).toBe(false);
      } finally {
        if (descendantPid && isProcessAlive(descendantPid)) {
          process.kill(descendantPid, "SIGKILL");
        }
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "aborts command process groups after the leader exits before stdio closes",
    async () => {
      const root = makeTempDir();
      const scriptPath = path.join(root, "leader-exits-stdout-held.mjs");
      const descendantPidPath = path.join(root, "descendant.pid");
      let descendantPid = 0;
      fs.writeFileSync(
        scriptPath,
        [
          "import childProcess from 'node:child_process';",
          "import fs from 'node:fs';",
          "const descendant = childProcess.spawn(process.execPath, [",
          "  '--input-type=module',",
          "  '--eval',",
          "  \"process.on('SIGTERM', () => process.exit(0)); setInterval(() => process.stdout.write('tick\\\\n'), 20);\",",
          "], { stdio: ['ignore', 'inherit', 'ignore'] });",
          `fs.writeFileSync(${JSON.stringify(descendantPidPath)}, String(descendant.pid));`,
          "process.exit(0);",
          "",
        ].join("\n"),
      );
      const proof = await import(`${pathToFileURL(proofScriptPath).href}?case=abort-${Date.now()}`);
      const controller = new AbortController();
      const command = proof.runCommand(process.execPath, [scriptPath], {
        signal: controller.signal,
        timeoutMs: 5_000,
      });

      try {
        descendantPid = await waitForPidFile(descendantPidPath);
        expect(Number.isInteger(descendantPid)).toBe(true);
        expect(isProcessAlive(descendantPid)).toBe(true);

        await new Promise((resolve) => {
          setTimeout(resolve, 50);
        });
        controller.abort();

        await expect(command).rejects.toThrow("command aborted");
        await waitFor(() => !isProcessAlive(descendantPid));
      } finally {
        await command.catch(() => {});
        if (descendantPid && isProcessAlive(descendantPid)) {
          process.kill(descendantPid, "SIGKILL");
        }
      }
    },
  );

  it.runIf(process.platform !== "win32")("aborts non-detached commands", async () => {
    const proof = await import(
      `${pathToFileURL(proofScriptPath).href}?case=abort-direct-${Date.now()}`
    );
    const controller = new AbortController();
    const command = proof.runCommand(
      process.execPath,
      ["--input-type=module", "--eval", "setInterval(() => {}, 1000);"],
      {
        detached: false,
        signal: controller.signal,
        timeoutMs: 5_000,
      },
    );

    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    controller.abort();

    await expect(command).rejects.toThrow("command aborted");
  });

  it.runIf(process.platform !== "win32")(
    "cleans active command process groups before parent signal exit",
    async () => {
      const root = makeTempDir();
      const scriptPath = path.join(root, "spawn-descendant-parent-signal.mjs");
      const runnerPath = path.join(root, "runner.mjs");
      const descendantPidPath = path.join(root, "descendant.pid");
      const readyPath = path.join(root, "ready");
      let descendantPid = 0;
      let runner: ReturnType<typeof spawn> | undefined;
      const descendantScript = [
        "import fs from 'node:fs';",
        "process.on('SIGTERM', () => {});",
        "process.on('SIGHUP', () => {});",
        `fs.writeFileSync(${JSON.stringify(readyPath)}, 'ready');`,
        "setInterval(() => {}, 1000);",
      ].join("\n");

      fs.writeFileSync(
        scriptPath,
        [
          "import childProcess from 'node:child_process';",
          "import fs from 'node:fs';",
          "const descendant = childProcess.spawn(process.execPath, [",
          "  '--input-type=module',",
          `  '--eval', ${JSON.stringify(descendantScript)},`,
          "], { stdio: 'ignore' });",
          `fs.writeFileSync(${JSON.stringify(descendantPidPath)}, String(descendant.pid));`,
          "process.on('SIGTERM', () => process.exit(0));",
          "setInterval(() => {}, 1000);",
          "",
        ].join("\n"),
      );
      fs.writeFileSync(
        runnerPath,
        [
          `const proof = await import(${JSON.stringify(
            `${pathToFileURL(proofScriptPath).href}?case=parent-signal-${Date.now()}`,
          )});`,
          `await proof.runCommand(process.execPath, [${JSON.stringify(scriptPath)}], { timeoutKillGraceMs: 50, timeoutMs: 30_000 });`,
          "",
        ].join("\n"),
      );

      try {
        runner = spawn(process.execPath, [runnerPath], {
          cwd: process.cwd(),
          stdio: ["ignore", "ignore", "pipe"],
        });
        await waitFor(() => fs.existsSync(readyPath));
        descendantPid = await waitForPidFile(descendantPidPath);
        expect(Number.isInteger(descendantPid)).toBe(true);
        expect(isProcessAlive(descendantPid)).toBe(true);

        runner.kill("SIGTERM");

        await expect(waitForChildClose(runner, 5_000)).resolves.toEqual({
          code: null,
          signal: "SIGTERM",
        });
        await waitFor(() => !isProcessAlive(descendantPid));
      } finally {
        if (descendantPid && isProcessAlive(descendantPid)) {
          process.kill(descendantPid, "SIGKILL");
        }
        if (runner?.pid && isProcessAlive(runner.pid)) {
          runner.kill("SIGKILL");
        }
      }
    },
  );

  it("detects startup secret leaks after the retained output cap", () => {
    const root = makeTempDir();
    const fakeOpenClaw = writeLeakingStartupOpenClaw(root);
    const result = runProofHarness(root, fakeOpenClaw, "startup-fails", {
      OPENCLAW_SECRET_PROOF_OUTPUT_BYTES: "128",
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.message).toContain("leaked a secret value");
    expect(payload.message).not.toContain("proof-gateway-token-v1");
  });

  it("keeps stalled managed status probes inside the ready deadline", async () => {
    const root = makeTempDir();
    const fakeOpenClaw = writeStallingOpenClaw(root);
    const result = runProofHarness(root, fakeOpenClaw, "status");

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.message).toContain("managed gateway did not become RPC-ready");
    expect(payload.elapsedMs).toBeLessThan(750);
  });
});
