import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTempDir } from "./exec-approvals-test-helpers.js";

const requestJsonlSocketMock = vi.hoisted(() => vi.fn());

vi.mock("./jsonl-socket.js", () => ({
  requestJsonlSocket: (...args: unknown[]) => requestJsonlSocketMock(...args),
}));

import type { ExecApprovalsFile } from "./exec-approvals.js";

type ExecApprovalsModule = typeof import("./exec-approvals.js");

let addAllowlistEntry: ExecApprovalsModule["addAllowlistEntry"];
let addDurableCommandApproval: ExecApprovalsModule["addDurableCommandApproval"];
let ensureExecApprovals: ExecApprovalsModule["ensureExecApprovals"];
let mergeExecApprovalsSocketDefaults: ExecApprovalsModule["mergeExecApprovalsSocketDefaults"];
let normalizeExecApprovals: ExecApprovalsModule["normalizeExecApprovals"];
let persistAllowAlwaysPatterns: ExecApprovalsModule["persistAllowAlwaysPatterns"];
let readExecApprovalsSnapshot: ExecApprovalsModule["readExecApprovalsSnapshot"];
let recordAllowlistMatchesUse: ExecApprovalsModule["recordAllowlistMatchesUse"];
let recordAllowlistUse: ExecApprovalsModule["recordAllowlistUse"];
let requestExecApprovalViaSocket: ExecApprovalsModule["requestExecApprovalViaSocket"];
let resolveExecApprovalsPath: ExecApprovalsModule["resolveExecApprovalsPath"];
let resolveExecApprovalsSocketPath: ExecApprovalsModule["resolveExecApprovalsSocketPath"];
let saveExecApprovals: ExecApprovalsModule["saveExecApprovals"];

const tempDirs: string[] = [];
const originalOpenClawHome = process.env.OPENCLAW_HOME;

beforeAll(async () => {
  ({
    addAllowlistEntry,
    addDurableCommandApproval,
    ensureExecApprovals,
    mergeExecApprovalsSocketDefaults,
    normalizeExecApprovals,
    persistAllowAlwaysPatterns,
    readExecApprovalsSnapshot,
    recordAllowlistMatchesUse,
    recordAllowlistUse,
    requestExecApprovalViaSocket,
    resolveExecApprovalsPath,
    resolveExecApprovalsSocketPath,
    saveExecApprovals,
  } = await import("./exec-approvals.js"));
});

