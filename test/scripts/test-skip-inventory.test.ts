// Test Skip Inventory tests cover skipped, conditional, todo, and focused test reporting.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectTestSkipInventoryReport,
  main as runTestSkipInventory,
  renderTestSkipInventoryReport,
  type TestSkipInventoryReport,
} from "../../scripts/test-skip-inventory.js";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();

function writeRepoFile(repoRoot: string, relativePath: string, value: string): void {
  const filePath = path.join(repoRoot, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value, "utf8");
}

function makeSkipInventoryFixture(): string {
  const repoRoot = createTempDir("openclaw-test-skip-inventory-");
  writeRepoFile(
    repoRoot,
    "src/runtime.ts",
    `
describe.skip("ignored because this is not a test file", () => {});
`,
  );
  writeRepoFile(
    repoRoot,
    "src/example.test.ts",
    `
describe.skip("temporarily disabled suite", () => {});
it.skipIf(process.platform === "win32")("uses POSIX shell", () => {});
test.todo("covers migration edge");
it.only("focused during local debugging", () => {});
const posixIt = process.platform === "win32" ? it.skip : it;
(process.platform === "win32" ? it.skip : it)("uses terminal fixtures", () => {});
it.runIf(process.platform !== "win32")("runs only on POSIX", () => {});
it.runIf(process.platform !== "win32").each(["SIGTERM"] as const)("handles %s", () => {});
const runIfPowerShell = powershell ? it : it.skip;
it.concurrent.only("focused concurrent test", () => {});
test.sequential.skip("skipped sequential test", () => {});
const fixture = 'describe.skip("not code", () => {})';
`,
  );
  writeRepoFile(
    repoRoot,
    "test/e2e/qa-lab/runtime/qa-otel-smoke-runtime.ts",
    `
reader.skip(wire);
`,
  );
  writeRepoFile(
    repoRoot,
    "test/scripts/test-live.test.ts",
    `
const posixIt = process.platform === "win32" ? it.skip : it;
`,
  );
  writeRepoFile(
    repoRoot,
    "extensions/provider/live.test.ts",
    `
const LIVE = process.env.OPENCLAW_LIVE_TEST === "1";
const describeLive = LIVE ? describe : describe.skip;
describeLive("provider live", () => {});
`,
  );
  writeRepoFile(
    repoRoot,
    "ui/src/e2e/chat-flow.e2e.test.ts",
    `
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
describeControlUiE2e("control UI", () => {});
`,
  );
  return repoRoot;
}

describe("collectTestSkipInventoryReport", () => {
  it("reports skipped, conditional, todo, and focused test inventory", () => {
    const report = collectTestSkipInventoryReport({ repoRoot: makeSkipInventoryFixture() });

    expect(
      report.findings.map((finding) => ({
        file: finding.file,
        kind: finding.kind,
        method: finding.method,
        reason: finding.reason,
        target: finding.target,
      })),
    ).toEqual([
      {
        file: "extensions/provider/live.test.ts",
        kind: "alias",
        method: "skip",
        reason: "live-gate",
        target: "describe",
      },
      {
        file: "src/example.test.ts",
        kind: "call",
        method: "skip",
        reason: "explicit-skip",
        target: "describe",
      },
      {
        file: "src/example.test.ts",
        kind: "call",
        method: "skipIf",
        reason: "platform-gate",
        target: "it",
      },
      {
        file: "src/example.test.ts",
        kind: "call",
        method: "todo",
        reason: "todo",
        target: "test",
      },
      {
        file: "src/example.test.ts",
        kind: "call",
        method: "only",
        reason: "focused-only",
        target: "it",
      },
      {
        file: "src/example.test.ts",
        kind: "alias",
        method: "skip",
        reason: "platform-gate",
        target: "it",
      },
      {
        file: "src/example.test.ts",
        kind: "call",
        method: "skip",
        reason: "platform-gate",
        target: "it",
      },
      {
        file: "src/example.test.ts",
        kind: "call",
        method: "runIf",
        reason: "platform-gate",
        target: "it",
      },
      {
        file: "src/example.test.ts",
        kind: "call",
        method: "runIf",
        reason: "platform-gate",
        target: "it",
      },
      {
        file: "src/example.test.ts",
        kind: "alias",
        method: "skip",
        reason: "conditional-skip",
        target: "it",
      },
      {
        file: "src/example.test.ts",
        kind: "call",
        method: "only",
        reason: "focused-only",
        target: "it",
      },
      {
        file: "src/example.test.ts",
        kind: "call",
        method: "skip",
        reason: "explicit-skip",
        target: "test",
      },
      {
        file: "test/scripts/test-live.test.ts",
        kind: "alias",
        method: "skip",
        reason: "platform-gate",
        target: "it",
      },
      {
        file: "ui/src/e2e/chat-flow.e2e.test.ts",
        kind: "alias",
        method: "skip",
        reason: "optional-dependency",
        target: "describe",
      },
    ]);
    expect(report.summary).toMatchObject({
      findingCount: 14,
      reasonCounts: {
        "conditional-skip": 1,
        "explicit-skip": 2,
        "focused-only": 2,
        "live-gate": 1,
        "optional-dependency": 1,
        "platform-gate": 6,
        todo: 1,
      },
      touchedFileCount: 4,
    });
  });

  it("renders a compact non-blocking text report", () => {
    const report = collectTestSkipInventoryReport({ repoRoot: makeSkipInventoryFixture() });

    const rendered = renderTestSkipInventoryReport(report, { limit: 4 });

    expect(rendered).toContain("OpenClaw test skip inventory");
    expect(rendered).toContain("Findings: 14 in 4 file(s)");
    expect(rendered).toContain("platform-gate: 6");
    expect(rendered).toContain("- src/example.test.ts (11)");
    expect(rendered).toContain("L2 describe.skip explicit-skip");
    expect(rendered).toContain("... 10 more finding(s) not shown");
  });

  it("prints JSON from the CLI and exits successfully", () => {
    const repoRoot = makeSkipInventoryFixture();
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        path.join(process.cwd(), "scripts/test-skip-inventory.ts"),
        "--",
        "--repo-root",
        repoRoot,
        "--json",
      ],
      {
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as TestSkipInventoryReport;
    expect(report.summary.findingCount).toBe(14);
    expect(report.summary.reasonCounts["focused-only"]).toBe(2);
  });

  it("prints CLI help without scanning the repository", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", path.join(process.cwd(), "scripts/test-skip-inventory.ts"), "--help"],
      {
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).toContain("pnpm test:skip-inventory:report");
    expect(result.stdout).not.toContain("Scanned files:");
    expect(result.stderr).toBe("");
  });

  it("rejects missing CLI repo roots and loose limits before scanning", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        path.join(process.cwd(), "scripts/test-skip-inventory.ts"),
        "--",
        "--repo-root",
        "--json",
      ],
      {
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--repo-root expects a path");
    expect(result.stdout).not.toContain("Scanned files:");
    expect(() =>
      runTestSkipInventory([
        "--",
        "--limit",
        "1e3",
        "--repo-root",
        createTempDir("openclaw-skip-limit-"),
      ]),
    ).toThrow("--limit expects a non-negative integer");
  });
});
