import { spawn } from "node:child_process";
import { once } from "node:events";
// Covers exec approvals store socket interactions.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import { makeTempDir } from "./exec-approvals-test-helpers.js";

const requestJsonlSocketMock = vi.hoisted(() => vi.fn());

vi.mock("./jsonl-socket.js", () => ({
  requestJsonlSocket: (...args: unknown[]) => requestJsonlSocketMock(...args),
}));

import type { ExecApprovalsFile } from "./exec-approvals.js";

type ExecApprovalsModule = typeof import("./exec-approvals.js");

let ensureExecApprovals: ExecApprovalsModule["ensureExecApprovals"];
let ensureExecApprovalsSnapshot: ExecApprovalsModule["ensureExecApprovalsSnapshot"];
let commitExecAuthorization: ExecApprovalsModule["commitExecAuthorizationLocked"];
let createExecApprovalPolicySnapshot: ExecApprovalsModule["createExecApprovalPolicySnapshot"];
let loadExecApprovals: ExecApprovalsModule["loadExecApprovals"];
let mergeExecApprovalsSocketDefaults: ExecApprovalsModule["mergeExecApprovalsSocketDefaults"];
let normalizeExecApprovals: ExecApprovalsModule["normalizeExecApprovals"];
let persistAllowAlwaysDecision: ExecApprovalsModule["persistAllowAlwaysDecisionLocked"];
let persistAllowAlwaysDecisionSync: ExecApprovalsModule["persistAllowAlwaysDecision"];
let persistAllowAlwaysPatterns: ExecApprovalsModule["persistAllowAlwaysPatterns"];
let readExecApprovalsSnapshot: ExecApprovalsModule["readExecApprovalsSnapshot"];
let recordAllowlistMatchesUse: ExecApprovalsModule["recordAllowlistMatchesUseLocked"];
let recordAllowlistMatchesUseSync: ExecApprovalsModule["recordAllowlistMatchesUse"];
let requestExecApprovalViaSocket: ExecApprovalsModule["requestExecApprovalViaSocket"];
let restoreExecApprovalsSnapshotLocked: ExecApprovalsModule["restoreExecApprovalsSnapshotLocked"];
let resolveExecApprovals: ExecApprovalsModule["resolveExecApprovalsLocked"];
let resolveExecApprovalsSync: ExecApprovalsModule["resolveExecApprovals"];
let resolveExecApprovalsDisplayPath: ExecApprovalsModule["resolveExecApprovalsDisplayPath"];
let resolveExecApprovalsPath: ExecApprovalsModule["resolveExecApprovalsPath"];
let resolveExecApprovalsSocketPath: ExecApprovalsModule["resolveExecApprovalsSocketPath"];
let resolveExecApprovalsTranscriptPath: ExecApprovalsModule["resolveExecApprovalsTranscriptPath"];
let saveExecApprovals: ExecApprovalsModule["saveExecApprovals"];
let updateExecApprovals: ExecApprovalsModule["updateExecApprovals"];

const tempDirs: string[] = [];
const testEnvSnapshot = captureEnv(["OPENCLAW_HOME", "OPENCLAW_STATE_DIR"]);

beforeAll(async () => {
  const module = await import("./exec-approvals.js");
  ensureExecApprovals = module.ensureExecApprovals;
  ensureExecApprovalsSnapshot = module.ensureExecApprovalsSnapshot;
  commitExecAuthorization = module.commitExecAuthorizationLocked;
  createExecApprovalPolicySnapshot = module.createExecApprovalPolicySnapshot;
  loadExecApprovals = module.loadExecApprovals;
  mergeExecApprovalsSocketDefaults = module.mergeExecApprovalsSocketDefaults;
  normalizeExecApprovals = module.normalizeExecApprovals;
  persistAllowAlwaysDecision = module.persistAllowAlwaysDecisionLocked;
  persistAllowAlwaysDecisionSync = module.persistAllowAlwaysDecision;
  persistAllowAlwaysPatterns = module.persistAllowAlwaysPatterns;
  readExecApprovalsSnapshot = module.readExecApprovalsSnapshot;
  recordAllowlistMatchesUse = module.recordAllowlistMatchesUseLocked;
  recordAllowlistMatchesUseSync = module.recordAllowlistMatchesUse;
  requestExecApprovalViaSocket = module.requestExecApprovalViaSocket;
  restoreExecApprovalsSnapshotLocked = module.restoreExecApprovalsSnapshotLocked;
  resolveExecApprovals = module.resolveExecApprovalsLocked;
  resolveExecApprovalsSync = module.resolveExecApprovals;
  resolveExecApprovalsDisplayPath = module.resolveExecApprovalsDisplayPath;
  resolveExecApprovalsPath = module.resolveExecApprovalsPath;
  resolveExecApprovalsSocketPath = module.resolveExecApprovalsSocketPath;
  resolveExecApprovalsTranscriptPath = module.resolveExecApprovalsTranscriptPath;
  saveExecApprovals = module.saveExecApprovals;
  updateExecApprovals = module.updateExecApprovals;
});

