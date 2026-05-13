import fs from "node:fs";
import { promises as fsPromises } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import {
  appendConfigAuditRecord,
  createConfigWriteAuditRecordBase,
  finalizeConfigWriteAuditRecord,
  formatConfigOverwriteLogMessage,
  redactConfigAuditArgv,
  resolveConfigAuditLogPath,
  scrubConfigAuditLog,
} from "./io.audit.js";

function createAuditRecordBase(configPath: string) {
  return createConfigWriteAuditRecordBase({
    configPath,
    env: {} as NodeJS.ProcessEnv,
    existsBefore: true,
    previousHash: "prev-hash",
    nextHash: "next-hash",
    previousBytes: 12,
    nextBytes: 24,
    previousMetadata: {
      dev: "10",
      ino: "11",
      mode: 0o600,
      nlink: 1,
      uid: 501,
      gid: 20,
    },
    changedPathCount: 1,
    hasMetaBefore: true,
    hasMetaAfter: true,
    gatewayModeBefore: "local",
    gatewayModeAfter: "local",
    suspicious: [],
    now: "2026-04-07T08:00:00.000Z",
  });
}

function createRenameAuditRecord(home: string) {
  return finalizeConfigWriteAuditRecord({
    base: createAuditRecordBase(path.join(home, ".openclaw", "openclaw.json")),
    result: "rename",
    nextMetadata: {
      dev: "12",
      ino: "13",
      mode: 0o600,
      nlink: 1,
      uid: 501,
      gid: 20,
    },
  });
}

function readAuditLog(home: string): unknown[] {
  const auditPath = path.join(home, ".openclaw", "logs", "config-audit.jsonl");
  return fs
    .readFileSync(auditPath, "utf-8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

function requireAuditRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected audit JSONL record");
  }
  return value as Record<string, unknown>;
}

