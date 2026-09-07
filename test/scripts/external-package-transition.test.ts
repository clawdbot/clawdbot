import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const helper = path.resolve("scripts/e2e/lib/external-package-transition.mjs");
const refusal =
  "Updater-owned Doctor cannot migrate shared state from schema 15 to 16 while the older updater owns completion.";

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "external-transition-test-"));
  roots.push(root);
  const file = (name: string, value: unknown) => {
    const target = path.join(root, name);
    writeFileSync(target, JSON.stringify(value));
    return target;
  };
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [helper, ...args], {
      encoding: "utf8",
      env: { ...process.env, OPENCLAW_STATE_DIR: root },
    });
  return { root, file, run };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("external package transition evidence", () => {
  it("refuses a changed shared schema before accepting the negative control", () => {
    const { root, run } = fixture();
    mkdirSync(path.join(root, "state"));
    const database = new DatabaseSync(path.join(root, "state", "openclaw.sqlite"));
    database.exec("PRAGMA user_version = 15");
    expect(run("schema", "15").status).toBe(0);
    database.exec("PRAGMA user_version = 16");
    database.close();
    const changed = run("schema", "15");
    expect(changed.status).toBe(1);
    expect(changed.stderr).toContain("shared schema changed");
  });

  it.each([
    { exit: "0", reason: "openclaw doctor", detail: refusal },
    { exit: "1", reason: "network-failed", detail: refusal },
    { exit: "1", reason: "openclaw doctor", detail: "download timed out" },
  ])(
    "rejects unrelated or successful updates as refusal proof: $reason/$exit/$detail",
    ({ exit, reason, detail }) => {
      const { run, file } = fixture();
      const result = run(
        "refusal",
        exit,
        file("stdout.json", { status: "error", reason, steps: [{ stderrTail: detail }] }),
        file("stderr.txt", ""),
      );
      expect(result.status).toBe(1);
    },
  );

  it("records the exact old-parent failure as negative self-update evidence", () => {
    const { run, file } = fixture();
    const result = run(
      "refusal",
      "1",
      file("stdout.json", {
        status: "error",
        reason: "openclaw doctor",
        steps: [{ stderrTail: refusal }],
      }),
      file("stderr.txt", ""),
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      status: "safely-refused",
      method: "in-process-self-update",
      exitCode: 1,
    });
  });

  it("requires both persisted user and assistant messages", () => {
    const { run, file } = fixture();
    const user = { role: "user", content: "Return marker RETAINED" };
    const missing = run("history", file("missing.json", { messages: [user] }), "RETAINED");
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("durable assistant message");
    const retained = run(
      "history",
      file("retained.json", {
        messages: [user, { role: "assistant", content: [{ type: "text", text: "RETAINED" }] }],
      }),
      "RETAINED",
    );
    expect(retained.status).toBe(0);
  });

  it("refuses an ambiguous retained session identity", () => {
    const { run, file } = fixture();
    const result = run(
      "session-key",
      file("sessions.json", {
        sessions: [
          { key: "first", sessionId: "retained" },
          { key: "second", sessionId: "retained" },
        ],
      }),
      "retained",
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("expected one retained session identity");
  });
});