beforeEach(() => {
  requestJsonlSocketMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalOpenClawHome === undefined) {
    delete process.env.OPENCLAW_HOME;
  } else {
    process.env.OPENCLAW_HOME = originalOpenClawHome;
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createHomeDir(): string {
  const dir = makeTempDir();
  tempDirs.push(dir);
  process.env.OPENCLAW_HOME = dir;
  return dir;
}

function approvalsFilePath(homeDir: string): string {
  return path.join(homeDir, ".openclaw", "exec-approvals.json");
}

function readApprovalsFile(homeDir: string): ExecApprovalsFile {
  return JSON.parse(fs.readFileSync(approvalsFilePath(homeDir), "utf8")) as ExecApprovalsFile;
}

function listExecApprovalTempFiles(homeDir: string): string[] {
  const dir = path.dirname(approvalsFilePath(homeDir));
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs.readdirSync(dir).filter((name) => name.endsWith(".tmp"));
}

function requireRecord(value: unknown): Record<string, unknown> {
  expect(value).toBeTruthy();
  expect(typeof value).toBe("object");
  expect(Array.isArray(value)).toBe(false);
  return value as Record<string, unknown>;
}

function allowlistEntries(homeDir: string, agentId: string): Record<string, unknown>[] {
  const file = readApprovalsFile(homeDir);
  return (file.agents?.[agentId]?.allowlist ?? []).map((entry) => requireRecord(entry));
}

function expectAllowlistEntryFields(
  entry: Record<string, unknown>,
  fields: Record<string, unknown>,
): void {
  for (const [key, value] of Object.entries(fields)) {
    expect(entry[key]).toEqual(value);
  }
}

describe("exec approvals store helpers", () => {
  it("expands home-prefixed default file and socket paths", () => {
    const dir = createHomeDir();

    expect(path.normalize(resolveExecApprovalsPath())).toBe(
      path.normalize(path.join(dir, ".openclaw", "exec-approvals.json")),
    );
    expect(path.normalize(resolveExecApprovalsSocketPath())).toBe(
      path.normalize(path.join(dir, ".openclaw", "exec-approvals.sock")),
    );
  });

  it("merges socket defaults from normalized, current, and built-in fallback", () => {
    const normalized = normalizeExecApprovals({
      version: 1,
      agents: {},
      socket: { path: "/tmp/a.sock", token: "a" },
    });
    const current = normalizeExecApprovals({
      version: 1,
      agents: {},
      socket: { path: "/tmp/b.sock", token: "b" },
    });

    expect(mergeExecApprovalsSocketDefaults({ normalized, current }).socket).toEqual({
      path: "/tmp/a.sock",
      token: "a",
    });

    const merged = mergeExecApprovalsSocketDefaults({
      normalized: normalizeExecApprovals({ version: 1, agents: {} }),
      current,
    });
    expect(merged.socket).toEqual({
      path: "/tmp/b.sock",
      token: "b",
    });

    createHomeDir();
    expect(
      mergeExecApprovalsSocketDefaults({
        normalized: normalizeExecApprovals({ version: 1, agents: {} }),
      }).socket,
    ).toEqual({
      path: resolveExecApprovalsSocketPath(),
      token: "",
    });
  });

  it("returns normalized empty snapshots for missing and invalid approvals files", () => {
    const dir = createHomeDir();

    const missing = readExecApprovalsSnapshot();
    expect(missing.exists).toBe(false);
    expect(missing.raw).toBeNull();
    expect(missing.file).toEqual(normalizeExecApprovals({ version: 1, agents: {} }));
    expect(path.normalize(missing.path)).toBe(path.normalize(approvalsFilePath(dir)));

    fs.mkdirSync(path.dirname(approvalsFilePath(dir)), { recursive: true });
    fs.writeFileSync(approvalsFilePath(dir), "{invalid", "utf8");

    const invalid = readExecApprovalsSnapshot();
    expect(invalid.exists).toBe(true);
    expect(invalid.raw).toBe("{invalid");
    expect(invalid.file).toEqual(normalizeExecApprovals({ version: 1, agents: {} }));
  });

  it("ensures approvals file with default socket path and generated token", () => {
    const dir = createHomeDir();

    const ensured = ensureExecApprovals();
    const raw = fs.readFileSync(approvalsFilePath(dir), "utf8");

    expect(ensured.socket?.path).toBe(resolveExecApprovalsSocketPath());
    expect(ensured.socket?.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(raw.endsWith("\n")).toBe(true);
    expect(readApprovalsFile(dir).socket).toEqual(ensured.socket);
  });

  it("atomically replaces existing approvals files instead of mutating linked inodes", () => {
    const dir = createHomeDir();
    const approvalsPath = approvalsFilePath(dir);
    const linkedPath = path.join(dir, "linked.json");
    fs.mkdirSync(path.dirname(approvalsPath), { recursive: true });
    fs.writeFileSync(linkedPath, '{"sentinel":true}\n', "utf8");
    fs.linkSync(linkedPath, approvalsPath);

    saveExecApprovals({ version: 1, defaults: { security: "full" }, agents: {} });

    expect(fs.readFileSync(approvalsPath, "utf8")).toContain('"security": "full"');
    expect(fs.readFileSync(linkedPath, "utf8")).toBe('{"sentinel":true}\n');
    expect(fs.statSync(approvalsPath).ino).not.toBe(fs.statSync(linkedPath).ino);
  });

  it("normalizes successful rename writes to owner-only permissions", () => {
    const dir = createHomeDir();
    const actualWriteFileSync = fs.writeFileSync.bind(fs);
    vi.spyOn(fs, "writeFileSync").mockImplementation((file, data, options) => {
      const result = actualWriteFileSync(file, data, options as never);
      const filePath = String(file);
      if (
        typeof file !== "number" &&
        filePath.includes(".exec-approvals.") &&
        filePath.endsWith(".tmp")
      ) {
        fs.chmodSync(file, 0o000);
      }
      return result;
    });

    saveExecApprovals({ version: 1, defaults: { security: "full" }, agents: {} });

    expect(fs.readFileSync(approvalsFilePath(dir), "utf8")).toContain('"security": "full"');
    expect(fs.statSync(approvalsFilePath(dir)).mode & 0o777).toBe(0o600);
  });

  it("normalizes the approvals directory to owner-only permissions", () => {
    const dir = createHomeDir();
    const approvalsDir = path.dirname(approvalsFilePath(dir));
    fs.mkdirSync(approvalsDir, { recursive: true });
    fs.chmodSync(approvalsDir, 0o777);

    saveExecApprovals({ version: 1, defaults: { security: "full" }, agents: {} });

    expect(fs.readFileSync(approvalsFilePath(dir), "utf8")).toContain('"security": "full"');
    expect(fs.statSync(approvalsDir).mode & 0o777).toBe(0o700);
  });

  it("falls back to copying when rename cannot overwrite the approvals file", () => {
    const dir = createHomeDir();
    const approvalsPath = approvalsFilePath(dir);
    fs.mkdirSync(path.dirname(approvalsPath), { recursive: true });
    fs.writeFileSync(approvalsPath, '{"version":1,"agents":{}}\n', "utf8");
    const actualRenameSync = fs.renameSync.bind(fs);
    const rename = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to) === approvalsPath) {
        const error = Object.assign(new Error("locked target"), { code: "EPERM" });
        throw error;
      }
      return actualRenameSync(from, to);
    });

    saveExecApprovals({ version: 1, defaults: { security: "full" }, agents: {} });

    expect(rename).toHaveBeenCalled();
    expect(fs.readFileSync(approvalsPath, "utf8")).toContain('"security": "full"');
    expect(fs.statSync(approvalsPath).mode & 0o777).toBe(0o600);
    expect(listExecApprovalTempFiles(dir)).toStrictEqual([]);
  });

  it("normalizes fallback temp files before copying", () => {
    const dir = createHomeDir();
    const approvalsPath = approvalsFilePath(dir);
    fs.mkdirSync(path.dirname(approvalsPath), { recursive: true });
    fs.writeFileSync(approvalsPath, '{"version":1,"agents":{}}\n', "utf8");
    const actualWriteFileSync = fs.writeFileSync.bind(fs);
    vi.spyOn(fs, "writeFileSync").mockImplementation((file, data, options) => {
      const result = actualWriteFileSync(file, data, options as never);
      const filePath = String(file);
      if (
        typeof file !== "number" &&
        filePath.includes(".exec-approvals.") &&
        filePath.endsWith(".tmp")
      ) {
        fs.chmodSync(file, 0o000);
      }
      return result;
    });
    const actualRenameSync = fs.renameSync.bind(fs);
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to) === approvalsPath) {
        const error = Object.assign(new Error("locked target"), { code: "EPERM" });
        throw error;
      }
      return actualRenameSync(from, to);
    });

    saveExecApprovals({ version: 1, defaults: { security: "full" }, agents: {} });

    expect(fs.readFileSync(approvalsPath, "utf8")).toContain('"security": "full"');
    expect(fs.statSync(approvalsPath).mode & 0o777).toBe(0o600);
    expect(listExecApprovalTempFiles(dir)).toStrictEqual([]);
  });

  it("restores the previous approvals file when fallback copy fails", () => {
    const dir = createHomeDir();
    const approvalsPath = approvalsFilePath(dir);
    const previousRaw = '{"version":1,"defaults":{"security":"deny"},"agents":{}}\n';
    fs.mkdirSync(path.dirname(approvalsPath), { recursive: true });
    fs.writeFileSync(approvalsPath, previousRaw, { encoding: "utf8", mode: 0o600 });
    const actualRenameSync = fs.renameSync.bind(fs);
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to) === approvalsPath) {
        const error = Object.assign(new Error("locked target"), { code: "EPERM" });
        throw error;
      }
      return actualRenameSync(from, to);
    });
    const actualFtruncateSync = fs.ftruncateSync.bind(fs);
    let forcedFallbackFailure = false;
    vi.spyOn(fs, "ftruncateSync").mockImplementation((fd, len) => {
      if (!forcedFallbackFailure && len === 0) {
        forcedFallbackFailure = true;
        actualFtruncateSync(fd, len);
        const error = Object.assign(new Error("copy failed after opening destination"), {
          code: "ENOSPC",
        });
        throw error;
      }
      return actualFtruncateSync(fd, len);
    });

    expect(() =>
      saveExecApprovals({ version: 1, defaults: { security: "full" }, agents: {} }),
    ).toThrow(/copy failed after opening destination/);
    expect(fs.readFileSync(approvalsPath, "utf8")).toBe(previousRaw);
    expect(fs.statSync(approvalsPath).mode & 0o777).toBe(0o600);
    expect(listExecApprovalTempFiles(dir)).toStrictEqual([]);
  });

  it("does not follow a symlink swapped in before fallback copy", () => {
    const dir = createHomeDir();
    const approvalsPath = approvalsFilePath(dir);
    const targetPath = path.join(dir, "elsewhere.json");
    fs.mkdirSync(path.dirname(approvalsPath), { recursive: true });
    fs.writeFileSync(approvalsPath, '{"version":1,"agents":{}}\n', "utf8");
    fs.writeFileSync(targetPath, '{"sentinel":true}\n', "utf8");
    const actualRenameSync = fs.renameSync.bind(fs);
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to) === approvalsPath) {
        const error = Object.assign(new Error("locked target"), { code: "EPERM" });
        throw error;
      }
      return actualRenameSync(from, to);
    });
    const actualStatSync = fs.statSync.bind(fs);
    let swappedDestination = false;
    vi.spyOn(fs, "statSync").mockImplementation((file, options) => {
      const result = actualStatSync(file, options as never);
      if (!swappedDestination && String(file) === approvalsPath) {
        swappedDestination = true;
        fs.rmSync(approvalsPath);
        fs.symlinkSync(targetPath, approvalsPath);
      }
      return result;
    });

    expect(() =>
      saveExecApprovals({ version: 1, defaults: { security: "full" }, agents: {} }),
    ).toThrow(/symlink|ELOOP/);
    expect(fs.readFileSync(targetPath, "utf8")).toBe('{"sentinel":true}\n');
    expect(listExecApprovalTempFiles(dir)).toStrictEqual([]);
  });

  it("does not use the copy fallback for hard-linked approvals files", () => {
    const dir = createHomeDir();
    const approvalsPath = approvalsFilePath(dir);
    const linkedPath = path.join(dir, "linked.json");
    fs.mkdirSync(path.dirname(approvalsPath), { recursive: true });
    fs.writeFileSync(linkedPath, '{"sentinel":true}\n', "utf8");
    fs.linkSync(linkedPath, approvalsPath);
    const actualRenameSync = fs.renameSync.bind(fs);
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to) === approvalsPath) {
        const error = Object.assign(new Error("locked target"), { code: "EPERM" });
        throw error;
      }
      return actualRenameSync(from, to);
    });

    expect(() =>
      saveExecApprovals({ version: 1, defaults: { security: "full" }, agents: {} }),
    ).toThrow(/hard-linked exec approvals file/);
    expect(fs.readFileSync(linkedPath, "utf8")).toBe('{"sentinel":true}\n');
    expect(listExecApprovalTempFiles(dir)).toStrictEqual([]);
  });

  it("refuses to write approvals through a symlink destination", () => {
    const dir = createHomeDir();
    const approvalsPath = approvalsFilePath(dir);
    const targetPath = path.join(dir, "elsewhere.json");
    fs.mkdirSync(path.dirname(approvalsPath), { recursive: true });
    fs.writeFileSync(targetPath, '{"sentinel":true}\n', "utf8");
    fs.symlinkSync(targetPath, approvalsPath);

    expect(() =>
      saveExecApprovals({ version: 1, defaults: { security: "full" }, agents: {} }),
    ).toThrow(/Refusing to write exec approvals via symlink/);
    expect(fs.readFileSync(targetPath, "utf8")).toBe('{"sentinel":true}\n');
  });

  it("accepts a symlinked OPENCLAW_HOME as the trusted approvals root", () => {
    const realHome = makeTempDir();
    const linkedHome = `${realHome}-link`;
    tempDirs.push(realHome, linkedHome);
    fs.symlinkSync(realHome, linkedHome, "dir");
    process.env.OPENCLAW_HOME = linkedHome;

    saveExecApprovals({ version: 1, defaults: { security: "full" }, agents: {} });

    expect(
      fs.readFileSync(path.join(realHome, ".openclaw", "exec-approvals.json"), "utf8"),
    ).toContain('"security": "full"');
  });

  it("refuses to traverse symlinked approvals components below a symlinked home", () => {
    const realHome = makeTempDir();
    const linkedHome = `${realHome}-link`;
    const linkedStateTarget = path.join(realHome, "state-target");
    tempDirs.push(realHome, linkedHome);
    fs.mkdirSync(linkedStateTarget, { recursive: true });
    fs.symlinkSync(realHome, linkedHome, "dir");
    fs.symlinkSync(linkedStateTarget, path.join(realHome, ".openclaw"), "dir");
    process.env.OPENCLAW_HOME = linkedHome;

    expect(() =>
      saveExecApprovals({ version: 1, defaults: { security: "full" }, agents: {} }),
    ).toThrow(/Refusing to traverse symlink in exec approvals path/);
    expect(fs.existsSync(path.join(linkedStateTarget, "exec-approvals.json"))).toBe(false);
  });

  it("adds trimmed allowlist entries once and persists generated ids", () => {
    const dir = createHomeDir();
    vi.spyOn(Date, "now").mockReturnValue(123_456);

    const approvals = ensureExecApprovals();
    addAllowlistEntry(approvals, "worker", "  /usr/bin/rg  ");
    addAllowlistEntry(approvals, "worker", "/usr/bin/rg");
    addAllowlistEntry(approvals, "worker", "   ");

    const allowlist = allowlistEntries(dir, "worker");
    expect(allowlist).toHaveLength(1);
    expectAllowlistEntryFields(allowlist[0] ?? {}, {
      pattern: "/usr/bin/rg",
      lastUsedAt: 123_456,
    });
    expect(allowlist[0]?.id).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("persists durable command approvals without storing plaintext command text", () => {
    const dir = createHomeDir();
    vi.spyOn(Date, "now").mockReturnValue(321_000);

    const approvals = ensureExecApprovals();
    addDurableCommandApproval(approvals, "worker", 'printenv API_KEY="secret-value"');

    const allowlist = allowlistEntries(dir, "worker");
    expect(allowlist).toHaveLength(1);
    expectAllowlistEntryFields(allowlist[0] ?? {}, {
      source: "allow-always",
      lastUsedAt: 321_000,
    });
    expect(allowlist[0]?.pattern).toMatch(/^=command:[0-9a-f]{16}$/i);
    expect(allowlist[0]).not.toHaveProperty("commandText");
  });

  it("strips legacy plaintext command text during normalization", () => {
    const normalized = normalizeExecApprovals({
      version: 1,
      agents: {
        main: {
          allowlist: [
            {
              pattern: "=command:test",
              source: "allow-always",
              commandText: "echo secret-token",
            },
          ],
        },
      },
    });
    const allowlist = normalized.agents?.main?.allowlist ?? [];
    expect(allowlist).toHaveLength(1);
    expect(allowlist[0]?.pattern).toBe("=command:test");
    expect(allowlist[0]?.source).toBe("allow-always");
    expect(allowlist[0]).not.toHaveProperty("commandText");
  });

  it("preserves source and argPattern metadata for allow-always entries", () => {
    const dir = createHomeDir();
    vi.spyOn(Date, "now").mockReturnValue(321_000);

    const approvals = ensureExecApprovals();
    addAllowlistEntry(approvals, "worker", "/usr/bin/python3", {
      argPattern: "^script\\.py\x00$",
      source: "allow-always",
    });
    addAllowlistEntry(approvals, "worker", "/usr/bin/python3", {
      argPattern: "^script\\.py\x00$",
      source: "allow-always",
    });
    addAllowlistEntry(approvals, "worker", "/usr/bin/python3", {
      argPattern: "^other\\.py\x00$",
      source: "allow-always",
    });

    const allowlist = allowlistEntries(dir, "worker");
    expect(allowlist).toHaveLength(2);
    expectAllowlistEntryFields(allowlist[0] ?? {}, {
      pattern: "/usr/bin/python3",
      argPattern: "^script\\.py\x00$",
      source: "allow-always",
      lastUsedAt: 321_000,
    });
    expectAllowlistEntryFields(allowlist[1] ?? {}, {
      pattern: "/usr/bin/python3",
      argPattern: "^other\\.py\x00$",
      source: "allow-always",
      lastUsedAt: 321_000,
    });
  });

  it("records allowlist usage on the matching entry and backfills missing ids", () => {
    const dir = createHomeDir();
    vi.spyOn(Date, "now").mockReturnValue(999_000);

    const approvals: ExecApprovalsFile = {
      version: 1,
      agents: {
        main: {
          allowlist: [{ pattern: "/usr/bin/rg" }, { pattern: "/usr/bin/jq", id: "keep-id" }],
        },
      },
    };
    fs.mkdirSync(path.dirname(approvalsFilePath(dir)), { recursive: true });
    fs.writeFileSync(approvalsFilePath(dir), JSON.stringify(approvals, null, 2), "utf8");

    recordAllowlistUse(
      approvals,
      undefined,
      { pattern: "/usr/bin/rg" },
      "rg needle",
      "/opt/homebrew/bin/rg",
    );

    const allowlist = allowlistEntries(dir, "main");
    expect(allowlist).toHaveLength(2);
    expectAllowlistEntryFields(allowlist[0] ?? {}, {
      pattern: "/usr/bin/rg",
      lastUsedAt: 999_000,
      lastUsedCommand: "rg needle",
      lastResolvedPath: "/opt/homebrew/bin/rg",
    });
    expect(allowlist[0]?.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(allowlist[1]).toEqual({ pattern: "/usr/bin/jq", id: "keep-id" });
  });

  it("dedupes allowlist usage by pattern and argPattern", () => {
    const dir = createHomeDir();
    vi.spyOn(Date, "now").mockReturnValue(777_000);

    const approvals: ExecApprovalsFile = {
      version: 1,
      agents: {
        main: {
          allowlist: [
            { pattern: "/usr/bin/python3", argPattern: "^a\\.py\x00$" },
            { pattern: "/usr/bin/python3", argPattern: "^b\\.py\x00$" },
          ],
        },
      },
    };
    fs.mkdirSync(path.dirname(approvalsFilePath(dir)), { recursive: true });
    fs.writeFileSync(approvalsFilePath(dir), JSON.stringify(approvals, null, 2), "utf8");

    recordAllowlistMatchesUse({
      approvals,
      agentId: undefined,
      matches: [
        { pattern: "/usr/bin/python3", argPattern: "^a\\.py\x00$" },
        { pattern: "/usr/bin/python3", argPattern: "^a\\.py\x00$" },
        { pattern: "/usr/bin/python3", argPattern: "^b\\.py\x00$" },
      ],
      command: "python3 a.py",
      resolvedPath: "/usr/bin/python3",
    });

    const allowlist = allowlistEntries(dir, "main");
    expect(allowlist).toHaveLength(2);
    expectAllowlistEntryFields(allowlist[0] ?? {}, {
      pattern: "/usr/bin/python3",
      argPattern: "^a\\.py\x00$",
      lastUsedAt: 777_000,
    });
    expectAllowlistEntryFields(allowlist[1] ?? {}, {
      pattern: "/usr/bin/python3",
      argPattern: "^b\\.py\x00$",
      lastUsedAt: 777_000,
    });
  });

  it("persists allow-always patterns with shared helper", () => {
    const dir = createHomeDir();
    vi.spyOn(Date, "now").mockReturnValue(654_321);

    const approvals = ensureExecApprovals();
    const patterns = persistAllowAlwaysPatterns({
      approvals,
      agentId: "worker",
      platform: "win32",
      segments: [
        {
          raw: "/usr/bin/custom-tool.exe a.py",
          argv: ["/usr/bin/custom-tool.exe", "a.py"],
          resolution: {
            execution: {
              rawExecutable: "/usr/bin/custom-tool.exe",
              resolvedPath: "/usr/bin/custom-tool.exe",
              executableName: "custom-tool",
            },
            policy: {
              rawExecutable: "/usr/bin/custom-tool.exe",
              resolvedPath: "/usr/bin/custom-tool.exe",
              executableName: "custom-tool",
            },
          },
        },
      ],
    });

    expect(patterns).toEqual([
      {
        pattern: "/usr/bin/custom-tool.exe",
        argPattern: "^a\\.py\x00$",
      },
    ]);
    const allowlist = allowlistEntries(dir, "worker");
    expect(allowlist).toHaveLength(1);
    expectAllowlistEntryFields(allowlist[0] ?? {}, {
      pattern: "/usr/bin/custom-tool.exe",
      argPattern: "^a\\.py\x00$",
      source: "allow-always",
      lastUsedAt: 654_321,
    });
  });

  it("returns null when approval socket credentials are missing", async () => {
    await expect(
      requestExecApprovalViaSocket({
        socketPath: "",
        token: "secret",
        request: { command: "echo hi" },
      }),
    ).resolves.toBeNull();
    await expect(
      requestExecApprovalViaSocket({
        socketPath: "/tmp/socket",
        token: "",
        request: { command: "echo hi" },
      }),
    ).resolves.toBeNull();
    expect(requestJsonlSocketMock).not.toHaveBeenCalled();
  });

  it("builds approval socket payloads and accepts decision responses only", async () => {
    requestJsonlSocketMock.mockImplementationOnce(async ({ requestLine, accept, timeoutMs }) => {
      expect(timeoutMs).toBe(15_000);
      const parsed = JSON.parse(requestLine) as {
        type: string;
        token: string;
        id: string;
        request: { command: string };
      };
      expect(parsed.type).toBe("request");
      expect(parsed.token).toBe("secret");
      expect(parsed.request).toEqual({ command: "echo hi" });
      expect(parsed.id).toMatch(/^[0-9a-f-]{36}$/i);
      expect(accept({ type: "noop", decision: "allow-once" })).toBeUndefined();
      expect(accept({ type: "decision", decision: "allow-always" })).toBe("allow-always");
      return "deny";
    });

    await expect(
      requestExecApprovalViaSocket({
        socketPath: "/tmp/socket",
        token: "secret",
        request: { command: "echo hi" },
      }),
    ).resolves.toBe("deny");
  });
});
