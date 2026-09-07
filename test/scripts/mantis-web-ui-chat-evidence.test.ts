// Mantis web UI chat evidence tests cover retained capture-to-publisher identity.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeWebUiChatEvidence } from "../../scripts/mantis/build-web-ui-chat-evidence.mjs";
import {
  loadEvidenceManifest,
  renderEvidenceComment,
} from "../../scripts/mantis/publish-pr-evidence.mjs";

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(path.join(tmpdir(), "openclaw-mantis-web-ui-chat-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

function captureAttempt(parent: string, marker: string, complete = true): string {
  const directory = mkdtempSync(path.join(parent, "mantis-chat-proof-"));
  writeFileSync(path.join(directory, "web-ui-chat.png"), `${marker} screenshot`);
  writeFileSync(path.join(directory, "web-ui-chat.webm"), `${marker} video`);
  if (complete) {
    const metadata = JSON.stringify({ status: "pass" });
    writeFileSync(path.join(directory, "web-ui-chat-proof.json"), metadata);
  }
  return directory;
}

describe("build-web-ui-chat-evidence", () => {
  it("publishes every attempt at its exact retained path without mixing invocation roots", () => {
    withTempDir((dir) => {
      const priorRoot = mkdtempSync(path.join(dir, "run-"));
      const priorCapture = captureAttempt(priorRoot, "prior");
      const prior = writeWebUiChatEvidence(["--output-dir", priorRoot, "--status", "pass"]);
      const priorReport = readFileSync(prior.reportPath, "utf8");
      const priorManifest = readFileSync(prior.manifestPath, "utf8");

      const root = mkdtempSync(path.join(dir, "run-"));
      const incomplete = captureAttempt(root, "incomplete", false);
      const complete = captureAttempt(root, "complete");
      writeFileSync(path.join(root, "vitest.log"), "current invocation log");
      const result = writeWebUiChatEvidence([
        "--output-dir",
        root,
        "--candidate-ref",
        "main",
        "--candidate-sha",
        "1234567890abcdef1234567890abcdef12345678",
        "--status",
        "pass",
      ]);
      const manifest = loadEvidenceManifest(result.manifestPath);
      expect(manifest).toMatchObject({
        id: "web-ui-chat-proof",
        scenario: "web-ui-chat-proof",
        schemaVersion: 2,
        comparison: {
          candidate: { expectationMet: true, fixed: true, ref: "main", status: "pass" },
          pass: true,
        },
      });
      const screenshots = manifest.artifacts.filter(
        (artifact) => artifact.kind === "desktopScreenshot",
      );
      expect(screenshots.map((artifact) => artifact.source).sort()).toEqual(
        [incomplete, complete].map((directory) => path.join(directory, "web-ui-chat.png")).sort(),
      );
      const comment = renderEvidenceComment({
        manifest,
        marker: "<!-- synthetic-mantis-proof -->",
        rawBase: "https://artifacts.example.test/current",
      });
      for (const [directory, marker] of [
        [incomplete, "incomplete"],
        [complete, "complete"],
      ] as const) {
        const relative = path.basename(directory);
        for (const [file, content] of [
          ["web-ui-chat.png", "screenshot"],
          ["web-ui-chat.webm", "video"],
        ]) {
          const artifact = manifest.artifacts.find((entry) => entry.path === `${relative}/${file}`);
          expect(artifact?.targetPath).toBe(`${relative}/${file}`);
          expect(readFileSync(artifact!.source, "utf8")).toBe(`${marker} ${content}`);
          expect(comment).toContain(`https://artifacts.example.test/current/${relative}/${file}`);
          expect(readFileSync(result.reportPath, "utf8")).toContain(`${relative}/${file}`);
        }
      }
      expect(readFileSync(prior.reportPath, "utf8")).toBe(priorReport);
      expect(readFileSync(prior.manifestPath, "utf8")).toBe(priorManifest);
      expect(readFileSync(path.join(priorCapture, "web-ui-chat.png"), "utf8")).toBe(
        "prior screenshot",
      );
      expect(readFileSync(result.reportPath, "utf8")).not.toContain(path.basename(priorCapture));
    });
  });

  it("retains setup failures before a capture exists as publishable failure evidence", () => {
    withTempDir((dir) => {
      writeFileSync(path.join(dir, "setup.log"), "candidate installation failed");
      const result = writeWebUiChatEvidence(["--output-dir", dir, "--status", "fail"]);
      const manifest = loadEvidenceManifest(result.manifestPath);
      expect(manifest.comparison).toMatchObject({
        candidate: { expectationMet: false, status: "fail" },
        pass: false,
      });
      expect(manifest.artifacts.map((artifact) => artifact.targetPath)).toEqual([
        "setup.log",
        "mantis-report.md",
        "mantis-evidence.json",
      ]);
      expect(manifest.summary).toContain("could not complete");
      expect(readFileSync(result.reportPath, "utf8")).toContain("`setup.log` (present)");
    });
  });

  it("keeps a failed process verdict even when an attempt completed its captures", () => {
    withTempDir((dir) => {
      captureAttempt(dir, "completed before process failure");
      const result = writeWebUiChatEvidence(["--output-dir", dir, "--status", "fail"]);
      expect(loadEvidenceManifest(result.manifestPath).comparison.pass).toBe(false);
      expect(readFileSync(result.reportPath, "utf8")).toContain("Status: fail");
    });
  });

  it.each(["absent", "old flat files", "split attempts"])(
    "rejects a passing verdict with %s instead of using unrelated proof",
    (kind) => {
      withTempDir((dir) => {
        const metadata = JSON.stringify({ status: "pass" });
        if (kind === "old flat files") {
          writeFileSync(path.join(dir, "web-ui-chat.png"), "old screenshot");
          writeFileSync(path.join(dir, "web-ui-chat-proof.json"), metadata);
        } else if (kind === "split attempts") {
          captureAttempt(dir, "screenshot only", false);
          const metadataOnly = mkdtempSync(path.join(dir, "mantis-chat-proof-"));
          writeFileSync(path.join(metadataOnly, "web-ui-chat-proof.json"), metadata);
        }
        expect(() => writeWebUiChatEvidence(["--output-dir", dir, "--status", "pass"])).toThrow(
          "Passing proof requires a captured screenshot and proof metadata",
        );
        expect(existsSync(path.join(dir, "mantis-evidence.json"))).toBe(false);
      });
    },
  );

  it("refuses to rewrite reports when the builder is replayed against the same invocation", () => {
    withTempDir((dir) => {
      captureAttempt(dir, "original");
      const original = writeWebUiChatEvidence(["--output-dir", dir, "--status", "pass"]);
      const report = readFileSync(original.reportPath, "utf8");
      const manifest = readFileSync(original.manifestPath, "utf8");
      const retry = captureAttempt(dir, "retained retry", false);
      expect(() => writeWebUiChatEvidence(["--output-dir", dir, "--status", "fail"])).toThrow(
        "use a fresh invocation directory",
      );
      expect(readFileSync(original.reportPath, "utf8")).toBe(report);
      expect(readFileSync(original.manifestPath, "utf8")).toBe(manifest);
      expect(readFileSync(path.join(retry, "web-ui-chat.png"), "utf8")).toBe(
        "retained retry screenshot",
      );
    });
  });
});
