import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ASSERTIONS_SCRIPT = "scripts/e2e/lib/live-plugin-tool/assertions.mjs";

function writeJson(filePath: string, value: unknown) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function runAssertion(root: string, env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [ASSERTIONS_SCRIPT, "assert-agent-turn"], {
    encoding: "utf8",
    env: {
      ...process.env,
      EXPECTED_SLUG: "live-plugin-slug",
      HOME: root,
      OPENCLAW_LIVE_PLUGIN_TOOL_AGENT_ERROR_PATH: path.join(root, "agent.err"),
      OPENCLAW_LIVE_PLUGIN_TOOL_AGENT_OUTPUT_PATH: path.join(root, "agent.json"),
      OPENCLAW_STATE_DIR: path.join(root, "state"),
      TOOL_NAME: "e2e_slug_probe",
      ...env,
    },
  });
}

describe("live plugin tool assertions", () => {
  it("streams session transcripts across chunk boundaries", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-live-plugin-tool-"));
    const sessionsDir = path.join(root, "state", "agents", "main", "sessions");

    try {
      writeJson(path.join(root, "agent.json"), {
        payloads: [{ text: "live-plugin-slug" }],
      });
      mkdirSync(sessionsDir, { recursive: true });
      writeFileSync(
        path.join(sessionsDir, "tool.jsonl"),
        `${"x".repeat(64 * 1024 - "e2e_slug_".length)}e2e_slug_probe\n`,
        "utf8",
      );
      writeFileSync(
        path.join(sessionsDir, "reply.jsonl"),
        `${"x".repeat(64 * 1024 - "live-plugin-".length)}live-plugin-slug\n`,
        "utf8",
      );

      const result = runAssertion(root);

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("bounds agent output diagnostics on missing reply slug", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-live-plugin-tool-"));

    try {
      writeJson(path.join(root, "agent.json"), {
        payloads: [
          {
            text: `DO_NOT_DUMP_OLD_STDOUT${"x".repeat(70 * 1024)}\nrecent stdout tail`,
          },
        ],
      });
      writeFileSync(
        path.join(root, "agent.err"),
        `DO_NOT_DUMP_OLD_STDERR${"x".repeat(70 * 1024)}\nrecent stderr tail\n`,
        "utf8",
      );

      const result = runAssertion(root);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("stdout tail=");
      expect(result.stderr).toContain("stderr tail=");
      expect(result.stderr).toContain("recent stdout tail");
      expect(result.stderr).toContain("recent stderr tail");
      expect(result.stderr).not.toContain("DO_NOT_DUMP_OLD_STDOUT");
      expect(result.stderr).not.toContain("DO_NOT_DUMP_OLD_STDERR");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("does not dump session transcript contents when a transcript check fails", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-live-plugin-tool-"));
    const sessionsDir = path.join(root, "state", "agents", "main", "sessions");

    try {
      writeJson(path.join(root, "agent.json"), {
        payloads: [{ text: "live-plugin-slug" }],
      });
      mkdirSync(sessionsDir, { recursive: true });
      writeFileSync(
        path.join(sessionsDir, "session.jsonl"),
        `DO_NOT_DUMP_SESSION_CONTENT${"x".repeat(70 * 1024)}\n`,
        "utf8",
      );

      const result = runAssertion(root);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("session transcript did not show");
      expect(result.stderr).toContain("after checking 1 jsonl file(s)");
      expect(result.stderr).toContain("session.jsonl");
      expect(result.stderr).not.toContain("DO_NOT_DUMP_SESSION_CONTENT");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
