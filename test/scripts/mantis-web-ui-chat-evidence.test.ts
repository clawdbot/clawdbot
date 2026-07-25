// Mantis web UI chat evidence tests cover manifest generation.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildWebUiChatEvidenceManifest,
  writeWebUiChatEvidence,
} from "../../scripts/mantis/build-web-ui-chat-evidence.mjs";

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(path.join(tmpdir(), "openclaw-mantis-web-ui-chat-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

describe("build-web-ui-chat-evidence", () => {
  it("marks a passing Control UI chat proof as publishable visible Mantis evidence", () => {
    const manifest = buildWebUiChatEvidenceManifest({
      candidateRef: "HEAD",
      candidateSha: "1234567890abcdef1234567890abcdef12345678",
      status: "pass",
    });

    expect(manifest).toMatchObject({
      id: "web-ui-chat-proof",
      scenario: "web-ui-chat-proof",
      comparison: {
        candidate: {
          fixed: true,
          ref: "HEAD",
          sha: "1234567890abcdef1234567890abcdef12345678",
          status: "pass",
        },
        pass: true,
      },
    });
    expect(manifest.artifacts).toContainEqual(
      expect.objectContaining({
        inline: true,
        kind: "desktopScreenshot",
        path: "web-ui-chat.png",
        required: true,
      }),
    );
  });

  it("writes a failing manifest without requiring a missing screenshot", () => {
    withTempDir((dir) => {
      const result = writeWebUiChatEvidence([
        "--output-dir",
        dir,
        "--candidate-sha",
        "abcdef",
        "--status",
        "fail",
      ]);

      expect(existsSync(result.manifestPath)).toBe(true);
      expect(existsSync(result.reportPath)).toBe(true);
      const manifest = JSON.parse(readFileSync(result.manifestPath, "utf8"));
      expect(manifest.comparison.pass).toBe(false);
      expect(
        manifest.artifacts.find(
          (artifact: { path: string }) => artifact.path === "web-ui-chat.png",
        ),
      ).toMatchObject({
        required: false,
      });
      expect(readFileSync(result.reportPath, "utf8")).toContain("Status: fail");
    });
  });

  it("uses the explicit pass status and includes report output", () => {
    withTempDir((dir) => {
      writeFileSync(path.join(dir, "web-ui-chat.png"), "png");
      writeFileSync(
        path.join(dir, "web-ui-chat-proof.json"),
        `${JSON.stringify({ status: "pass" })}\n`,
      );

      const result = writeWebUiChatEvidence([
        "--output-dir",
        dir,
        "--candidate-ref",
        "main",
        "--status",
        "pass",
      ]);

      expect(result.manifest.comparison).toMatchObject({
        candidate: { fixed: true, ref: "main", status: "pass" },
        pass: true,
      });
      expect(readFileSync(result.reportPath, "utf8")).toContain(
        "Screenshot: `web-ui-chat.png` (present)",
      );
    });
  });
});
