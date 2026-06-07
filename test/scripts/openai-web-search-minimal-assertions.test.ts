// Openai Web Search Minimal Assertions tests cover openai web search minimal assertions script behavior.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ASSERTIONS_SCRIPT = "scripts/e2e/lib/openai-web-search-minimal/assertions.mjs";

function runAssertSuccessRequest(logPath: string) {
  return spawnSync(process.execPath, [ASSERTIONS_SCRIPT, "assert-success-request", logPath], {
    encoding: "utf8",
  });
}

describe("openai web-search minimal assertions", () => {
  it("accepts a success request with web_search and non-minimal reasoning", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "openclaw-web-search-minimal-"));
    try {
      const logPath = path.join(dir, "requests.jsonl");
      writeFileSync(
        logPath,
        `${JSON.stringify({
          body: {
            input: "OPENCLAW_SCHEMA_E2E_OK",
            reasoning: { effort: "low" },
            tools: [{ type: "web_search" }],
          },
          method: "POST",
          path: "/v1/responses",
        })}\n`,
      );

      expect(runAssertSuccessRequest(logPath).status).toBe(0);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("finds success requests split across large scan chunks", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "openclaw-web-search-minimal-"));
    try {
      const logPath = path.join(dir, "requests.jsonl");
      writeFileSync(
        logPath,
        `${JSON.stringify({ path: "/health", body: { pad: "x".repeat(70 * 1024) } })}\n${JSON.stringify(
          {
            body: {
              input: "OPENCLAW_SCHEMA_E2E_OK",
              reasoning: { effort: "low" },
              tools: [{ type: "web_search" }],
            },
            method: "POST",
            path: "/v1/responses",
          },
        )}\n`,
      );

      expect(runAssertSuccessRequest(logPath).status).toBe(0);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("bounds diagnostics when the OpenAI responses endpoint was not used", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "openclaw-web-search-minimal-"));
    try {
      const logPath = path.join(dir, "requests.jsonl");
      writeFileSync(
        logPath,
        `${JSON.stringify({
          body: {
            old: `DO_NOT_DUMP_OLD_REQUESTS${"x".repeat(70 * 1024)}`,
          },
          path: "/health",
        })}\n`,
      );

      const result = runAssertSuccessRequest(logPath);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Request log tail:");
      expect(result.stderr).not.toContain("DO_NOT_DUMP_OLD_REQUESTS");
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("bounds diagnostics when no success response is present", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "openclaw-web-search-minimal-"));
    try {
      const logPath = path.join(dir, "requests.jsonl");
      writeFileSync(
        logPath,
        `${JSON.stringify({
          body: {
            input: `DO_NOT_DUMP_OLD_RESPONSE${"x".repeat(70 * 1024)}recent response tail`,
            tools: [{ type: "web_search" }],
          },
          method: "POST",
          path: "/v1/responses",
        })}\n`,
      );

      const result = runAssertSuccessRequest(logPath);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Recent /v1/responses:");
      expect(result.stderr).toContain("recent response tail");
      expect(result.stderr).not.toContain("DO_NOT_DUMP_OLD_RESPONSE");
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("rejects function-shaped web_search as native Responses proof", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "openclaw-web-search-minimal-"));
    try {
      const logPath = path.join(dir, "requests.jsonl");
      writeFileSync(
        logPath,
        `${JSON.stringify({
          body: {
            input: "OPENCLAW_SCHEMA_E2E_OK",
            reasoning: { effort: "low" },
            tools: [{ name: "web_search", type: "function" }],
          },
          method: "POST",
          path: "/v1/responses",
        })}\n`,
      );

      const result = runAssertSuccessRequest(logPath);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("success request did not include native web_search");
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });
});
