// Live Plugin Tool Assertions tests cover live plugin tool assertions script behavior.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ASSERTIONS_SCRIPT = "scripts/e2e/lib/live-plugin-tool/assertions.mjs";
const DISABLE_EXPERIMENTAL_WARNING = "--disable-warning=ExperimentalWarning";

function nodeOptionsWithoutExperimentalWarnings(extra?: string): string {
  const current = [process.env.NODE_OPTIONS, extra].filter(Boolean).join(" ");
  return current.includes(DISABLE_EXPERIMENTAL_WARNING)
    ? current
    : [current, DISABLE_EXPERIMENTAL_WARNING].filter(Boolean).join(" ");
}

function writeJson(filePath: string, value: unknown) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function runAssertion(root: string, env: Record<string, string> = {}) {
  return runAssertionCommand("assert-agent-turn", root, env);
}

function runAssertionCommand(command: string, root: string, env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [ASSERTIONS_SCRIPT, command], {
    encoding: "utf8",
    env: {
      ...process.env,
      EXPECTED_SLUG: "live-plugin-slug",
      HOME: root,
      MODEL_REF: "openai/gpt-5.5",
      OPENCLAW_LIVE_PLUGIN_TOOL_AGENT_ERROR_PATH: path.join(root, "agent.err"),
      OPENCLAW_LIVE_PLUGIN_TOOL_AGENT_OUTPUT_PATH: path.join(root, "agent.json"),
      OPENCLAW_STATE_DIR: path.join(root, "state"),
      PLUGIN_ID: "e2e-live-plugin-tool",
      PLUGIN_NAME: "@openclaw/e2e-live-plugin-tool",
      PLUGIN_VERSION: "1.0.0",
      SEED: "live plugin slug",
      TOOL_NAME: "e2e_slug_probe",
      ...env,
      NODE_OPTIONS: nodeOptionsWithoutExperimentalWarnings(env.NODE_OPTIONS),
    },
  });
}

