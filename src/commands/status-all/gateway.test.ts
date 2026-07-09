// Status-all gateway tests cover log-tail summaries for auth and runtime diagnostic lines.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readFileTailLines, summarizeLogTail } from "./gateway.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("summarizeLogTail", () => {
  it("marks permanent OAuth refresh failures as reauth-required", () => {
    const lines = summarizeLogTail([
      "[openai] Token refresh failed: 401 {",
      '"error":{"code":"invalid_grant","message":"Session invalidated due to signing in again"}',
      "}",
    ]);

    expect(lines).toEqual(["[openai] token refresh 401 invalid_grant · re-auth required"]);
  });

  it.each([
    ["closing brace", "Session invalidated } due to signing in again"],
    ["opening brace", "Session invalidated { due to signing in again"],
    ["escaped quote before a brace", 'Session invalidated after "}" signing in again'],
  ])("keeps OAuth JSON diagnostics with a %s", (_caseName, message) => {
    const sentinel = "[gateway] synthetic sentinel after OAuth JSON";
    const lines = summarizeLogTail([
      "[openai] Token refresh failed: 401 {",
      `"error":${JSON.stringify({ code: "invalid_grant", message })}`,
      "}",
      sentinel,
    ]);

    expect(lines).toEqual([
      "[openai] token refresh 401 invalid_grant · re-auth required",
      sentinel,
    ]);
  });

  it("parses the first complete OAuth JSON object before an adjacent object", () => {
    const lines = summarizeLogTail([
      "[openai] Token refresh failed: 401 {",
      '"error":{"code":"invalid_grant","message":"Session invalidated due to signing in again"}}{"ignored":true}',
    ]);

    expect(lines).toEqual(["[openai] token refresh 401 invalid_grant · re-auth required"]);
  });

  it("consumes an incomplete OAuth JSON block through the end of the tail", () => {
    const lines = summarizeLogTail([
      "[openai] Token refresh failed: 401 {",
      '"error":{"code":"invalid_grant","message":"Session invalidated due to signing in again"}',
      "unrelated-looking trailing line",
    ]);

    expect(lines).toEqual(["[openai] token refresh 401"]);
  });

  it("keeps bounded OAuth diagnostics UTF-16 well-formed", () => {
    const lines = summarizeLogTail([
      "[openai] Token refresh failed: 500 {",
      `"error":${JSON.stringify({ code: "upstream", message: `${"x".repeat(50)}🚀tail` })}`,
      "}",
    ]);

    expect(lines).toEqual([`[openai] token refresh 500 upstream · ${"x".repeat(50)}…`]);
  });
});

describe("readFileTailLines", () => {
  it("returns complete recent lines from a bounded large-file tail", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-status-log-tail-"));
    tempDirs.push(dir);
    const file = path.join(dir, "gateway.log");
    fs.writeFileSync(
      file,
      `${"x".repeat(300_000)} partial stale line\nrecent one\nrecent two\n`,
      "utf8",
    );

    await expect(readFileTailLines(file, 2)).resolves.toEqual(["recent one", "recent two"]);
  });
});
