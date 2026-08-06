// Built CLI proof: Doctor recovers only an interrupted terminal NUL JSONL suffix.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registerOpenClawAgentDatabase } from "../../src/state/openclaw-agent-db-registry.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../src/state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../src/state/openclaw-state-db.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../helpers/openclaw-test-instance.js";

const instances: OpenClawTestInstance[] = [];

afterEach(async () => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  await Promise.all(instances.splice(0).map((instance) => instance.cleanup()));
});

describe("Doctor terminal NUL-tail built CLI proof", () => {
  it("recovers six valid archive records without rewriting their valid bytes", async () => {
    const instance = await createOpenClawTestInstance({
      name: "doctor-media-persistence-nul-tail",
      env: { OPENCLAW_TEST_FAST: "1" },
    });
    instances.push(instance);

    const database = openOpenClawAgentDatabase({ agentId: "main", env: instance.env });
    closeOpenClawAgentDatabasesForTest();
    registerOpenClawAgentDatabase({
      agentId: "main",
      env: instance.env,
      path: database.path,
    });
    closeOpenClawStateDatabaseForTest();

    const archivePath = path.join(
      instance.stateDir,
      "agents",
      "main",
      "sessions",
      "nul-tail.jsonl.deleted.2026-08-06T01-02-03.000Z",
    );
    const archiveContent = `${Array.from({ length: 6 }, (_, index) =>
      JSON.stringify({
        type: "message",
        id: `event-${index + 1}`,
        parentId: null,
        timestamp: 1_000 + index,
        message: { role: "user", content: `record ${index + 1}` },
      }),
    ).join("\n")}\n`;
    const expected = Buffer.from(archiveContent, "utf8");
    fs.mkdirSync(path.dirname(archivePath), { recursive: true });
    fs.writeFileSync(archivePath, Buffer.concat([expected, Buffer.alloc(284)]));

    await expect(instance.entrypoint()).resolves.toEqual([
      expect.stringMatching(/^dist\/index\.(?:js|mjs)$/u),
    ]);
    const first = await instance.cli(["doctor", "--fix", "--non-interactive"], {
      timeoutMs: 90_000,
    });
    expect(first.code, `${first.stderr}\n${first.stdout}`).toBe(0);
    expect(fs.readFileSync(archivePath)).toEqual(expected);
    expect(
      archiveContent
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toHaveLength(6);

    const beforeRerun = fs.statSync(archivePath);
    const rerun = await instance.cli(["doctor", "--fix", "--non-interactive"], {
      timeoutMs: 90_000,
    });
    const afterRerun = fs.statSync(archivePath);
    expect(rerun.code, `${rerun.stderr}\n${rerun.stdout}`).toBe(0);
    expect(fs.readFileSync(archivePath)).toEqual(expected);
    expect(afterRerun).toMatchObject({
      ino: beforeRerun.ino,
      mtimeMs: beforeRerun.mtimeMs,
      size: beforeRerun.size,
    });
  }, 180_000);
});