describe("config io audit helpers", () => {
  const suiteRootTracker = createSuiteTempRootTracker({ prefix: "openclaw-config-audit-" });

  beforeAll(async () => {
    await suiteRootTracker.setup();
  });

  afterAll(async () => {
    await suiteRootTracker.cleanup();
  });

  it('ignores literal "undefined" home env values when choosing the audit log path', async () => {
    const home = await suiteRootTracker.make("home");
    const auditPath = resolveConfigAuditLogPath(
      {
        HOME: "undefined",
        USERPROFILE: "null",
        OPENCLAW_HOME: "undefined",
      } as NodeJS.ProcessEnv,
      () => home,
    );
    expect(auditPath).toBe(path.join(home, ".openclaw", "logs", "config-audit.jsonl"));
    expect(auditPath.startsWith(path.resolve("undefined"))).toBe(false);
  });

  it("formats overwrite warnings with hash transition and backup path", () => {
    expect(
      formatConfigOverwriteLogMessage({
        configPath: "/tmp/openclaw.json",
        previousHash: "prev-hash",
        nextHash: "next-hash",
        changedPathCount: 3,
      }),
    ).toBe(
      "Config overwrite: /tmp/openclaw.json (sha256 prev-hash -> next-hash, backup=/tmp/openclaw.json.bak, changedPaths=3)",
    );
  });

  it("captures watch markers and next stat metadata for successful writes", () => {
    const base = createConfigWriteAuditRecordBase({
      configPath: "/tmp/openclaw.json",
      env: {
        OPENCLAW_WATCH_MODE: "1",
        OPENCLAW_WATCH_SESSION: "watch-session-1",
        OPENCLAW_WATCH_COMMAND: "gateway --force",
      } as NodeJS.ProcessEnv,
      existsBefore: true,
      previousHash: "prev-hash",
      nextHash: "next-hash",
      previousBytes: 12,
      nextBytes: 24,
      previousMetadata: {
        dev: "10",
        ino: "11",
        mode: 0o600,
        nlink: 1,
        uid: 501,
        gid: 20,
      },
      changedPathCount: 2,
      hasMetaBefore: false,
      hasMetaAfter: true,
      gatewayModeBefore: null,
      gatewayModeAfter: "local",
      suspicious: ["missing-meta-before-write"],
      now: "2026-04-07T08:00:00.000Z",
      processInfo: {
        pid: 101,
        ppid: 99,
        cwd: "/work",
        argv: ["node", "openclaw"],
        execArgv: ["--loader"],
      },
    });
    const record = finalizeConfigWriteAuditRecord({
      base,
      result: "rename",
      nextMetadata: {
        dev: "12",
        ino: "13",
        mode: 0o600,
        nlink: 1,
        uid: 501,
        gid: 20,
      },
    });

    expect(record.watchMode).toBe(true);
    expect(record.watchSession).toBe("watch-session-1");
    expect(record.watchCommand).toBe("gateway --force");
    expect(record.nextHash).toBe("next-hash");
    expect(record.nextBytes).toBe(24);
    expect(record.nextDev).toBe("12");
    expect(record.nextIno).toBe("13");
    expect(record.result).toBe("rename");
  });

  it("drops next-file metadata and preserves error details for failed writes", () => {
    const base = createAuditRecordBase("/tmp/openclaw.json");
    const err = Object.assign(new Error("disk full"), { code: "ENOSPC" });
    const record = finalizeConfigWriteAuditRecord({
      base,
      result: "failed",
      err,
    });

    expect(record.result).toBe("failed");
    expect(record.nextHash).toBeNull();
    expect(record.nextBytes).toBeNull();
    expect(record.nextDev).toBeNull();
    expect(record.errorCode).toBe("ENOSPC");
    expect(record.errorMessage).toBe("disk full");
  });

  it("appends JSONL audit entries to the resolved audit path", async () => {
    const home = await suiteRootTracker.make("append");
    const record = createRenameAuditRecord(home);

    await appendConfigAuditRecord({
      fs,
      env: {} as NodeJS.ProcessEnv,
      homedir: () => home,
      record,
    });

    const records = readAuditLog(home);
    expect(records).toHaveLength(1);
    const written = requireAuditRecord(records[0]);
    expect(written.event).toBe("config.write");
    expect(written.result).toBe("rename");
    expect(written.nextHash).toBe("next-hash");
  });

  it("redacts structured audit records before persistence", async () => {
    const home = await suiteRootTracker.make("append-redacted");
    const record = finalizeConfigWriteAuditRecord({
      base: {
        ...createAuditRecordBase(path.join(home, ".openclaw", "openclaw.json")),
        suspicious: [
          "provider returned ya29.fake-access-token-with-enough-length",
          "plugin returned AIzaSyD-very-real-looking-google-api-key-123",
        ],
      },
      result: "failed",
      err: Object.assign(new Error("payload contained abcd-efgh-ijkl-mnop"), { code: "EFAIL" }),
    });

    await appendConfigAuditRecord({
      fs,
      env: {} as NodeJS.ProcessEnv,
      homedir: () => home,
      record,
    });

    const raw = fs.readFileSync(
      path.join(home, ".openclaw", "logs", "config-audit.jsonl"),
      "utf-8",
    );
    expect(raw).not.toContain("AIzaSyD-very-real-looking");
    expect(raw).not.toContain("ya29.fake-access-token");
    expect(raw).not.toContain("abcd-efgh-ijkl-mnop");
  });

  it("redacts argv values that follow known secret flag names", () => {
    const argv = [
      "node",
      "openclaw",
      "gateway",
      "--token",
      "super-secret-gateway-token-12345",
      "--api-key",
      "sk-very-real-looking-openai-api-key-AB12CD34",
      "--port",
      "8080",
    ];
    const result = redactConfigAuditArgv(argv);
    expect(result).toEqual([
      "node",
      "openclaw",
      "gateway",
      "--token",
      "***",
      "--api-key",
      "***",
      "--port",
      "8080",
    ]);
  });

  it("redacts the value half of `--flag=value` for secret flags", () => {
    const argv = ["openclaw", "--token=ghp_realgithubtoken1234567890ABCD", "--port=8080"];
    expect(redactConfigAuditArgv(argv)).toEqual(["openclaw", "--token=***", "--port=8080"]);
  });

  it("redacts standalone token shapes via the shared logging redaction patterns", () => {
    const argv = [
      "node",
      "openclaw",
      "ghp_realgithubtoken1234567890ABCD",
      "AIzaSyD-very-real-looking-google-api-key-123",
      "987654321:AAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    ];
    const result = redactConfigAuditArgv(argv);
    expect(result[0]).toBe("node");
    expect(result[1]).toBe("openclaw");
    for (const masked of result.slice(2)) {
      expect(masked).not.toContain("ghp_realgithubtoken");
      expect(masked).not.toContain("AIzaSyD-very-real-looking");
      expect(masked).not.toMatch(/AAAAAAAAAAAAAA/);
    }
  });

  it("leaves non-secret arguments untouched", () => {
    const argv = ["node", "openclaw", "gateway", "--port", "8080", "--bind", "lan"];
    expect(redactConfigAuditArgv(argv)).toEqual(argv);
  });

  it("redacts unknown but credential-suffixed flags via the heuristic classifier", () => {
    const argv = [
      "node",
      "openclaw",
      "--custom-api-key",
      "real-tenant-key-AB12CD34EF56GH78",
      "--alibaba-model-studio-api-key=plain-value-xyz-12345",
      "--app-token",
      "another-secret-value",
      "--frobnicate-credential=hidden",
    ];
    const result = redactConfigAuditArgv(argv);
    expect(result).toEqual([
      "node",
      "openclaw",
      "--custom-api-key",
      "***",
      "--alibaba-model-studio-api-key=***",
      "--app-token",
      "***",
      "--frobnicate-credential=***",
    ]);
  });

  it("redacts key-valued secret flags (Nostr --private-key, Matrix --recovery-key)", () => {
    const argv = [
      "node",
      "openclaw",
      "channels",
      "add",
      "--channel",
      "nostr",
      "--private-key",
      "nsec1realnostrprivatekeyvaluexyz1234567890",
      "--recovery-key=EsTb-ABCD-1234-EFGH-5678-IJKL-9012-MNOP",
    ];
    const result = redactConfigAuditArgv(argv);
    expect(result).toEqual([
      "node",
      "openclaw",
      "channels",
      "add",
      "--channel",
      "nostr",
      "--private-key",
      "***",
      "--recovery-key=***",
    ]);
  });

  it("redacts unknown *-key flags via the heuristic classifier (private/signing/master/etc.)", () => {
    const argv = [
      "node",
      "openclaw",
      "--my-plugin-private-key",
      "tenant-private-key-material-zzz",
      "--rotated-signing-key=PEM-LIKE-MATERIAL",
      "--ops-master-key",
      "ABCDEF1234567890",
    ];
    const result = redactConfigAuditArgv(argv);
    expect(result).toEqual([
      "node",
      "openclaw",
      "--my-plugin-private-key",
      "***",
      "--rotated-signing-key=***",
      "--ops-master-key",
      "***",
    ]);
  });

  it("masks the next arg after a secret flag even when it looks like another option", () => {
    const argv = ["openclaw", "--token", "--port", "8080"];
    expect(redactConfigAuditArgv(argv)).toEqual(["openclaw", "--token", "***", "8080"]);
  });

  it("redacts dash-leading secret values after bare secret flags", () => {
    const argv = ["openclaw", "--password", "-secret-value"];
    expect(redactConfigAuditArgv(argv)).toEqual(["openclaw", "--password", "***"]);
  });

  it("does not mask when a secret flag is the final arg with no value", () => {
    const argv = ["openclaw", "--token"];
    expect(redactConfigAuditArgv(argv)).toEqual(["openclaw", "--token"]);
  });

  it("caps caller-supplied processInfo argv at 8 entries before redaction", () => {
    const longArgv = [
      "node",
      "openclaw",
      "--api-key",
      "secret",
      "--port",
      "8080",
      "--bind",
      "lan",
      "--leaks-here-token",
      "this-must-not-land-in-audit-1234567890",
    ];
    const base = createConfigWriteAuditRecordBase({
      configPath: "/tmp/openclaw.json",
      env: {} as NodeJS.ProcessEnv,
      existsBefore: true,
      previousHash: "prev",
      nextHash: "next",
      previousBytes: 1,
      nextBytes: 2,
      previousMetadata: {
        dev: null,
        ino: null,
        mode: null,
        nlink: null,
        uid: null,
        gid: null,
      },
      changedPathCount: 0,
      hasMetaBefore: true,
      hasMetaAfter: true,
      gatewayModeBefore: "local",
      gatewayModeAfter: "local",
      suspicious: [],
      now: "2026-04-30T00:00:00.000Z",
      processInfo: {
        pid: 1,
        ppid: 1,
        cwd: "/work",
        argv: longArgv,
        execArgv: [],
      },
    });
    expect(base.argv).toHaveLength(8);
    expect(base.argv).not.toContain("this-must-not-land-in-audit-1234567890");
    expect(base.argv).not.toContain("--leaks-here-token");
  });

  it("redacts processInfo.argv when explicitly supplied to createConfigWriteAuditRecordBase", () => {
    const base = createConfigWriteAuditRecordBase({
      configPath: "/tmp/openclaw.json",
      env: {} as NodeJS.ProcessEnv,
      existsBefore: true,
      previousHash: "prev",
      nextHash: "next",
      previousBytes: 1,
      nextBytes: 2,
      previousMetadata: {
        dev: null,
        ino: null,
        mode: null,
        nlink: null,
        uid: null,
        gid: null,
      },
      changedPathCount: 0,
      hasMetaBefore: true,
      hasMetaAfter: true,
      gatewayModeBefore: "local",
      gatewayModeAfter: "local",
      suspicious: [],
      now: "2026-04-30T00:00:00.000Z",
      processInfo: {
        pid: 1,
        ppid: 1,
        cwd: "/work",
        argv: ["node", "openclaw", "--token", "leaked-but-not-anymore-12345"],
        execArgv: [],
      },
    });
    expect(base.argv).toEqual(["node", "openclaw", "--token", "***"]);
  });

  it("also accepts flattened audit record params from legacy call sites", async () => {
    const home = await suiteRootTracker.make("append-flat");
    const record = createRenameAuditRecord(home);

    await appendConfigAuditRecord({
      fs,
      env: {} as NodeJS.ProcessEnv,
      homedir: () => home,
      ...record,
    });

    const records = readAuditLog(home);
    expect(records).toHaveLength(1);
    const written = requireAuditRecord(records[0]);
    expect(written.event).toBe("config.write");
    expect(written.result).toBe("rename");
    expect(written.nextHash).toBe("next-hash");
  });

  it("rewrites historical config-audit entries through redactConfigAuditArgv and preserves 0600 mode", async () => {
    const home = await suiteRootTracker.make("scrub-historical");
    const auditPath = path.join(home, ".openclaw", "logs", "config-audit.jsonl");
    fs.mkdirSync(path.dirname(auditPath), { recursive: true, mode: 0o700 });
    const unredactedRecord = {
      ts: "2026-05-02T00:03:48.471Z",
      source: "config-io",
      event: "config.write",
      configPath: path.join(home, ".openclaw", "openclaw.json"),
      pid: 1590563,
      ppid: 1590548,
      cwd: home,
      argv: [
        "/usr/bin/node",
        "/usr/local/bin/openclaw.mjs",
        "config",
        "set",
        "channels.slack.botToken",
        "xoxb-real-bot-token-1234567890abcdef0123456789abcdef",
      ],
      execArgv: ["--disable-warning=ExperimentalWarning"],
      suspicious: [],
      result: "rename",
    };
    const alreadyRedactedRecord = {
      ts: "2026-05-08T12:00:00.000Z",
      source: "config-io",
      event: "config.write",
      configPath: path.join(home, ".openclaw", "openclaw.json"),
      pid: 1,
      ppid: 1,
      cwd: home,
      argv: ["/usr/bin/node", "/usr/local/bin/openclaw.mjs", "config", "set", "ui.theme", "dark"],
      execArgv: ["--disable-warning=ExperimentalWarning"],
      suspicious: [],
      result: "rename",
    };
    fs.writeFileSync(
      auditPath,
      `${JSON.stringify(unredactedRecord)}\n${JSON.stringify(alreadyRedactedRecord)}\n`,
      { encoding: "utf-8", mode: 0o600 },
    );

    const env = {} as NodeJS.ProcessEnv;
    const result = await scrubConfigAuditLog({
      fs: { promises: fsPromises },
      env,
      homedir: () => home,
    });

    expect(result).toEqual({ scanned: 2, rewritten: 1, skipped: 0, aborted: false });
    const after = readAuditLog(home);
    expect(after).toHaveLength(2);
    const firstAfter = requireAuditRecord(after[0]);
    const secondAfter = requireAuditRecord(after[1]);
    const firstArgv = firstAfter.argv as string[];
    expect(firstArgv).toHaveLength(unredactedRecord.argv.length);
    expect(firstArgv.slice(0, 5)).toEqual(unredactedRecord.argv.slice(0, 5));
    expect(firstArgv[5]).not.toContain("real-bot-token");
    expect(JSON.stringify(firstAfter)).not.toContain("xoxb-real-bot-token");
    expect(firstAfter.ts).toBe(unredactedRecord.ts);
    expect(firstAfter.suspicious).toEqual([]);
    expect(secondAfter.argv).toEqual(alreadyRedactedRecord.argv);

    const stat = fs.statSync(auditPath);
    expect(stat.mode & 0o777).toBe(0o600);

    const second = await scrubConfigAuditLog({
      fs: { promises: fsPromises },
      env,
      homedir: () => home,
    });
    expect(second).toEqual({ scanned: 2, rewritten: 0, skipped: 0, aborted: false });
  });

  it("returns zero counts and does not create the audit file when none exists", async () => {
    const home = await suiteRootTracker.make("scrub-missing");
    const result = await scrubConfigAuditLog({
      fs: { promises: fsPromises },
      env: {} as NodeJS.ProcessEnv,
      homedir: () => home,
    });
    expect(result).toEqual({ scanned: 0, rewritten: 0, skipped: 0, aborted: false });
    const auditPath = path.join(home, ".openclaw", "logs", "config-audit.jsonl");
    expect(fs.existsSync(auditPath)).toBe(false);
  });

  it("preserves malformed lines verbatim and counts them as skipped", async () => {
    const home = await suiteRootTracker.make("scrub-malformed");
    const auditPath = path.join(home, ".openclaw", "logs", "config-audit.jsonl");
    fs.mkdirSync(path.dirname(auditPath), { recursive: true, mode: 0o700 });
    const malformed = "{this is not valid json";
    const validUnredacted = {
      ts: "2026-05-02T00:03:48.471Z",
      argv: ["node", "openclaw.mjs", "config", "set", "x", "xoxb-bad-token-1234567890abcdef"],
    };
    fs.writeFileSync(auditPath, `${malformed}\n${JSON.stringify(validUnredacted)}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });

    const result = await scrubConfigAuditLog({
      fs: { promises: fsPromises },
      env: {} as NodeJS.ProcessEnv,
      homedir: () => home,
    });

    expect(result).toEqual({ scanned: 2, rewritten: 1, skipped: 1, aborted: false });
    const text = fs.readFileSync(auditPath, "utf-8");
    expect(text.split("\n")[0]).toBe(malformed);
    expect(text).not.toContain("xoxb-bad-token");
  });

  it("does not write when dryRun is true even if records would change", async () => {
    const home = await suiteRootTracker.make("scrub-dryrun");
    const auditPath = path.join(home, ".openclaw", "logs", "config-audit.jsonl");
    fs.mkdirSync(path.dirname(auditPath), { recursive: true, mode: 0o700 });
    const unredacted = {
      ts: "2026-05-02T00:03:48.471Z",
      argv: [
        "node",
        "openclaw.mjs",
        "config",
        "set",
        "channels.slack.appToken",
        "xapp-1-A1B2C3-1234567890-abcdef0123456789abcdef0123456789",
      ],
      execArgv: [],
    };
    const original = `${JSON.stringify(unredacted)}\n`;
    fs.writeFileSync(auditPath, original, { encoding: "utf-8", mode: 0o600 });

    const result = await scrubConfigAuditLog({
      fs: { promises: fsPromises },
      env: {} as NodeJS.ProcessEnv,
      homedir: () => home,
      dryRun: true,
    });

    expect(result).toEqual({ scanned: 1, rewritten: 1, skipped: 0, aborted: false });
    const text = fs.readFileSync(auditPath, "utf-8");
    expect(text).toBe(original);
    expect(text).toContain("xapp-1-A1B2C3");
  });

  it("aborts without overwriting when the audit log was appended to mid-scrub", async () => {
    const home = await suiteRootTracker.make("scrub-race-abort");
    const auditPath = path.join(home, ".openclaw", "logs", "config-audit.jsonl");
    fs.mkdirSync(path.dirname(auditPath), { recursive: true, mode: 0o700 });
    const unredacted = {
      ts: "2026-05-02T00:03:48.471Z",
      argv: [
        "node",
        "openclaw.mjs",
        "config",
        "set",
        "channels.slack.botToken",
        "xoxb-real-bot-token-1234567890abcdef0123456789abcdef",
      ],
      execArgv: [],
    };
    const original = `${JSON.stringify(unredacted)}\n`;
    fs.writeFileSync(auditPath, original, { encoding: "utf-8", mode: 0o600 });

    // Mock fs whose .stat() reports a larger size than what readFile returns,
    // simulating an appendConfigAuditRecord call that fired after the initial
    // read but before the rename. The scrub should refuse to rename and leave
    // the file untouched.
    const raceFs = {
      promises: {
        readFile: fsPromises.readFile,
        stat: async (p: string) => {
          const realStat = await fsPromises.stat(p);
          return { size: realStat.size + 200 };
        },
        writeFile: fsPromises.writeFile,
        rename: fsPromises.rename,
        unlink: fsPromises.unlink,
      },
    };
    const result = await scrubConfigAuditLog({
      fs: raceFs,
      env: {} as NodeJS.ProcessEnv,
      homedir: () => home,
    });

    expect(result.aborted).toBe(true);
    expect(result.rewritten).toBeGreaterThan(0);
    const after = fs.readFileSync(auditPath, "utf-8");
    expect(after).toBe(original);
    expect(after).toContain("xoxb-real-bot-token");
    expect(fs.existsSync(`${auditPath}.scrub.tmp`)).toBe(false);
  });

  it("aborts without overwriting when the audit log is appended to after temp write", async () => {
    const home = await suiteRootTracker.make("scrub-race-after-temp-write");
    const auditPath = path.join(home, ".openclaw", "logs", "config-audit.jsonl");
    fs.mkdirSync(path.dirname(auditPath), { recursive: true, mode: 0o700 });
    const unredacted = {
      ts: "2026-05-02T00:03:48.471Z",
      argv: [
        "node",
        "openclaw.mjs",
        "config",
        "set",
        "channels.slack.botToken",
        "xoxb-real-bot-token-1234567890abcdef0123456789abcdef",
      ],
      execArgv: [],
    };
    const appended = {
      ts: "2026-05-02T00:04:00.000Z",
      argv: ["node", "openclaw.mjs", "config", "set", "theme", "dark"],
      execArgv: [],
    };
    const original = `${JSON.stringify(unredacted)}\n`;
    const appendedLine = `${JSON.stringify(appended)}\n`;
    fs.writeFileSync(auditPath, original, { encoding: "utf-8", mode: 0o600 });
    let renameCalled = false;

    const raceFs = {
      promises: {
        readFile: fsPromises.readFile,
        stat: fsPromises.stat,
        writeFile: async (
          p: string,
          data: string,
          options?: { encoding?: BufferEncoding; mode?: number },
        ) => {
          await fsPromises.writeFile(p, data, options);
          await fsPromises.appendFile(auditPath, appendedLine, "utf-8");
        },
        rename: async () => {
          renameCalled = true;
        },
        unlink: fsPromises.unlink,
      },
    };
    const result = await scrubConfigAuditLog({
      fs: raceFs,
      env: {} as NodeJS.ProcessEnv,
      homedir: () => home,
    });

    expect(result.aborted).toBe(true);
    expect(result.rewritten).toBeGreaterThan(0);
    expect(renameCalled).toBe(false);
    const after = fs.readFileSync(auditPath, "utf-8");
    expect(after).toBe(`${original}${appendedLine}`);
    expect(after).toContain("xoxb-real-bot-token");
    expect(fs.existsSync(`${auditPath}.scrub.tmp`)).toBe(false);
  });
});
