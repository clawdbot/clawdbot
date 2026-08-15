import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  configAuditScrubToHealthFinding,
  configAuditScrubToRepairEffect,
  detectConfigAuditScrubIssue,
} from "./doctor-config-audit-scrub.js";

let tempRoot: string | null = null;

async function makeHome(): Promise<string> {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-doctor-config-audit-"));
  return tempRoot;
}

afterEach(async () => {
  if (tempRoot !== null) {
    await fs.rm(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  }
});

describe("detectConfigAuditScrubIssue", () => {
  it("detects config-audit scrub work without rewriting the log", async () => {
    const home = await makeHome();
    const auditPath = path.join(home, ".openclaw", "logs", "config-audit.jsonl");
    await fs.mkdir(path.dirname(auditPath), { recursive: true, mode: 0o700 });
    const record = {
      ts: "2026-05-02T00:03:48.471Z",
      argv: ["node", "openclaw.mjs", "config", "set", "x", "xoxb-bad-token-1234567890abcdef"],
      execArgv: [],
    };
    await fs.writeFile(auditPath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });

    const result = await detectConfigAuditScrubIssue({
      env: {} as NodeJS.ProcessEnv,
      homedir: () => home,
    });

    expect(result).toEqual({
      scanned: 1,
      rewritten: 1,
      skipped: 0,
      aborted: false,
      auditPath,
    });
    expect(await fs.readFile(auditPath, "utf8")).toBe(`${JSON.stringify(record)}\n`);
  });

  it("maps scrub work to structured findings and dry-run effects", async () => {
    const home = await makeHome();
    const auditPath = path.join(home, ".openclaw", "logs", "config-audit.jsonl");
    const result = { scanned: 2, rewritten: 1, skipped: 0, aborted: false, auditPath };

    expect(configAuditScrubToHealthFinding(result)).toEqual(
      expect.objectContaining({
        checkId: "core/doctor/config-audit-scrub",
        severity: "warning",
        path: auditPath,
      }),
    );
    expect(configAuditScrubToRepairEffect(result)).toEqual({
      kind: "file",
      action: "would-scrub-config-audit-log",
      target: auditPath,
      dryRunSafe: false,
    });
  });
});
