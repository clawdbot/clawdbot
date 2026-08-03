import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { vi } from "vitest";
import { listConfigAuditRecordsForTests } from "../config/io.audit.test-support.js";
import { listSystemAgentAuditEntriesForTests } from "../system-agent/audit.test-support.js";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { detectLegacyAuditLogs, migrateLegacyAuditLogs } from "./state-migrations.audit-logs.js";

const AUDIT_SCRUB_PATTERN = Buffer.from(" \t".repeat(16));

type SystemAuditEvent = {
  timestamp: string;
  operation: string;
  summary: string;
};

type ConfigAuditRecord = {
  ts: string;
  source: string;
  event: string;
  argv: string[];
  execArgv: string[];
};

function auditPaths(stateDir: string, relativePath: string) {
  const source = path.join(stateDir, relativePath);
  const raw = `${source}.migrated.raw`;
  return {
    source,
    sanitized: `${source}.migrated`,
    raw,
    restore: `${raw}.doctor-scrub-restore`,
    claim: path.join(path.dirname(source), `.${path.basename(source)}.doctor-importing`),
  };
}

export function systemAuditEvent(
  summary: string,
  overrides: Partial<SystemAuditEvent> = {},
): SystemAuditEvent {
  return {
    timestamp: "2026-07-03T00:00:00.000Z",
    operation: "gateway.restart",
    summary,
    ...overrides,
  };
}

export function configAuditRecord(
  marker: string,
  overrides: Partial<ConfigAuditRecord> = {},
): ConfigAuditRecord {
  return {
    ts: "2026-07-01T00:00:00.000Z",
    source: "config-io",
    event: "config.write",
    argv: ["openclaw", "config", "set", "token", marker],
    execArgv: [],
    ...overrides,
  };
}

export class AuditMigrationFixture {
  readonly env: NodeJS.ProcessEnv;
  readonly config;
  readonly system;

  constructor(readonly stateDir: string) {
    this.env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    this.config = auditPaths(stateDir, path.join("logs", "config-audit.jsonl"));
    this.system = auditPaths(stateDir, path.join("audit", "system-agent.jsonl"));
  }

  detect(doctorOnlyStateMigrations = true) {
    return detectLegacyAuditLogs({
      stateDir: this.stateDir,
      doctorOnlyStateMigrations,
    });
  }

  migrate(detected = this.detect()) {
    return migrateLegacyAuditLogs({ detected, stateDir: this.stateDir });
  }

  async write(target: string, content: string | Uint8Array): Promise<void> {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }

  writeJsonLines(target: string, records: unknown[]): Promise<void> {
    return this.write(target, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  }

  appendJsonLines(target: string, records: unknown[]): Promise<void> {
    return fs.appendFile(target, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  }

  async readJsonLines<T>(target: string): Promise<T[]> {
    return (await fs.readFile(target, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as T);
  }

  async seedRawArchive(paths: { raw: string; sanitized: string }, raw: string | Uint8Array) {
    await this.write(paths.sanitized, "{}\n");
    await this.write(paths.raw, raw);
  }

  systemEntries = () => listSystemAgentAuditEntriesForTests({ env: this.env });
  configRecords = () =>
    listConfigAuditRecordsForTests({ env: this.env, homedir: () => this.stateDir });
  systemSummaries = () => this.systemEntries().map((entry) => entry.value.summary);
  systemOperations = () =>
    this.systemEntries()
      .map((entry) => entry.value.operation)
      .toSorted();
}

export const withAuditMigrationFixture = (
  run: (fixture: AuditMigrationFixture) => Promise<void>,
): Promise<void> =>
  withTempDir({ prefix: "openclaw-audit-migration-" }, (stateDir) =>
    run(new AuditMigrationFixture(stateDir)),
  );

export function buildAuditScrubbedContent(length: number): Buffer {
  return Buffer.from(" \t".repeat(Math.ceil(length / 2))).subarray(0, length);
}

export const FIRST_AUDIT_SCRUB_BYTE = AUDIT_SCRUB_PATTERN[0]!;

export async function writeAuditRestoreJournal(
  rawPath: string,
  sourceRaw: Buffer,
  progress: { restoredBytes: number; scrubbedBytes: number } = {
    restoredBytes: 0,
    scrubbedBytes: 0,
  },
): Promise<void> {
  const stat = await fs.stat(rawPath);
  const journal = `${JSON.stringify({
    schemaVersion: 6,
    rawBase64: sourceRaw.toString("base64"),
    scrubPatternBase64: AUDIT_SCRUB_PATTERN.toString("base64"),
    target: { dev: stat.dev, ino: stat.ino, size: sourceRaw.length },
  })}\n`;
  await fs.writeFile(
    `${rawPath}.doctor-scrub-progress`,
    `${JSON.stringify({
      schemaVersion: 1,
      journalHash: createHash("sha256").update(journal).digest("hex"),
      direction: progress.restoredBytes > 0 ? "restoring" : "scrubbing",
      committedBytes: progress.restoredBytes || progress.scrubbedBytes,
      pendingEnd: progress.restoredBytes || progress.scrubbedBytes,
      extentBytes: progress.restoredBytes > 0 ? progress.scrubbedBytes : sourceRaw.length,
    })}\n`,
  );
  await fs.writeFile(`${rawPath}.doctor-scrub-restore`, journal);
}

async function fileHandlePrototype<T>(
  fixture: AuditMigrationFixture,
  probeName: string,
): Promise<T> {
  const probe = await fs.open(path.join(fixture.stateDir, probeName), "w+");
  const prototype = Object.getPrototypeOf(probe) as T;
  await probe.close();
  return prototype;
}

export async function failChmodCall(
  fixture: AuditMigrationFixture,
  probeName: string,
  callNumber: number,
  message: string,
) {
  const prototype = await fileHandlePrototype<{ chmod(mode: number): Promise<void> }>(
    fixture,
    probeName,
  );
  const original = Reflect.get(prototype, "chmod") as typeof prototype.chmod;
  let calls = 0;
  return vi.spyOn(prototype, "chmod").mockImplementation(function (
    this: typeof prototype,
    mode: number,
  ) {
    calls += 1;
    if (calls === callNumber) {
      return Promise.reject(new Error(message));
    }
    return original.call(this, mode);
  });
}

export async function failSecondScrubWrite(fixture: AuditMigrationFixture) {
  const prototype = await fileHandlePrototype<{
    write(
      buffer: Uint8Array,
      offset: number,
      length: number,
      position: number | null,
    ): Promise<{ bytesWritten: number; buffer: Uint8Array }>;
  }>(fixture, "write-probe");
  const original = Reflect.get(prototype, "write") as typeof prototype.write;
  let calls = 0;
  return vi.spyOn(prototype, "write").mockImplementation(async function (
    this: typeof prototype,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number | null,
  ) {
    calls += 1;
    if (calls === 1) {
      return await original.call(
        this,
        buffer,
        offset,
        Math.max(1, Math.floor(length / 2)),
        position,
      );
    }
    if (calls === 2) {
      throw new Error("simulated scrub write failure");
    }
    return await original.call(this, buffer, offset, length, position);
  });
}
