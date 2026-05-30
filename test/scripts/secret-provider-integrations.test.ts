import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];
const harnessPath = path.resolve("test/scripts/fixtures/secret-provider-integrations-harness.mjs");
const proofScriptPath = path.resolve("scripts/e2e/secret-provider-integrations.mjs");

function makeTempDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-secret-provider-proof-"));
  tempDirs.push(root);
  return root;
}

function writeStallingOpenClaw(root: string): string {
  const scriptPath = path.join(root, "fake-openclaw.mjs");
  fs.writeFileSync(
    scriptPath,
    [
      "#!/usr/bin/env node",
      "import { setTimeout as delay } from 'node:timers/promises';",
      "const args = process.argv.slice(2);",
      "if (args[0] === 'gateway' && args[1] === 'run') {",
      "  process.once('SIGTERM', () => process.exit(0));",
      "  process.once('SIGINT', () => process.exit(0));",
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

function runProofHarness(root: string, fakeOpenClaw: string, mode: "start" | "status") {
  return spawnSync(process.execPath, [harnessPath, proofScriptPath, root, mode], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      OPENCLAW_ENTRY: fakeOpenClaw,
      OPENCLAW_SECRET_PROOF_READY_MS: "60",
      OPENCLAW_SECRET_PROOF_RPC_MS: "1000",
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
