import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertAgentReplyContainsMarker,
  assertOpenAiRequestLogUsed,
  extractAgentReplyTexts,
} from "../../scripts/e2e/lib/agent-turn-output.mjs";

describe("scripts/e2e/lib/agent-turn-output", () => {
  it("extracts local and gateway agent reply payload text", () => {
    expect(
      extractAgentReplyTexts(
        JSON.stringify({
          payloads: [{ text: "OPENCLAW_E2E_OK_LOCAL" }],
          meta: { finalAssistantVisibleText: "visible" },
        }),
      ),
    ).toEqual(["visible", "OPENCLAW_E2E_OK_LOCAL"]);

    expect(
      extractAgentReplyTexts(
        JSON.stringify({
          result: {
            payloads: [{ text: "OPENCLAW_E2E_OK_GATEWAY" }],
            meta: { finalAssistantRawText: "raw" },
          },
        }),
      ),
    ).toEqual(["raw", "OPENCLAW_E2E_OK_GATEWAY"]);
  });

  it("reads compact JSON replies from combined stdout and stderr logs", () => {
    expect(
      extractAgentReplyTexts(
        [
          "warning: diagnostic on stderr",
          JSON.stringify({ payloads: [{ text: "OPENCLAW_E2E_OK_COMBINED" }] }),
        ].join("\n"),
      ),
    ).toEqual(["OPENCLAW_E2E_OK_COMBINED"]);
  });

  it("reads pretty JSON replies from combined stdout and stderr logs", () => {
    expect(
      extractAgentReplyTexts(
        [
          "warning: diagnostic on stderr",
          JSON.stringify(
            {
              payloads: [{ text: "OPENCLAW_E2E_OK_PRETTY" }],
            },
            null,
            2,
          ),
        ].join("\n"),
      ),
    ).toEqual(["OPENCLAW_E2E_OK_PRETTY"]);
  });

  it("does not accept markers that only appear outside reply payloads", () => {
    const dir = mkdtempSync(join(tmpdir(), "openclaw-e2e-agent-output-"));
    try {
      const outputPath = join(dir, "agent.log");
      writeFileSync(
        outputPath,
        [
          "Return marker OPENCLAW_E2E_OK_PROMPT_ECHO",
          JSON.stringify({ payloads: [{ text: "wrong reply" }] }),
        ].join("\n"),
      );

      expect(() =>
        assertAgentReplyContainsMarker("OPENCLAW_E2E_OK_PROMPT_ECHO", outputPath),
      ).toThrow(/agent reply payload did not contain marker/u);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("bounds missing marker diagnostics to the recent output tail", () => {
    const dir = mkdtempSync(join(tmpdir(), "openclaw-e2e-agent-output-"));
    try {
      const outputPath = join(dir, "agent.log");
      writeFileSync(
        outputPath,
        [
          "DO_NOT_DUMP_OLD_OUTPUT",
          "x".repeat(70 * 1024),
          JSON.stringify({ payloads: [{ text: "wrong reply" }] }),
        ].join("\n"),
      );

      expect(() => assertAgentReplyContainsMarker("OPENCLAW_E2E_OK_MISSING", outputPath)).toThrow(
        /agent reply payload did not contain marker/u,
      );
      try {
        assertAgentReplyContainsMarker("OPENCLAW_E2E_OK_MISSING", outputPath);
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain("Output tail:");
        expect((error as Error).message).toContain("wrong reply");
        expect((error as Error).message).not.toContain("DO_NOT_DUMP_OLD_OUTPUT");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("bounds large reply payload diagnostics", () => {
    const dir = mkdtempSync(join(tmpdir(), "openclaw-e2e-agent-output-"));
    try {
      const outputPath = join(dir, "agent.log");
      writeFileSync(
        outputPath,
        JSON.stringify({
          payloads: [
            {
              text: `DO_NOT_DUMP_OLD_REPLY${"x".repeat(70 * 1024)}recent reply tail`,
            },
          ],
        }),
      );

      try {
        assertAgentReplyContainsMarker("OPENCLAW_E2E_OK_MISSING", outputPath);
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain("Reply payload summary:");
        expect((error as Error).message).toContain("recent reply tail");
        expect((error as Error).message).not.toContain("DO_NOT_DUMP_OLD_REPLY");
        return;
      }
      throw new Error("expected missing marker assertion to fail");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("checks that the mock OpenAI endpoint was actually hit", () => {
    const dir = mkdtempSync(join(tmpdir(), "openclaw-e2e-request-log-"));
    try {
      mkdirSync(dir, { recursive: true });
      const logPath = join(dir, "requests.jsonl");
      writeFileSync(logPath, `${JSON.stringify({ path: "/v1/responses" })}\n`);
      expect(() => assertOpenAiRequestLogUsed(logPath)).not.toThrow();

      writeFileSync(logPath, `${JSON.stringify({ path: "/health" })}\n`);
      expect(() => assertOpenAiRequestLogUsed(logPath)).toThrow(/was not used/u);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("finds OpenAI request paths split across large log scan chunks", () => {
    const dir = mkdtempSync(join(tmpdir(), "openclaw-e2e-request-log-"));
    try {
      const logPath = join(dir, "requests.jsonl");
      const pathPrefix = "/v1/res";
      writeFileSync(logPath, `${"x".repeat(64 * 1024 - pathPrefix.length)}${pathPrefix}ponses\n`);

      expect(() => assertOpenAiRequestLogUsed(logPath)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("bounds missing OpenAI request diagnostics to the recent log tail", () => {
    const dir = mkdtempSync(join(tmpdir(), "openclaw-e2e-request-log-"));
    try {
      const logPath = join(dir, "requests.jsonl");
      writeFileSync(
        logPath,
        ["DO_NOT_DUMP_OLD_REQUESTS", "x".repeat(70 * 1024), '{"path":"/health"}'].join("\n"),
      );

      try {
        assertOpenAiRequestLogUsed(logPath, "mock server");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain("mock server was not used");
        expect((error as Error).message).toContain("Request log tail:");
        expect((error as Error).message).not.toContain("DO_NOT_DUMP_OLD_REQUESTS");
        return;
      }
      throw new Error("expected missing request log assertion to fail");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
