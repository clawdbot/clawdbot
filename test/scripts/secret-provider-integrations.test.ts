import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const tempDirs: string[] = [];
const harnessPath = path.resolve("test/scripts/fixtures/secret-provider-integrations-harness.mjs");
const proofScriptPath = path.resolve("scripts/e2e/secret-provider-integrations.mjs");

function makeTempDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-secret-provider-proof-"));
  tempDirs.push(root);
  return root;
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

  it.runIf(process.platform !== "win32")(
    "kills timed-out command process groups",
    async () => {
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
          timeoutMs: 150,
        }),
      ).rejects.toThrow(/command timed out/u);

      const sizeAfterReturn = fs.existsSync(markerPath) ? fs.statSync(markerPath).size : 0;
      await new Promise((resolve) => {
        setTimeout(resolve, 250);
      });
      const sizeAfterWait = fs.existsSync(markerPath) ? fs.statSync(markerPath).size : 0;
      expect(sizeAfterWait).toBe(sizeAfterReturn);
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