describe("live plugin tool assertions", () => {
  it("rejects loose timeout env values instead of parsing numeric prefixes", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-live-plugin-tool-"));
    try {
      const result = runAssertionCommand("configure", root, {
        OPENCLAW_LIVE_PLUGIN_TOOL_TIMEOUT_SECONDS: "1e3",
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("invalid OPENCLAW_LIVE_PLUGIN_TOOL_TIMEOUT_SECONDS: 1e3");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("writes strict positive timeout values into generated config", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-live-plugin-tool-"));
    try {
      const result = runAssertionCommand("configure", root, {
        OPENCLAW_LIVE_PLUGIN_TOOL_TIMEOUT_SECONDS: "240",
      });

      expect(result.status).toBe(0);
      const config = JSON.parse(readFileSync(path.join(root, "state", "openclaw.json"), "utf8"));
      expect(config.models.providers.openai.timeoutSeconds).toBe(240);
      expect(config.agents.defaults.timeoutSeconds).toBe(240);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("streams session transcripts across chunk boundaries", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-live-plugin-tool-"));
    const sessionsDir = path.join(root, "state", "agents", "main", "sessions");

    try {
      writeJson(path.join(root, "agent.json"), {
        payloads: [{ text: "live-plugin-slug" }],
      });
      mkdirSync(sessionsDir, { recursive: true });
      writeFileSync(
        path.join(sessionsDir, "session.jsonl"),
        [
          JSON.stringify({
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: "call-live-plugin-tool",
                  name: "e2e_slug_probe",
                  input: { seed: "live plugin slug" },
                },
              ],
            },
          }),
          JSON.stringify({
            message: {
              role: "tool",
              tool_call_id: "call-live-plugin-tool",
              content: `${"x".repeat(64 * 1024)}\nlive-plugin-slug`,
            },
          }),
        ].join("\n"),
        "utf8",
      );

      const result = runAssertion(root);

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects markers that only appear as raw transcript text", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-live-plugin-tool-"));
    const sessionsDir = path.join(root, "state", "agents", "main", "sessions");

    try {
      writeJson(path.join(root, "agent.json"), {
        payloads: [{ text: "live-plugin-slug" }],
      });
      mkdirSync(sessionsDir, { recursive: true });
      writeFileSync(
        path.join(sessionsDir, "session.jsonl"),
        ["e2e_slug_probe", "live-plugin-slug"].join("\n"),
        "utf8",
      );

      const result = runAssertion(root);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("missing causal tool-result evidence");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects split transcript evidence across unrelated files", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-live-plugin-tool-"));
    const sessionsDir = path.join(root, "state", "agents", "main", "sessions");

    try {
      writeJson(path.join(root, "agent.json"), {
        payloads: [{ text: "live-plugin-slug" }],
      });
      mkdirSync(sessionsDir, { recursive: true });
      writeFileSync(path.join(sessionsDir, "tool.jsonl"), "e2e_slug_probe\n", "utf8");
      writeFileSync(path.join(sessionsDir, "reply.jsonl"), "live-plugin-slug\n", "utf8");

      const result = runAssertion(root);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("session transcript did not show");
      expect(result.stderr).toContain("after checking 2 jsonl file(s)");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("bounds session transcript traversal before scanning unbounded trees", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-live-plugin-tool-"));
    const sessionsDir = path.join(root, "state", "agents", "main", "sessions");

    try {
      writeJson(path.join(root, "agent.json"), {
        payloads: [{ text: "live-plugin-slug" }],
      });
      mkdirSync(sessionsDir, { recursive: true });
      for (let index = 0; index < 4; index += 1) {
        writeFileSync(path.join(sessionsDir, `noise-${index}.jsonl`), "noise\n", "utf8");
      }

      const result = runAssertion(root, {
        OPENCLAW_LIVE_PLUGIN_TOOL_SESSION_SCAN_MAX_ENTRIES: "2",
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("session transcript scan exceeded 2 filesystem entries");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects markers that only appear in error payload text", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-live-plugin-tool-"));
    const sessionsDir = path.join(root, "state", "agents", "main", "sessions");

    try {
      writeJson(path.join(root, "agent.json"), {
        payloads: [
          { isError: true, text: "live-plugin-slug" },
          { text: "regular reply without the expected marker" },
        ],
      });
      mkdirSync(sessionsDir, { recursive: true });
      writeFileSync(
        path.join(sessionsDir, "session.jsonl"),
        ["e2e_slug_probe", "live-plugin-slug"].join("\n"),
        "utf8",
      );

      const result = runAssertion(root);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("live agent reply did not contain tool slug");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects non-JSON stdout even when a later object contains the slug", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-live-plugin-tool-"));
    const sessionsDir = path.join(root, "state", "agents", "main", "sessions");

    try {
      writeFileSync(
        path.join(root, "agent.json"),
        ["warning before json", JSON.stringify({ payloads: [{ text: "live-plugin-slug" }] })].join(
          "\n",
        ),
        "utf8",
      );
      mkdirSync(sessionsDir, { recursive: true });
      writeFileSync(
        path.join(sessionsDir, "session.jsonl"),
        ["e2e_slug_probe", "live-plugin-slug"].join("\n"),
        "utf8",
      );

      const result = runAssertion(root);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Unexpected token");
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

  it("rejects oversized agent output before parsing it", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-live-plugin-tool-"));

    try {
      writeFileSync(
        path.join(root, "agent.json"),
        `DO_NOT_DUMP_OLD_AGENT_OUTPUT${"x".repeat(70 * 1024)}\nrecent oversized stdout tail`,
        "utf8",
      );
      writeFileSync(path.join(root, "agent.err"), "recent stderr tail\n", "utf8");

      const result = runAssertion(root, {
        OPENCLAW_LIVE_PLUGIN_TOOL_AGENT_OUTPUT_MAX_BYTES: "1024",
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("live agent output exceeded 1024 bytes");
      expect(result.stderr).toContain("recent oversized stdout tail");
      expect(result.stderr).toContain("recent stderr tail");
      expect(result.stderr).not.toContain("DO_NOT_DUMP_OLD_AGENT_OUTPUT");
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
