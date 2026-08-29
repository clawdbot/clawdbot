// Doctor Install Switch tests cover its generated wrapper and service assertion contracts.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../helpers/temp-dir.js";

const SCRIPT_PATH = "scripts/e2e/lib/doctor-install-switch/write-wrapper.mjs";
const EXEC_START_ASSERTION_PATH = "scripts/e2e/lib/doctor-install-switch/assert-exec-start.mjs";
const tempDirs: string[] = [];

afterEach(() => {
  cleanupTempDirs(tempDirs);
});

function runWriter(args: string[]) {
  return spawnSync(process.execPath, [SCRIPT_PATH, ...args], {
    encoding: "utf8",
    env: { ...process.env },
  });
}

function runExecStartAssertion(args: string[]) {
  return spawnSync(process.execPath, [EXEC_START_ASSERTION_PATH, ...args], {
    encoding: "utf8",
    env: { ...process.env },
  });
}

describe("doctor install switch wrapper writer", () => {
  it("writes an executable wrapper that preserves quoted paths and arguments", () => {
    const root = makeTempDir(tempDirs, "openclaw-doctor-wrapper-");
    const npmDir = path.join(root, "bin with ' quote");
    mkdirSync(npmDir);

    const fakeNpm = path.join(npmDir, "npm mock");
    const forwardedArgsPath = path.join(root, "forwarded args.json");
    writeFileSync(
      fakeNpm,
      `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(forwardedArgsPath)}, JSON.stringify(process.argv.slice(2)));
`,
      { encoding: "utf8", mode: 0o755 },
    );
    chmodSync(fakeNpm, 0o755);

    const wrapperPath = path.join(root, "openclaw wrapper");
    const wrapperLogPath = path.join(root, "wrapper log with ' quote.txt");
    const writeResult = runWriter([wrapperPath, fakeNpm, wrapperLogPath]);

    expect(writeResult.status).toBe(0);
    expect(writeResult.stderr).toBe("");

    const args = ["gateway", "install", "--flag=value with spaces", "it's quoted"];
    const wrapperResult = spawnSync(wrapperPath, args, {
      encoding: "utf8",
      env: { ...process.env },
    });

    expect(wrapperResult.status).toBe(0);
    expect(wrapperResult.stderr).toBe("");
    expect(readFileSync(wrapperLogPath, "utf8")).toBe(`${args.join("\n")}\n`);
    expect(JSON.parse(readFileSync(forwardedArgsPath, "utf8"))).toEqual(args);
  });

  it("rejects missing required arguments before writing a wrapper", () => {
    const result = runWriter([]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("usage: write-wrapper.mjs <wrapper-path> <npm-bin> [log-path]");
  });
});

describe("doctor install switch ExecStart assertions", () => {
  it("resolves a quoted entrypoint after inserted Node heap flags", () => {
    const root = makeTempDir(tempDirs, "openclaw-doctor-exec-start-");
    const unitPath = path.join(root, "openclaw-gateway.service");
    const entrypoint = "/opt/openclaw git/dist/index.js";
    writeFileSync(
      unitPath,
      [
        "[Service]",
        `ExecStart="/usr/local/bin/node runtime" --max-old-space-size=4096 "${entrypoint}" gateway --port 18789`,
      ].join("\n"),
    );

    const result = runExecStartAssertion(["entrypoint", unitPath, entrypoint]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("reads wrapper arguments from parsed ExecStart argv", () => {
    const root = makeTempDir(tempDirs, "openclaw-doctor-exec-start-");
    const unitPath = path.join(root, "openclaw-gateway.service");
    const wrapper = "/home/test user/.local/bin/openclaw-wrapper";
    writeFileSync(unitPath, `[Service]\nExecStart="${wrapper}" gateway\n`);

    const wrapperResult = runExecStartAssertion(["argument", unitPath, wrapper, "1"]);
    const gatewayResult = runExecStartAssertion(["argument", unitPath, "gateway", "2"]);

    expect(wrapperResult.status).toBe(0);
    expect(wrapperResult.stderr).toBe("");
    expect(gatewayResult.status).toBe(0);
    expect(gatewayResult.stderr).toBe("");
  });

  it("reports the parsed argv when entrypoint detection fails", () => {
    const root = makeTempDir(tempDirs, "openclaw-doctor-exec-start-");
    const unitPath = path.join(root, "openclaw-gateway.service");
    writeFileSync(
      unitPath,
      "[Service]\nExecStart=/usr/bin/node --max-old-space-size=4096 /app/dist/index.js gateway\n",
    );

    const result = runExecStartAssertion(["entrypoint", unitPath, "/app/dist/other-index.js"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "Expected entrypoint /app/dist/other-index.js, got /app/dist/index.js.",
    );
    expect(result.stderr).toContain(
      'ExecStart argv: ["/usr/bin/node","--max-old-space-size=4096","/app/dist/index.js","gateway"]',
    );
  });
});
