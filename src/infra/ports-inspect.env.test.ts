import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCommandWithTimeout } from "../process/exec.js";
import {
  createDiagnosticFixtureRouting,
  diagnosticCanaries,
  diagnosticEnvReportScript,
  withSyntheticDiagnosticEnv,
} from "./diagnostic-env.test-support.js";
import { inspectPortConnections, inspectPortUsage, inspectPortUsages } from "./ports-inspect.js";

// Only command location is substituted; the runner, env merge, Execa, and child are real.
vi.mock("./ports-lsof.js", () => ({ resolveLsofCommand: async () => "lsof" }));

afterEach(() => vi.restoreAllMocks());

describe.skipIf(process.platform === "win32")("native port diagnostic environment", () => {
  it.each(["single", "batch", "connections"] as const)(
    "%s keeps lsof/ps isolated and preserves payload inheritance",
    async (family) => await checkDiagnostics(family, false),
  );
  it.each(["single", "batch", "connections"] as const)(
    "%s keeps the ss fallback and ps isolated",
    async (family) => await checkDiagnostics(family, true),
  );
});

async function checkDiagnostics(family: "single" | "batch" | "connections", fallback: boolean) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "diagnostic-env-")));
  const reportPath = path.join(root, "children.jsonl");
  const routing = createDiagnosticFixtureRouting({
    PATH: root,
    HOME: root,
    TMPDIR: root,
    LANG: "C",
    LC_ALL: "C",
    TZ: "UTC",
  });
  const report = diagnosticEnvReportScript(routing);
  const port = 43123;
  const connected = family === "connections";
  const address = connected ? `127.0.0.1:${port}->127.0.0.1:54321` : `127.0.0.1:${port}`;
  const lsofOutput = `p424242\ncnode\nf1\nn${address}\n`;
  const ssOutput = connected
    ? `0 0 127.0.0.1:${port} 127.0.0.1:54321 users:(("node",pid=424242,fd=1))\n`
    : `LISTEN 0 128 127.0.0.1:${port} 0.0.0.0:* users:(("node",pid=424242,fd=1))\n`;
  try {
    for (const command of ["lsof", "ss", "ps"]) {
      await writeFile(
        path.join(root, command),
        String.raw`#!${process.execPath}
const fs = require('node:fs');
const command = ${JSON.stringify(command)};
fs.appendFileSync(${JSON.stringify(reportPath)}, JSON.stringify({command, ...JSON.parse(${report})}) + '\n');
if (command === 'lsof') {
  process.stdout.write(${JSON.stringify(fallback ? "" : lsofOutput)});
  process.exitCode = ${fallback ? 2 : 0};
} else if (command === 'ss') {
  process.stdout.write(${JSON.stringify(ssOutput)});
} else {
  process.stdout.write(process.argv.includes('ppid=') ? '1\n' : process.argv.includes('user=') ? 'fixture-user\n' : 'node fixture-server\n');
}
`,
        { mode: 0o755 },
      );
    }
    await withSyntheticDiagnosticEnv(routing, async () => {
      const parent = { ...process.env };
      const payload = async () => {
        const result = await runCommandWithTimeout(
          [process.execPath, "-e", `process.stdout.write(${report})`],
          { timeoutMs: 5000 },
        );
        expect(result.code).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({
          present: Object.fromEntries(Object.keys(diagnosticCanaries).map((key) => [key, true])),
          routingPreserved: true,
        });
      };
      await payload();
      const entries =
        family === "connections"
          ? (await inspectPortConnections(port)).connections
          : family === "batch"
            ? (await inspectPortUsages([port, port])).get(port)?.listeners
            : (await inspectPortUsage(port)).listeners;
      expect(entries).toEqual([
        expect.objectContaining({
          pid: 424242,
          commandLine: "node fixture-server",
          ppid: 1,
          user: "fixture-user",
        }),
      ]);
      await payload();
      expect(process.env).toEqual(parent);
      const reports = (await readFile(reportPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(
        reports.map((entry) => entry.command).toSorted((left, right) => left.localeCompare(right)),
      ).toEqual(
        (fallback ? ["lsof", "ss", "ps", "ps", "ps"] : ["lsof", "ps", "ps", "ps"]).toSorted(),
      );
      for (const entry of reports) {
        expect(entry, `${entry.command} inherited canary presence`).toEqual({
          command: entry.command,
          present: Object.fromEntries(Object.keys(diagnosticCanaries).map((key) => [key, false])),
          routingPreserved: true,
        });
      }
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