beforeEach(() => {
  requestJsonlSocketMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  testEnvSnapshot.restore();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createHomeDir(): string {
  const dir = makeTempDir();
  tempDirs.push(dir);
  setTestEnvValue("OPENCLAW_HOME", dir);
  deleteTestEnvValue("OPENCLAW_STATE_DIR");
  return dir;
}

function approvalsFilePath(homeDir: string): string {
  return path.join(homeDir, ".openclaw", "exec-approvals.json");
}

function stateApprovalsFilePath(stateDir: string): string {
  return path.join(stateDir, "exec-approvals.json");
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
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a non-array record");
  }
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
    expect(resolveExecApprovalsDisplayPath()).toBe("~/.openclaw/exec-approvals.json");
  });

  it("uses OPENCLAW_STATE_DIR for default file and socket paths", () => {
    const dir = createHomeDir();
    const stateDir = path.join(dir, "custom-state");
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);

    expect(path.normalize(resolveExecApprovalsPath())).toBe(
      path.normalize(stateApprovalsFilePath(stateDir)),
    );
    expect(path.normalize(resolveExecApprovalsSocketPath())).toBe(
      path.normalize(path.join(stateDir, "exec-approvals.sock")),
    );
    expect(resolveExecApprovalsDisplayPath()).toBe(stateApprovalsFilePath(stateDir));
    expect(resolveExecApprovalsTranscriptPath()).toBe("$OPENCLAW_STATE_DIR/exec-approvals.json");

    const ensured = ensureExecApprovals();

    expect(ensured.socket?.path).toBe(resolveExecApprovalsSocketPath());
    expect(fs.existsSync(stateApprovalsFilePath(stateDir))).toBe(true);
    expect(fs.existsSync(approvalsFilePath(dir))).toBe(false);
  });

  it("keeps the deprecated plugin compatibility APIs synchronous", () => {
    createHomeDir();
    const approvals = ensureExecApprovals();

    expect(approvals).not.toBeInstanceOf(Promise);
    expect(resolveExecApprovalsSync("main")).not.toBeInstanceOf(Promise);
    expect(
      persistAllowAlwaysDecisionSync({
        approvals,
        agentId: "main",
        decision: { kind: "one-shot", reasons: ["unplanned"] },
      }),
    ).toBeUndefined();
    expect(
      recordAllowlistMatchesUseSync({
        approvals,
        agentId: "main",
        matches: [],
        command: "true",
      }),
    ).toBeUndefined();
  });

  it("persists synchronous compatibility writes without restoring revoked policy", async () => {
    const dir = createHomeDir();
    ensureExecApprovals();
    await updateExecApprovals({
      update: (file) => ({
        ...file,
        defaults: { ...file.defaults, security: "allowlist" },
        agents: {
          ...file.agents,
          main: {
            ...file.agents?.main,
            allowlist: [{ id: "revoked", pattern: "/bin/echo" }],
          },
        },
      }),
    });
    const stale = readExecApprovalsSnapshot().file;

    await updateExecApprovals({
      update: (file) => ({
        ...file,
        defaults: { ...file.defaults, security: "deny" },
        agents: { ...file.agents, main: { ...file.agents?.main, allowlist: [] } },
      }),
    });
    persistAllowAlwaysDecisionSync({
      approvals: stale,
      agentId: "main",
      decision: { kind: "exact-command", commandText: "echo stale" },
    });
    recordAllowlistMatchesUseSync({
      approvals: stale,
      agentId: "main",
      matches: [{ id: "revoked", pattern: "/bin/echo" }],
      command: "echo stale",
    });

    expect(stale.defaults?.security).toBe("deny");
    expect(stale.agents?.main?.allowlist).toEqual([
      expect.objectContaining({ pattern: expect.stringMatching(/^=command:/) }),
    ]);
    expect(readApprovalsFile(dir).defaults?.security).toBe("deny");
    expect(allowlistEntries(dir, "main")).toEqual([
      expect.objectContaining({ pattern: expect.stringMatching(/^=command:/) }),
    ]);
  });

  it("fails closed when a synchronous writer finds an ownerless live lock", () => {
    const dir = createHomeDir();
    ensureExecApprovals();
    const lockPath = `${approvalsFilePath(dir)}.lock`;
    const descriptor = fs.openSync(lockPath, "wx", 0o600);
    try {
      const staleAt = new Date(Date.now() - 60_000);
      fs.futimesSync(descriptor, staleAt, staleAt);
      const before = fs.fstatSync(descriptor);

      expect(() =>
        saveExecApprovals({ version: 1, defaults: { security: "full" }, agents: {} }),
      ).toThrow(expect.objectContaining({ code: "file_lock_timeout" }));

      const after = fs.statSync(lockPath);
      expect({ dev: after.dev, ino: after.ino }).toEqual({ dev: before.dev, ino: before.ino });
      fs.writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid })}\n`, "utf8");
      expect(fs.readFileSync(lockPath, "utf8")).toContain(`"pid":${process.pid}`);
    } finally {
      fs.closeSync(descriptor);
      fs.rmSync(lockPath, { force: true });
    }
  });

  it("retries brief synchronous contention from another process", async () => {
    const dir = createHomeDir();
    ensureExecApprovals();
    const lockPath = `${approvalsFilePath(dir)}.lock`;
    const child = spawn(
      process.execPath,
      [
        "-e",
        [
          'const fs = require("node:fs");',
          "const lockPath = process.argv[1];",
          'const descriptor = fs.openSync(lockPath, "wx", 0o600);',
          "fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid }));",
          'process.stdout.write("ready\\n");',
          "setTimeout(() => {",
          "  fs.closeSync(descriptor);",
          "  fs.rmSync(lockPath, { force: true });",
          "}, 100);",
        ].join("\n"),
        lockPath,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    await once(child.stdout, "data");

    try {
      saveExecApprovals({ version: 1, defaults: { security: "allowlist" }, agents: {} });
      expect(readApprovalsFile(dir).defaults?.security).toBe("allowlist");
    } finally {
      if (child.exitCode === null) {
        await once(child, "exit");
      }
    }
  });

  it("fails closed without writing target approvals before state migration runs", async () => {
    const dir = createHomeDir();
    const stateDir = path.join(dir, "custom-state");
    fs.mkdirSync(path.dirname(approvalsFilePath(dir)), { recursive: true });
    fs.writeFileSync(
      approvalsFilePath(dir),
      `${JSON.stringify({
        version: 1,
        socket: {
          path: path.join(dir, ".openclaw", "exec-approvals.sock"),
          token: "legacy-token",
        },
        defaults: {
          security: "deny",
          ask: "always",
        },
        agents: {},
      })}\n`,
      "utf8",
    );
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);

    const resolved = await resolveExecApprovals("main", {
      security: "full",
      ask: "off",
    });

    expect(resolved.agent.security).toBe("deny");
    expect(resolved.agent.ask).toBe("always");
    expect(resolved.token).toBe("");
    expect(fs.existsSync(stateApprovalsFilePath(stateDir))).toBe(false);
    expect(fs.existsSync(approvalsFilePath(dir))).toBe(true);

    const ensured = ensureExecApprovals();

    expect(ensured.defaults).toEqual({
      security: "deny",
      ask: "always",
      askFallback: "deny",
      autoAllowSkills: undefined,
    });
    expect(fs.existsSync(stateApprovalsFilePath(stateDir))).toBe(false);

    await expect(
      updateExecApprovals({
        update: (current) => ({ ...current, defaults: { security: "full" } }),
      }),
    ).rejects.toThrow("must be migrated");
    expect(fs.existsSync(stateApprovalsFilePath(stateDir))).toBe(false);
  });

  it("keeps the default approvals path when only legacy state exists", () => {
    const dir = createHomeDir();
    fs.mkdirSync(path.join(dir, ".clawdbot"), { recursive: true });

    expect(path.normalize(resolveExecApprovalsPath())).toBe(path.normalize(approvalsFilePath(dir)));

    ensureExecApprovals();

    expect(fs.existsSync(approvalsFilePath(dir))).toBe(true);
    expect(fs.existsSync(path.join(dir, ".clawdbot", "exec-approvals.json"))).toBe(false);
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

  it("distinguishes a missing approvals file from malformed persisted policy", () => {
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
    expect(invalid.file.defaults).toMatchObject({
      security: "deny",
      ask: "off",
      askFallback: "deny",
      autoAllowSkills: false,
    });
  });

  it.runIf(process.platform !== "win32")(
    "fails closed on load and rejects snapshots for symlinked approvals",
    async () => {
      const dir = createHomeDir();
      const approvalsPath = approvalsFilePath(dir);
      const linkedPath = path.join(dir, "linked-approvals.json");
      fs.mkdirSync(path.dirname(approvalsPath), { recursive: true });
      fs.writeFileSync(
        linkedPath,
        '{"version":1,"defaults":{"security":"full","ask":"off"},"agents":{}}\n',
        "utf8",
      );
      fs.symlinkSync(linkedPath, approvalsPath);

      expect(loadExecApprovals().defaults).toMatchObject({ security: "deny", ask: "off" });
      expect(() => readExecApprovalsSnapshot()).toThrow(/symlink/);
      await expect(
        updateExecApprovals({
          update: () => ({ version: 1, defaults: { security: "deny" }, agents: {} }),
        }),
      ).rejects.toThrow(/symlink/);
      expect(fs.readFileSync(linkedPath, "utf8")).toContain('"security":"full"');
    },
  );

  it("fails closed on load and rejects snapshots for non-file approvals paths", () => {
    const dir = createHomeDir();
    const approvalsPath = approvalsFilePath(dir);
    fs.mkdirSync(approvalsPath, { recursive: true });

    expect(loadExecApprovals().defaults).toMatchObject({ security: "deny", ask: "off" });
    expect(() => readExecApprovalsSnapshot()).toThrow(/non-file exec approvals path/);
  });

  it("does not let a stale missing-file snapshot overwrite a present empty policy", async () => {
    const dir = createHomeDir();
    const approvalsPath = approvalsFilePath(dir);
    const missing = readExecApprovalsSnapshot();
    fs.mkdirSync(path.dirname(approvalsPath), { recursive: true });
    fs.writeFileSync(approvalsPath, "", "utf8");

    const empty = readExecApprovalsSnapshot();
    expect(empty.hash).not.toBe(missing.hash);
    await expect(
      updateExecApprovals({
        baseHash: missing.hash,
        update: () => ({ version: 1, defaults: { security: "full" }, agents: {} }),
      }),
    ).resolves.toBeNull();
    expect(fs.readFileSync(approvalsPath, "utf8")).toBe("");
  });

  it("restores a matching real-store snapshot", async () => {
    const dir = createHomeDir();
    saveExecApprovals({ version: 1, defaults: { security: "deny" }, agents: {} });
    const snapshot = readExecApprovalsSnapshot();
    const current = await updateExecApprovals({
      update: (file) => ({ ...file, defaults: { security: "full" } }),
    });

    expect(current).not.toBeNull();
    if (!current) {
      throw new Error("Expected the current approvals snapshot");
    }
    await expect(restoreExecApprovalsSnapshotLocked(snapshot, current.hash)).resolves.toBe(true);
    expect(fs.readFileSync(approvalsFilePath(dir), "utf8")).toBe(snapshot.raw);
  });

  it("removes a newly created approvals file when the current hash still matches", async () => {
    const dir = createHomeDir();
    const missing = readExecApprovalsSnapshot();
    const created = await updateExecApprovals({
      baseHash: missing.hash,
      update: () => ({ version: 1, defaults: { security: "deny" }, agents: {} }),
    });

    expect(created).not.toBeNull();
    if (!created) {
      throw new Error("Expected the created approvals snapshot");
    }
    await expect(restoreExecApprovalsSnapshotLocked(missing, created.hash)).resolves.toBe(true);
    expect(fs.existsSync(approvalsFilePath(dir))).toBe(false);
  });

  it("preserves a newer approvals file when snapshot restoration loses its CAS", async () => {
    const dir = createHomeDir();
    saveExecApprovals({ version: 1, defaults: { security: "deny" }, agents: {} });
    const snapshot = readExecApprovalsSnapshot();
    const base = await updateExecApprovals({
      update: (file) => ({ ...file, defaults: { security: "allowlist" } }),
    });
    const newer = await updateExecApprovals({
      update: (file) => ({ ...file, defaults: { security: "full" } }),
    });

    expect(base).not.toBeNull();
    expect(newer).not.toBeNull();
    if (!base || !newer) {
      throw new Error("Expected both approvals snapshots");
    }
    await expect(restoreExecApprovalsSnapshotLocked(snapshot, base.hash)).resolves.toBe(false);
    expect(fs.readFileSync(approvalsFilePath(dir), "utf8")).toBe(newer.raw);
  });

  it.runIf(process.platform !== "win32")(
    "normalizes the approvals directory before an async no-op update",
    async () => {
      const dir = createHomeDir();
      saveExecApprovals({ version: 1, defaults: { security: "deny" }, agents: {} });
      const approvalsDir = path.dirname(approvalsFilePath(dir));
      fs.chmodSync(approvalsDir, 0o777);

      await expect(updateExecApprovals({ update: () => null })).resolves.not.toBeNull();

      expect(fs.statSync(approvalsDir).mode & 0o777).toBe(0o700);
    },
  );

  it.runIf(process.platform !== "win32")(
    "normalizes the approvals directory before an async CAS miss",
    async () => {
      const dir = createHomeDir();
      saveExecApprovals({ version: 1, defaults: { security: "deny" }, agents: {} });
      const approvalsDir = path.dirname(approvalsFilePath(dir));
      fs.chmodSync(approvalsDir, 0o777);

      await expect(
        updateExecApprovals({
          baseHash: "stale",
          update: (file) => ({ ...file, defaults: { security: "full" } }),
        }),
      ).resolves.toBeNull();

      expect(fs.statSync(approvalsDir).mode & 0o777).toBe(0o700);
    },
  );

  it("fails closed when loading malformed or unreadable persisted approvals", () => {
    const dir = createHomeDir();
    const approvalsPath = approvalsFilePath(dir);
    fs.mkdirSync(path.dirname(approvalsPath), { recursive: true });
    fs.writeFileSync(approvalsPath, "{invalid", "utf8");

    expect(loadExecApprovals().defaults).toMatchObject({ security: "deny", ask: "off" });

    fs.writeFileSync(
      approvalsPath,
      '{"version":1,"defaults":{"security":"invalid"},"agents":{}}\n',
      "utf8",
    );
    expect(loadExecApprovals().defaults).toMatchObject({ security: "deny", ask: "off" });

    fs.writeFileSync(
      approvalsPath,
      '{"version":1,"agents":{"main":{"allowlist":[{"pattern":"/usr/bin/tool","argPattern":null}]}}}\n',
      "utf8",
    );
    expect(loadExecApprovals().defaults).toMatchObject({ security: "deny", ask: "off" });

    const approvalsStat = fs.statSync(approvalsPath);
    const actualReadFileSync = fs.readFileSync.bind(fs);
    vi.spyOn(fs, "readFileSync").mockImplementation((target, options) => {
      const targetStat = typeof target === "number" ? fs.fstatSync(target) : null;
      if (
        String(target) === approvalsPath ||
        (targetStat?.dev === approvalsStat.dev && targetStat.ino === approvalsStat.ino)
      ) {
        throw Object.assign(new Error("approval path blocked"), { code: "EACCES" });
      }
      return actualReadFileSync(target, options as never);
    });

    expect(loadExecApprovals().defaults).toMatchObject({ security: "deny", ask: "off" });
  });

  it("keeps synchronous and locked resolution fail-closed for malformed persisted policy", async () => {
    const dir = createHomeDir();
    const approvalsPath = approvalsFilePath(dir);
    fs.mkdirSync(path.dirname(approvalsPath), { recursive: true });
    fs.writeFileSync(approvalsPath, "", "utf8");

    const syncResolved = resolveExecApprovalsSync("main", {
      security: "full",
      ask: "off",
    });
    const lockedResolved = await resolveExecApprovals("main", {
      security: "full",
      ask: "off",
    });

    expect(syncResolved.agent).toMatchObject({ security: "deny", ask: "off" });
    expect(lockedResolved.agent).toMatchObject({ security: "deny", ask: "off" });
    expect(syncResolved.token).toBe("");
    expect(lockedResolved.token).toBe("");
    expect(fs.readFileSync(approvalsPath, "utf8")).toBe("");
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

  it("does not rewrite already-initialized approvals", async () => {
    createHomeDir();
    await ensureExecApprovalsSnapshot();
    const renameSpy = vi.spyOn(fs, "renameSync");

    await ensureExecApprovalsSnapshot();

    expect(renameSpy).not.toHaveBeenCalled();
  });

  it("does not create an approvals file when resolving the missing default no-prompt policy", async () => {
    const dir = createHomeDir();
    const stateDir = path.dirname(approvalsFilePath(dir));

    const resolved = await resolveExecApprovals("main", {
      security: "full",
      ask: "off",
    });

    expect(resolved.agent.security).toBe("full");
    expect(resolved.agent.ask).toBe("off");
    expect(resolved.socketPath).toBe(resolveExecApprovalsSocketPath());
    expect(resolved.token).toBe("");
    expect(fs.existsSync(approvalsFilePath(dir))).toBe(false);
    expect(fs.existsSync(stateDir)).toBe(false);
  });

  it.each([
    {
      mode: "sync",
      resolve: async () =>
        resolveExecApprovalsSync("main", {
          security: "full",
          ask: "off",
        }),
    },
    {
      mode: "async",
      resolve: async () =>
        await resolveExecApprovals("main", {
          security: "full",
          ask: "off",
        }),
    },
  ])("re-reads policy created after the final lock probe ($mode)", async ({ resolve }) => {
    const dir = createHomeDir();
    const approvalsPath = approvalsFilePath(dir);
    const stateDir = path.dirname(approvalsPath);
    fs.mkdirSync(stateDir, { recursive: true });
    const restrictivePolicy = `${JSON.stringify(
      {
        version: 1,
        defaults: { security: "deny", ask: "off" },
        agents: {},
      },
      null,
      2,
    )}\n`;
    const realpathSync = fs.realpathSync.bind(fs);
    let stateDirProbeCount = 0;
    vi.spyOn(fs, "realpathSync").mockImplementation((target) => {
      const resolved = realpathSync(target);
      if (path.normalize(String(target)) === path.normalize(stateDir)) {
        stateDirProbeCount += 1;
        if (stateDirProbeCount === 2) {
          // Simulate a writer that observed the old lock as absent, then fully
          // committed a restrictive file before the reader's target probe.
          fs.writeFileSync(approvalsPath, restrictivePolicy, "utf8");
        }
      }
      return resolved;
    });

    const resolved = await resolve();

    expect(stateDirProbeCount).toBeGreaterThanOrEqual(2);
    expect(resolved.agent).toMatchObject({ security: "deny", ask: "off" });
  });

  it("fails closed when a writer locks the store before creating the policy file", () => {
    const dir = createHomeDir();
    const approvalsPath = approvalsFilePath(dir);
    fs.mkdirSync(path.dirname(approvalsPath), { recursive: true });
    fs.writeFileSync(
      `${approvalsPath}.lock`,
      `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`,
      "utf8",
    );

    expect(loadExecApprovals().defaults).toMatchObject({ security: "deny", ask: "off" });
    expect(fs.existsSync(approvalsPath)).toBe(false);
  });

  it("does not rewrite an empty approvals file while failing closed", async () => {
    const dir = createHomeDir();
    const approvalsPath = approvalsFilePath(dir);
    fs.mkdirSync(path.dirname(approvalsPath), { recursive: true });
    fs.writeFileSync(approvalsPath, "", "utf8");

    const resolved = await resolveExecApprovals("main", {
      security: "full",
      ask: "off",
    });

    expect(resolved.agent.security).toBe("deny");
    expect(resolved.agent.ask).toBe("off");
    expect(resolved.token).toBe("");
    expect(fs.statSync(approvalsPath).size).toBe(0);
  });

  it.runIf(process.platform !== "win32")(
    "hardens existing token-bearing approvals files before resolving default no-prompt policy",
    async () => {
      const dir = createHomeDir();
      const approvalsPath = approvalsFilePath(dir);
      fs.mkdirSync(path.dirname(approvalsPath), { recursive: true });
      fs.writeFileSync(
        approvalsPath,
        JSON.stringify({
          version: 1,
          socket: { path: resolveExecApprovalsSocketPath(), token: "existing-token" },
          defaults: { security: "full", ask: "off" },
          agents: {},
        }),
        { mode: 0o644 },
      );
      fs.chmodSync(approvalsPath, 0o644);

      const resolved = await resolveExecApprovals("main", {
        security: "full",
        ask: "off",
      });

      expect(resolved.agent.security).toBe("full");
      expect(resolved.agent.ask).toBe("off");
      expect(resolved.token).toBe("existing-token");
      expect(fs.statSync(approvalsPath).mode & 0o777).toBe(0o600);
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects symlinked approvals files before resolving the default no-prompt policy",
    async () => {
      const dir = createHomeDir();
      const approvalsPath = approvalsFilePath(dir);
      const linkedPath = path.join(dir, "linked-approvals.json");
      fs.mkdirSync(path.dirname(approvalsPath), { recursive: true });
      fs.writeFileSync(
        linkedPath,
        JSON.stringify({
          version: 1,
          defaults: { security: "full", ask: "off" },
          agents: {},
        }),
        "utf8",
      );
      fs.symlinkSync(linkedPath, approvalsPath);

      await expect(
        resolveExecApprovals("main", {
          security: "deny",
          ask: "always",
        }),
      ).rejects.toThrow("Refusing to write exec approvals via symlink");
    },
  );

  it("rejects non-file approvals paths before resolving the default no-prompt policy", async () => {
    const dir = createHomeDir();
    fs.mkdirSync(approvalsFilePath(dir), { recursive: true });

    await expect(
      resolveExecApprovals("main", {
        security: "deny",
        ask: "always",
      }),
    ).rejects.toThrow("Refusing to use non-file exec approvals path");
  });

  it("does not treat approvals path access errors as a missing default policy", async () => {
    const dir = createHomeDir();
    const approvalsPath = approvalsFilePath(dir);
    fs.mkdirSync(path.dirname(approvalsPath), { recursive: true });
    fs.writeFileSync(
      approvalsPath,
      '{"version":1,"defaults":{"security":"full","ask":"off"},"agents":{}}\n',
      "utf8",
    );
    const approvalsStat = fs.statSync(approvalsPath);
    const actualReadFileSync = fs.readFileSync.bind(fs);
    vi.spyOn(fs, "readFileSync").mockImplementation((target, options) => {
      const targetStat = typeof target === "number" ? fs.fstatSync(target) : null;
      if (
        String(target) === approvalsPath ||
        (targetStat?.dev === approvalsStat.dev && targetStat.ino === approvalsStat.ino)
      ) {
        throw Object.assign(new Error("approval path blocked"), { code: "EACCES" });
      }
      return actualReadFileSync(target, options as never);
    });

    const resolved = await resolveExecApprovals("main", {
      security: "full",
      ask: "off",
    });

    expect(resolved.agent).toMatchObject({ security: "deny", ask: "off" });
  });

  it("creates an approvals file when resolving a missing policy that may prompt", async () => {
    const dir = createHomeDir();

    const resolved = await resolveExecApprovals("main", {
      security: "allowlist",
      ask: "on-miss",
    });

    expect(resolved.agent.security).toBe("allowlist");
    expect(resolved.agent.ask).toBe("on-miss");
    expect(resolved.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(readApprovalsFile(dir).socket).toEqual(resolved.file.socket);
  });

  it("creates an approvals file for default no-prompt policy when a socket is required", async () => {
    const dir = createHomeDir();

    const resolved = await resolveExecApprovals("main", {
      security: "full",
      ask: "off",
      requireSocket: true,
    });

    expect(resolved.agent.security).toBe("full");
    expect(resolved.agent.ask).toBe("off");
    expect(resolved.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(readApprovalsFile(dir).socket).toEqual(resolved.file.socket);
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

  it.runIf(process.platform !== "win32")(
    "keeps exec approvals strict when directory chmod fails",
    async () => {
      const dir = createHomeDir();
      const approvalsDir = path.dirname(approvalsFilePath(dir));
      const actualChmodSync = fs.chmodSync.bind(fs);
      vi.spyOn(fs, "chmodSync").mockImplementation((target, mode) => {
        if (String(target) === approvalsDir) {
          throw Object.assign(new Error("chmod denied"), { code: "EPERM" });
        }
        return actualChmodSync(target, mode);
      });

      expect(() => ensureExecApprovals()).toThrow("chmod denied");
      expect(fs.existsSync(approvalsFilePath(dir))).toBe(false);
    },
  );

  it("breaks a hard link when an otherwise unchanged file is ensured", async () => {
    const dir = createHomeDir();
    const approvalsPath = approvalsFilePath(dir);
    const linkedPath = path.join(dir, "linked-approvals.json");
    ensureExecApprovals();
    fs.linkSync(approvalsPath, linkedPath);

    await ensureExecApprovalsSnapshot();

    expect(fs.statSync(approvalsPath).ino).not.toBe(fs.statSync(linkedPath).ino);
    expect(JSON.parse(fs.readFileSync(approvalsPath, "utf8"))).toEqual(
      JSON.parse(fs.readFileSync(linkedPath, "utf8")),
    );
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

  it("fails closed while the Windows copy fallback has truncated the live policy", () => {
    const dir = createHomeDir();
    const approvalsPath = approvalsFilePath(dir);
    fs.mkdirSync(path.dirname(approvalsPath), { recursive: true });
    fs.writeFileSync(
      approvalsPath,
      '{"version":1,"defaults":{"security":"deny","ask":"off"},"agents":{}}\n',
      "utf8",
    );
    const actualRenameSync = fs.renameSync.bind(fs);
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to) === approvalsPath) {
        throw Object.assign(new Error("locked target"), { code: "EPERM" });
      }
      return actualRenameSync(from, to);
    });
    const actualReadFileSync = fs.readFileSync.bind(fs);
    let fallbackWriteInProgress = false;
    let approvalReadsDuringTruncate = 0;
    vi.spyOn(fs, "readFileSync").mockImplementation((target, options) => {
      if (fallbackWriteInProgress && String(target) === approvalsPath) {
        approvalReadsDuringTruncate += 1;
      }
      return actualReadFileSync(target, options as never);
    });
    const actualFtruncateSync = fs.ftruncateSync.bind(fs);
    let policyDuringTruncate: ExecApprovalsFile | undefined;
    vi.spyOn(fs, "ftruncateSync").mockImplementation((fd, length) => {
      const result = actualFtruncateSync(fd, length);
      if (length === 0 && !policyDuringTruncate) {
        fallbackWriteInProgress = true;
        try {
          policyDuringTruncate = loadExecApprovals();
        } finally {
          fallbackWriteInProgress = false;
        }
      }
      return result;
    });

    saveExecApprovals({
      version: 1,
      defaults: { security: "full", ask: "off" },
      agents: {},
    });

    expect(policyDuringTruncate?.defaults).toMatchObject({ security: "deny", ask: "off" });
    expect(approvalReadsDuringTruncate).toBe(0);
    expect(loadExecApprovals().defaults).toMatchObject({ security: "full", ask: "off" });
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
    setTestEnvValue("OPENCLAW_HOME", linkedHome);

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
    setTestEnvValue("OPENCLAW_HOME", linkedHome);

    expect(() =>
      saveExecApprovals({ version: 1, defaults: { security: "full" }, agents: {} }),
    ).toThrow(/Refusing to traverse symlink in exec approvals path/);
    expect(fs.existsSync(path.join(linkedStateTarget, "exec-approvals.json"))).toBe(false);
  });

  it.runIf(process.platform !== "win32")(
    "rejects a nested symlink before acquiring the async approvals lock",
    async () => {
      const realHome = makeTempDir();
      const linkedHome = `${realHome}-link`;
      const linkedStateTarget = path.join(realHome, "state-target");
      const redirectedLockPath = path.join(linkedStateTarget, "exec-approvals.json.lock");
      tempDirs.push(realHome, linkedHome);
      fs.mkdirSync(linkedStateTarget, { recursive: true });
      fs.symlinkSync(realHome, linkedHome, "dir");
      fs.symlinkSync(linkedStateTarget, path.join(realHome, ".openclaw"), "dir");
      setTestEnvValue("OPENCLAW_HOME", linkedHome);

      await expect(
        updateExecApprovals({
          update: () => ({ version: 1, defaults: { security: "deny" }, agents: {} }),
        }),
      ).rejects.toThrow(/Refusing to traverse symlink in exec approvals path/);
      expect(fs.existsSync(redirectedLockPath)).toBe(false);
      expect(fs.readdirSync(linkedStateTarget)).toEqual([]);
    },
  );

  it("persists exact-command allow-always decisions as durable command approvals", async () => {
    const dir = createHomeDir();
    vi.spyOn(Date, "now").mockReturnValue(321_000);

    ensureExecApprovals();
    await persistAllowAlwaysDecision({
      agentId: "worker",
      decision: {
        kind: "exact-command",
        commandText: 'printenv API_KEY="secret-value"',
      },
    });

    const allowlist = allowlistEntries(dir, "worker");
    expect(allowlist).toHaveLength(1);
    expectAllowlistEntryFields(allowlist[0] ?? {}, {
      source: "allow-always",
      lastUsedAt: 321_000,
    });
    expect(allowlist[0]?.pattern).toMatch(/^=command:[0-9a-f]{16}$/i);
    expect(allowlist[0]).not.toHaveProperty("commandText");
  });

  it("applies allow-always grants to the latest file after a concurrent policy write", async () => {
    const dir = createHomeDir();
    ensureExecApprovals();
    const snapshot = readExecApprovalsSnapshot();

    const policyWrite = updateExecApprovals({
      baseHash: snapshot.hash,
      update: (current) => ({
        ...current,
        defaults: { ...current.defaults, security: "deny" },
      }),
    });
    const grantWrite = persistAllowAlwaysDecision({
      agentId: "worker",
      decision: { kind: "exact-command", commandText: "echo approved" },
    });
    await Promise.all([policyWrite, grantWrite]);

    expect(readApprovalsFile(dir).defaults?.security).toBe("deny");
    expect(allowlistEntries(dir, "worker")).toEqual([
      expect.objectContaining({ source: "allow-always" }),
    ]);
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

  it("preserves source and argPattern metadata for allow-always entries", async () => {
    const dir = createHomeDir();
    vi.spyOn(Date, "now").mockReturnValue(321_000);

    ensureExecApprovals();
    await persistAllowAlwaysDecision({
      agentId: "worker",
      decision: {
        kind: "patterns",
        patterns: [
          { pattern: "/usr/bin/python3", argPattern: "^script\\.py\x00$" },
          { pattern: "/usr/bin/python3", argPattern: "^script\\.py\x00$" },
          { pattern: "/usr/bin/python3", argPattern: "^other\\.py\x00$" },
        ],
      },
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

  it("preserves whitespace-only argPattern bytes for allow-always entries", async () => {
    const dir = createHomeDir();

    ensureExecApprovals();
    await persistAllowAlwaysDecision({
      agentId: "worker",
      decision: {
        kind: "patterns",
        patterns: [{ pattern: "*", argPattern: "  " }],
      },
    });

    expect(allowlistEntries(dir, "worker")).toEqual([
      expect.objectContaining({
        pattern: "*",
        argPattern: "  ",
        source: "allow-always",
      }),
    ]);
  });

  it("records allowlist usage on the matching entry and backfills missing ids", async () => {
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

    await recordAllowlistMatchesUse({
      agentId: undefined,
      matches: [{ pattern: "/usr/bin/rg" }],
      command: "rg needle",
      resolvedPath: "/opt/homebrew/bin/rg",
    });

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

  it("dedupes allowlist usage by pattern and argPattern", async () => {
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

    await recordAllowlistMatchesUse({
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

  it("does not restore a revoked entry across initialization and usage writeback", async () => {
    const dir = createHomeDir();
    const approvalsPath = approvalsFilePath(dir);
    fs.mkdirSync(path.dirname(approvalsPath), { recursive: true });
    fs.writeFileSync(
      approvalsPath,
      `${JSON.stringify(
        {
          version: 1,
          defaults: { security: "allowlist" },
          agents: {
            main: {
              allowlist: [
                { pattern: "/usr/bin/rg", id: "rg-id" },
                { pattern: "/usr/bin/jq", id: "jq-id" },
              ],
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    const stale = readExecApprovalsSnapshot();
    const revoke = updateExecApprovals({
      baseHash: stale.hash,
      update: (current) => ({
        ...current,
        agents: {
          ...current.agents,
          main: { allowlist: [{ pattern: "/usr/bin/jq", id: "jq-id" }] },
        },
      }),
    });
    const ensure = ensureExecApprovalsSnapshot();
    const usage = recordAllowlistMatchesUse({
      agentId: "main",
      matches: [{ pattern: "/usr/bin/rg", id: "rg-id" }],
      command: "rg needle",
    });

    await Promise.all([revoke, ensure, usage]);

    const persisted = readApprovalsFile(dir);
    expect(persisted.socket?.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(persisted.agents?.main?.allowlist).toEqual([{ pattern: "/usr/bin/jq", id: "jq-id" }]);
  });

  it("rejects reusable execution after its current approval is revoked", async () => {
    const dir = createHomeDir();
    const approvalsPath = approvalsFilePath(dir);
    fs.mkdirSync(path.dirname(approvalsPath), { recursive: true });
    fs.writeFileSync(
      approvalsPath,
      JSON.stringify({
        version: 1,
        defaults: { security: "allowlist", ask: "off" },
        agents: { main: { allowlist: [{ pattern: "/usr/bin/rg", id: "rg-id" }] } },
      }),
    );

    await updateExecApprovals({
      update: (current) => ({
        ...current,
        agents: { ...current.agents, main: { allowlist: [] } },
      }),
    });

    await expect(
      recordAllowlistMatchesUse({
        agentId: "main",
        matches: [{ pattern: "/usr/bin/rg", id: "rg-id" }],
        command: "rg needle",
        authorization: {
          source: "current-policy",
          security: "allowlist",
          ask: "off",
          allowlistSatisfied: true,
        },
      }),
    ).rejects.toThrow("Exec approval changed before execution");
    expect(readApprovalsFile(dir).agents?.main?.allowlist).toEqual([]);
  });

  it("rejects reusable execution when its matched argPattern bytes change", async () => {
    const dir = createHomeDir();
    saveExecApprovals({
      version: 1,
      defaults: { security: "allowlist", ask: "off" },
      agents: {
        main: {
          allowlist: [{ pattern: "/usr/bin/rg", argPattern: " ^safe$ ", id: "rg-id" }],
        },
      },
    });

    await expect(
      commitExecAuthorization({
        agentId: "main",
        matches: [{ pattern: "/usr/bin/rg", argPattern: "^safe$", id: "rg-id" }],
        command: "rg safe",
        authorization: {
          source: "current-policy",
          security: "allowlist",
          ask: "off",
          allowlistSatisfied: true,
        },
      }),
    ).rejects.toThrow("Exec approval changed before execution");
    expect(readApprovalsFile(dir).agents?.main?.allowlist).toEqual([
      { pattern: "/usr/bin/rg", argPattern: " ^safe$ ", id: "rg-id" },
    ]);
  });

  it("rejects reusable execution when matched entry fields collide under separator encoding", async () => {
    const dir = createHomeDir();
    const currentEntry = { pattern: "/usr/bin/rg\x00a", argPattern: "b", id: "current-id" };
    saveExecApprovals({
      version: 1,
      defaults: { security: "allowlist", ask: "off" },
      agents: { main: { allowlist: [currentEntry] } },
    });

    await expect(
      commitExecAuthorization({
        agentId: "main",
        matches: [{ pattern: "/usr/bin/rg", argPattern: "a\x00b", id: "stale-id" }],
        command: "rg needle",
        authorization: {
          source: "current-policy",
          security: "allowlist",
          ask: "off",
          allowlistSatisfied: true,
        },
      }),
    ).rejects.toThrow("Exec approval changed before execution");
    expect(readApprovalsFile(dir).agents?.main?.allowlist).toEqual([currentEntry]);
  });

  it("rejects reusable execution when current policy changes to deny", async () => {
    const dir = createHomeDir();
    const approvalsPath = approvalsFilePath(dir);
    fs.mkdirSync(path.dirname(approvalsPath), { recursive: true });
    fs.writeFileSync(
      approvalsPath,
      JSON.stringify({
        version: 1,
        defaults: { security: "deny", ask: "off" },
        agents: { main: { allowlist: [{ pattern: "/usr/bin/rg", id: "rg-id" }] } },
      }),
    );

    await expect(
      recordAllowlistMatchesUse({
        agentId: "main",
        matches: [{ pattern: "/usr/bin/rg", id: "rg-id" }],
        command: "rg needle",
        authorization: {
          source: "current-policy",
          security: "allowlist",
          ask: "off",
          allowlistSatisfied: true,
        },
      }),
    ).rejects.toThrow("Exec approval changed before execution");
    expect(readApprovalsFile(dir).agents?.main?.allowlist?.[0]?.lastUsedAt).toBeUndefined();
  });

  it("rejects reusable execution after its exact-command approval is revoked", async () => {
    const dir = createHomeDir();
    const approvalsPath = approvalsFilePath(dir);
    fs.mkdirSync(path.dirname(approvalsPath), { recursive: true });
    fs.writeFileSync(
      approvalsPath,
      JSON.stringify({
        version: 1,
        defaults: { security: "allowlist", ask: "off" },
        agents: { main: { allowlist: [] } },
      }),
    );
    const command = "printf exact-command";
    await persistAllowAlwaysDecision({
      agentId: "main",
      decision: { kind: "exact-command", commandText: command },
    });
    await updateExecApprovals({
      update: (current) => ({
        ...current,
        agents: { ...current.agents, main: { allowlist: [] } },
      }),
    });

    await expect(
      recordAllowlistMatchesUse({
        agentId: "main",
        matches: [],
        command,
        authorization: {
          source: "current-policy",
          security: "allowlist",
          ask: "off",
          allowlistSatisfied: false,
          requireExactCommandApproval: true,
        },
      }),
    ).rejects.toThrow("Exec approval changed before execution");
  });

  it("rejects reusable skill execution after autoAllowSkills is removed", async () => {
    const dir = createHomeDir();
    const approvalsPath = approvalsFilePath(dir);
    fs.mkdirSync(path.dirname(approvalsPath), { recursive: true });
    fs.writeFileSync(
      approvalsPath,
      JSON.stringify({
        version: 1,
        defaults: { security: "allowlist", ask: "off" },
        agents: { main: {} },
      }),
    );

    await expect(
      recordAllowlistMatchesUse({
        agentId: "main",
        matches: [],
        command: "skill-tool",
        authorization: {
          source: "current-policy",
          security: "allowlist",
          ask: "off",
          allowlistSatisfied: true,
          requireAutoAllowSkills: true,
        },
      }),
    ).rejects.toThrow("Exec approval changed before execution");
  });

  it("rejects timed-out execution after askFallback is revoked", async () => {
    const dir = createHomeDir();
    const approvalsPath = approvalsFilePath(dir);
    fs.mkdirSync(path.dirname(approvalsPath), { recursive: true });
    fs.writeFileSync(
      approvalsPath,
      JSON.stringify({
        version: 1,
        defaults: { security: "full", ask: "on-miss", askFallback: "deny" },
      }),
    );

    await expect(
      recordAllowlistMatchesUse({
        agentId: "main",
        matches: [],
        command: "printf fallback",
        authorization: {
          source: "ask-fallback",
          security: "full",
          ask: "on-miss",
          allowlistSatisfied: false,
        },
      }),
    ).rejects.toThrow("Exec approval changed before execution");
  });

  it("rejects a full fallback when current policy tightens to allowlist", async () => {
    const dir = createHomeDir();
    const approvalsPath = approvalsFilePath(dir);
    fs.mkdirSync(path.dirname(approvalsPath), { recursive: true });
    fs.writeFileSync(
      approvalsPath,
      JSON.stringify({
        version: 1,
        defaults: { security: "full", ask: "always", askFallback: "allowlist" },
        agents: { main: { allowlist: [{ pattern: "/usr/bin/rg" }] } },
      }),
    );

    await expect(
      recordAllowlistMatchesUse({
        agentId: "main",
        matches: [{ pattern: "/usr/bin/rg" }],
        command: "rg needle",
        authorization: {
          source: "ask-fallback",
          security: "full",
          ask: "always",
          allowlistSatisfied: true,
        },
      }),
    ).rejects.toThrow("Exec approval changed before execution");
  });

  it("accepts a current full askFallback after an always-ask timeout", async () => {
    const dir = createHomeDir();
    const approvalsPath = approvalsFilePath(dir);
    fs.mkdirSync(path.dirname(approvalsPath), { recursive: true });
    fs.writeFileSync(
      approvalsPath,
      JSON.stringify({
        version: 1,
        defaults: { security: "full", ask: "always", askFallback: "full" },
      }),
    );

    await expect(
      recordAllowlistMatchesUse({
        agentId: "main",
        matches: [],
        command: "printf fallback",
        authorization: {
          source: "ask-fallback",
          security: "full",
          ask: "always",
          allowlistSatisfied: false,
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects an allowlist askFallback after its matched entry is revoked", async () => {
    const dir = createHomeDir();
    const approvalsPath = approvalsFilePath(dir);
    fs.mkdirSync(path.dirname(approvalsPath), { recursive: true });
    fs.writeFileSync(
      approvalsPath,
      JSON.stringify({
        version: 1,
        defaults: { security: "full", ask: "always", askFallback: "allowlist" },
        agents: { main: { allowlist: [] } },
      }),
    );

    await expect(
      recordAllowlistMatchesUse({
        agentId: "main",
        matches: [{ pattern: "/usr/bin/rg" }],
        command: "rg needle",
        authorization: {
          source: "ask-fallback",
          security: "allowlist",
          ask: "always",
          allowlistSatisfied: true,
        },
      }),
    ).rejects.toThrow("Exec approval changed before execution");
  });

  it("rejects an explicit approval after policy changes to deny without persisting its grant", async () => {
    const dir = createHomeDir();
    saveExecApprovals({
      version: 1,
      defaults: { security: "allowlist", ask: "always" },
      agents: { main: { allowlist: [] } },
    });
    const policySnapshot = createExecApprovalPolicySnapshot({
      file: readExecApprovalsSnapshot().file,
      agentId: "main",
    });

    await updateExecApprovals({
      update: (current) => ({
        ...current,
        defaults: { ...current.defaults, security: "deny", ask: "off" },
      }),
    });

    await expect(
      commitExecAuthorization({
        agentId: "main",
        matches: [],
        command: "printf approved",
        authorization: {
          source: "explicit-approval",
          security: "allowlist",
          ask: "always",
          allowlistSatisfied: false,
          policySnapshot,
        },
        allowAlwaysDecision: {
          kind: "exact-command",
          commandText: "printf approved",
        },
      }),
    ).rejects.toThrow("Exec approval changed before execution");
    expect(allowlistEntries(dir, "main")).toEqual([]);
  });

  it("rejects an explicit allow-always grant after its matched policy entry is revoked", async () => {
    const dir = createHomeDir();
    const matchedEntry = { pattern: "/usr/bin/rg", id: "rg-id" };
    saveExecApprovals({
      version: 1,
      defaults: { security: "allowlist", ask: "always" },
      agents: { main: { allowlist: [matchedEntry] } },
    });
    const policySnapshot = createExecApprovalPolicySnapshot({
      file: readExecApprovalsSnapshot().file,
      agentId: "main",
    });

    await updateExecApprovals({
      update: (current) => ({
        ...current,
        agents: { ...current.agents, main: { allowlist: [] } },
      }),
    });

    await expect(
      commitExecAuthorization({
        agentId: "main",
        matches: [matchedEntry],
        command: "rg needle",
        authorization: {
          source: "explicit-approval",
          security: "allowlist",
          ask: "always",
          allowlistSatisfied: true,
          policySnapshot,
        },
        allowAlwaysDecision: {
          kind: "patterns",
          patterns: [{ pattern: "/usr/bin/rg" }],
        },
      }),
    ).rejects.toThrow("Exec approval changed before execution");
    expect(allowlistEntries(dir, "main")).toEqual([]);
  });

  it("rejects an explicit grant after an allow-always source downgrade", async () => {
    const dir = createHomeDir();
    saveExecApprovals({
      version: 1,
      defaults: { security: "allowlist", ask: "always" },
      agents: {
        main: { allowlist: [{ pattern: "/usr/bin/rg", source: "allow-always" }] },
      },
    });
    const policySnapshot = createExecApprovalPolicySnapshot({
      file: readExecApprovalsSnapshot().file,
      agentId: "main",
    });

    await updateExecApprovals({
      update: (current) => ({
        ...current,
        agents: { ...current.agents, main: { allowlist: [{ pattern: "/usr/bin/rg" }] } },
      }),
    });

    await expect(
      commitExecAuthorization({
        agentId: "main",
        matches: [],
        command: "rg needle",
        authorization: {
          source: "explicit-approval",
          security: "allowlist",
          ask: "always",
          allowlistSatisfied: false,
          policySnapshot,
        },
        allowAlwaysDecision: {
          kind: "patterns",
          patterns: [{ pattern: "/usr/bin/rg" }],
        },
      }),
    ).rejects.toThrow("Exec approval changed before execution");
    expect(allowlistEntries(dir, "main")).toEqual([{ pattern: "/usr/bin/rg" }]);
  });

  it("commits an explicit allow-always grant after current-policy authorization", async () => {
    const dir = createHomeDir();
    saveExecApprovals({
      version: 1,
      defaults: { security: "allowlist", ask: "always" },
      agents: { main: { allowlist: [] } },
    });
    const policySnapshot = createExecApprovalPolicySnapshot({
      file: readExecApprovalsSnapshot().file,
      agentId: "main",
    });

    await commitExecAuthorization({
      agentId: "main",
      matches: [],
      command: "printf approved",
      authorization: {
        source: "explicit-approval",
        security: "allowlist",
        ask: "always",
        allowlistSatisfied: false,
        policySnapshot,
      },
      allowAlwaysDecision: {
        kind: "exact-command",
        commandText: "printf approved",
      },
    });

    expect(allowlistEntries(dir, "main")).toEqual([
      expect.objectContaining({
        pattern: expect.stringMatching(/^=command:/),
        source: "allow-always",
      }),
    ]);
  });

  it("preserves concurrent explicit allow-always grants from the same policy snapshot", async () => {
    const dir = createHomeDir();
    saveExecApprovals({
      version: 1,
      defaults: { security: "allowlist", ask: "always" },
      agents: { researcher: { allowlist: [{ pattern: "/usr/bin/grep" }] } },
    });
    const policySnapshot = createExecApprovalPolicySnapshot({
      file: readExecApprovalsSnapshot().file,
      agentId: "researcher",
    });
    const commitGrant = (command: string, pattern: string) =>
      commitExecAuthorization({
        agentId: "researcher",
        matches: [],
        command,
        authorization: {
          source: "explicit-approval",
          security: "allowlist",
          ask: "always",
          allowlistSatisfied: false,
          policySnapshot,
        },
        allowAlwaysDecision: {
          kind: "patterns",
          patterns: [{ pattern }],
        },
      });

    await Promise.all([
      commitGrant("grep --version", "/usr/bin/grep"),
      commitGrant("cat --version", "/usr/bin/cat"),
    ]);

    const allowlist = allowlistEntries(dir, "researcher");
    const patterns = allowlist.flatMap((entry) =>
      typeof entry.pattern === "string" ? [entry.pattern] : [],
    );
    expect(patterns).toHaveLength(allowlist.length);
    expect(patterns.toSorted((left, right) => left.localeCompare(right))).toEqual([
      "/usr/bin/cat",
      "/usr/bin/grep",
    ]);
    expect(allowlist.every((entry) => entry.source === "allow-always")).toBe(true);
  });

  it("rejects a persistent explicit allow-always grant without a policy snapshot", async () => {
    const dir = createHomeDir();
    saveExecApprovals({
      version: 1,
      defaults: { security: "allowlist", ask: "always" },
      agents: { main: { allowlist: [] } },
    });

    await expect(
      commitExecAuthorization({
        agentId: "main",
        matches: [],
        command: "printf approved",
        authorization: {
          source: "explicit-approval",
          security: "allowlist",
          ask: "always",
          allowlistSatisfied: false,
        },
        allowAlwaysDecision: {
          kind: "exact-command",
          commandText: "printf approved",
        },
      }),
    ).rejects.toThrow("Allow-always persistence requires a policy snapshot");
    expect(allowlistEntries(dir, "main")).toEqual([]);
  });

  it("does not let current policy create an allow-always grant", async () => {
    const dir = createHomeDir();
    saveExecApprovals({
      version: 1,
      defaults: { security: "full", ask: "off" },
      agents: { main: { allowlist: [] } },
    });

    await expect(
      commitExecAuthorization({
        agentId: "main",
        matches: [],
        command: "printf full",
        authorization: {
          source: "current-policy",
          security: "full",
          ask: "off",
          allowlistSatisfied: false,
        },
        allowAlwaysDecision: {
          kind: "exact-command",
          commandText: "printf full",
        },
      }),
    ).rejects.toThrow("Allow-always persistence requires explicit approval");
    expect(allowlistEntries(dir, "main")).toEqual([]);
  });

  it("rejects unprompted full execution after policy changes to deny", async () => {
    const dir = createHomeDir();
    saveExecApprovals({
      version: 1,
      defaults: { security: "deny", ask: "off" },
      agents: { main: {} },
    });

    await expect(
      commitExecAuthorization({
        agentId: "main",
        matches: [],
        command: "printf full",
        authorization: {
          source: "current-policy",
          security: "full",
          ask: "off",
          allowlistSatisfied: false,
        },
      }),
    ).rejects.toThrow("Exec approval changed before execution");
    expect(readApprovalsFile(dir).defaults?.security).toBe("deny");
  });

  it("rejects unprompted full execution after ask tightens to on-miss", async () => {
    createHomeDir();
    saveExecApprovals({
      version: 1,
      defaults: { security: "full", ask: "on-miss" },
      agents: { main: {} },
    });

    await expect(
      commitExecAuthorization({
        agentId: "main",
        matches: [],
        command: "printf full",
        authorization: {
          source: "current-policy",
          security: "full",
          ask: "off",
          allowlistSatisfied: false,
        },
      }),
    ).rejects.toThrow("Exec approval changed before execution");
  });

  it("rejects auto-review when current policy changes to always ask", async () => {
    createHomeDir();
    saveExecApprovals({
      version: 1,
      defaults: { security: "full", ask: "always" },
      agents: { main: {} },
    });

    await expect(
      commitExecAuthorization({
        agentId: "main",
        matches: [],
        command: "printf reviewed",
        authorization: {
          source: "auto-review",
          security: "full",
          ask: "on-miss",
          allowlistSatisfied: false,
        },
      }),
    ).rejects.toThrow("Exec approval changed before execution");
  });

  it("rejects a durable grant after its source is downgraded", async () => {
    const dir = createHomeDir();
    saveExecApprovals({
      version: 1,
      defaults: { security: "allowlist", ask: "off" },
      agents: {
        main: { allowlist: [{ pattern: "/usr/bin/rg" }] },
      },
    });

    await expect(
      commitExecAuthorization({
        agentId: "main",
        matches: [{ pattern: "/usr/bin/rg", source: "allow-always" }],
        command: "rg needle",
        authorization: {
          source: "current-policy",
          security: "allowlist",
          ask: "off",
          allowlistSatisfied: true,
          requireDurableAllowlistApproval: true,
        },
      }),
    ).rejects.toThrow("Exec approval changed before execution");
    expect(allowlistEntries(dir, "main")).toEqual([{ pattern: "/usr/bin/rg" }]);
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

  it("persists node command markers only for fully represented allow-always patterns", () => {
    const dir = createHomeDir();
    vi.spyOn(Date, "now").mockReturnValue(654_322);

    const approvals = ensureExecApprovals();
    const completePatterns = persistAllowAlwaysPatterns({
      approvals,
      agentId: "worker",
      commandText: "/usr/bin/tool ok",
      segments: [
        {
          raw: "/usr/bin/tool ok",
          argv: ["/usr/bin/tool", "ok"],
          resolution: {
            execution: {
              rawExecutable: "/usr/bin/tool",
              resolvedPath: "/usr/bin/tool",
              executableName: "tool",
            },
            policy: {
              rawExecutable: "/usr/bin/tool",
              resolvedPath: "/usr/bin/tool",
              executableName: "tool",
            },
          },
        },
      ],
    });

    expect(completePatterns).toEqual([{ pattern: "/usr/bin/tool" }]);
    let allowlist = allowlistEntries(dir, "worker");
    expect(allowlist.map((entry) => entry.pattern)).toEqual([
      "/usr/bin/tool",
      expect.stringMatching(/^=node-command:[0-9a-f]{16}$/),
    ]);
    expect(allowlist.some((entry) => entry.lastUsedCommand === "/usr/bin/tool ok")).toBe(false);

    const partialPatterns = persistAllowAlwaysPatterns({
      approvals,
      agentId: "worker",
      commandText: "sh -c '/bin/echo ok && missingcmd'",
      segments: [
        {
          raw: "sh -c '/bin/echo ok && missingcmd'",
          argv: ["sh", "-c", "/bin/echo ok && missingcmd"],
          resolution: {
            execution: {
              rawExecutable: "sh",
              resolvedPath: "/bin/sh",
              executableName: "sh",
            },
            policy: {
              rawExecutable: "sh",
              resolvedPath: "/bin/sh",
              executableName: "sh",
            },
          },
        },
      ],
    });

    expect(partialPatterns).toEqual([]);
    allowlist = allowlistEntries(dir, "worker");
    expect(
      allowlist.some(
        (entry) =>
          typeof entry.pattern === "string" &&
          entry.pattern.startsWith("=node-command:") &&
          entry.lastUsedCommand === "sh -c '/bin/echo ok && missingcmd'",
      ),
    ).toBe(false);
    expect(
      allowlist.filter(
        (entry) => typeof entry.pattern === "string" && entry.pattern.startsWith("=node-command:"),
      ),
    ).toHaveLength(1);
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
