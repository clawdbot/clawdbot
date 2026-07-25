// QA script evidence writer tests cover status, bounded logs, and artifact paths.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateQaEvidenceSummaryJson } from "../../../../extensions/qa-lab/api.js";
import {
  createQaScriptBlockedStatusTracker,
  createQaScriptEvidenceWriter,
} from "./script-evidence.js";

const tempRoots: string[] = [];

async function makeWriter(params: { maxDetailsBytes?: number; maxLogBytes?: number } = {}) {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-script-evidence-"));
  tempRoots.push(repoRoot);
  return {
    artifactBase: path.join(repoRoot, ".artifacts", "qa-e2e", "script"),
    repoRoot,
    writer: createQaScriptEvidenceWriter({
      artifactBase: path.join(repoRoot, ".artifacts", "qa-e2e", "script"),
      logFileName: "producer.log",
      maxDetailsBytes: params.maxDetailsBytes,
      maxLogBytes: params.maxLogBytes ?? 64,
      primaryModel: "mock-openai/gpt-5.6-luna",
      providerMode: "mock-openai",
      repoRoot,
      target: {
        id: "script-evidence-test",
        title: "Script evidence test",
        sourcePath: "test/e2e/qa-lab/runtime/script-evidence.test.ts",
      },
    }),
  };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("QA script evidence writer", () => {
  for (const status of ["pass", "fail", "blocked"] as const) {
    it(`writes ${status} evidence with normalized artifact paths`, async () => {
      const { artifactBase, writer } = await makeWriter();
      const summaryPath = path.join(artifactBase, "nested", "summary.json");
      await fs.mkdir(path.dirname(summaryPath), { recursive: true });
      await fs.writeFile(summaryPath, "{}\n", "utf8");
      writer.appendLog("producer output\n");

      const evidence = await writer.write({
        artifacts: [{ kind: "summary", filePath: summaryPath }],
        details: `${status} details`,
        durationMs: 25,
        status,
      });

      expect(evidence.entries[0]).toMatchObject({
        execution: {
          artifacts: [
            { kind: "log", path: "producer.log", source: "script" },
            { kind: "summary", path: path.join("nested", "summary.json"), source: "script" },
          ],
        },
        result: {
          status,
          timing: { wallMs: 25 },
        },
      });
      const diskEvidence = validateQaEvidenceSummaryJson(
        JSON.parse(await fs.readFile(path.join(artifactBase, "qa-evidence.json"), "utf8")),
      );
      expect(diskEvidence).toEqual(evidence);
      expect(
        JSON.parse(await fs.readFile(path.join(artifactBase, "latest-run.json"), "utf8")),
      ).toEqual({ qaEvidence: "qa-evidence.json" });
    });
  }

  it("keeps only the bounded log tail", async () => {
    const { artifactBase, writer } = await makeWriter({ maxLogBytes: 24 });
    writer.appendLog(`discard-me-${"x".repeat(64)}`);
    writer.appendLog("recent-tail");

    await writer.write({ durationMs: 1, status: "pass" });

    const log = await fs.readFile(path.join(artifactBase, "producer.log"), "utf8");
    expect(log).toContain("recent-tail");
    expect(log).not.toContain("discard-me");
    expect(Buffer.byteLength(log, "utf8")).toBeLessThanOrEqual(24);
  });

  it("keeps only the bounded failure detail tail", async () => {
    const { writer } = await makeWriter({ maxDetailsBytes: 24 });

    const evidence = writer.build({
      details: `discard-me-${"x".repeat(64)}recent-reason`,
      durationMs: 1,
      status: "fail",
    });

    const reason = evidence.entries[0]?.result.failure?.reason ?? "";
    expect(reason).toContain("recent-reason");
    expect(reason).not.toContain("discard-me");
    expect(Buffer.byteLength(reason, "utf8")).toBeLessThanOrEqual(24);
  });

  it("keeps UTF-8 logs and failure details within byte limits", async () => {
    const { artifactBase, writer } = await makeWriter({
      maxDetailsBytes: 9,
      maxLogBytes: 9,
    });
    const diagnostic = `${"🙂".repeat(32)}done`;
    writer.appendLog(diagnostic);

    const evidence = await writer.write({
      details: diagnostic,
      durationMs: 1,
      status: "fail",
    });

    const log = await fs.readFile(path.join(artifactBase, "producer.log"), "utf8");
    const reason = evidence.entries[0]?.result.failure?.reason ?? "";
    expect(log).toContain("done");
    expect(reason).toContain("done");
    expect(Buffer.byteLength(log, "utf8")).toBeLessThanOrEqual(9);
    expect(Buffer.byteLength(reason, "utf8")).toBeLessThanOrEqual(9);
  });

  it("applies built-in and configured redaction before bounding logs and details", async () => {
    const { artifactBase, repoRoot, writer } = await makeWriter({
      maxDetailsBytes: 4096,
      maxLogBytes: 4096,
    });
    const configPath = path.join(repoRoot, "openclaw.json");
    await fs.writeFile(
      configPath,
      `${JSON.stringify({ logging: { redactPatterns: ["/internal-\\d+/g"] } })}\n`,
      "utf8",
    );
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
    writer.appendLog(`${"x".repeat(16_380)}inter`);
    writer.appendLog("nal-12345 should hide password=s");
    writer.appendLog("k-split-secret-1234567890");

    const evidence = await writer.write({
      details: "reason internal-67890 should hide",
      durationMs: 1,
      status: "fail",
    });

    const log = await fs.readFile(path.join(artifactBase, "producer.log"), "utf8");
    expect(log).toContain("*** should hide password=sk-spl…7890");
    expect(log).not.toContain("internal-12345");
    expect(evidence.entries[0]?.result.failure?.reason).toBe("reason *** should hide");
  });

  it("omits oversized raw logs instead of truncating before redaction", async () => {
    const secretTail = "private-secret-tail-1234567890";
    const { artifactBase, writer } = await makeWriter({ maxLogBytes: 128 });
    writer.appendLog(`password=${"x".repeat(40 * 1024)}${secretTail}`);

    await writer.write({ durationMs: 1, status: "fail" });

    const log = await fs.readFile(path.join(artifactBase, "producer.log"), "utf8");
    expect(log).toBe("QA evidence log omitted: safe redaction buffer exceeded.\n");
    expect(log).not.toContain(secretTail);
    expect(Buffer.byteLength(log, "utf8")).toBeLessThanOrEqual(128);
  });

  it.each(["..", "../outside.log"])(
    "rejects artifact path %s outside the producer output directory",
    async (filePath) => {
      const { writer } = await makeWriter();

      expect(() =>
        writer.build({
          artifacts: [{ kind: "log", filePath }],
          durationMs: 1,
          status: "fail",
        }),
      ).toThrow("QA evidence artifact must be inside artifact base");
    },
  );

  it("tracks blocked output before discarded diagnostic tails", () => {
    const tracker = createQaScriptBlockedStatusTracker([/missing provider auth/i]);

    tracker.append("missing provider ");
    tracker.append(`auth\n${"x".repeat(4096)}`);

    expect(tracker.status()).toBe("blocked");
  });
});
