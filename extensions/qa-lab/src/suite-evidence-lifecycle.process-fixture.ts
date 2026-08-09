import fs from "node:fs/promises";
import path from "node:path";
import {
  QA_EVIDENCE_SUMMARY_KIND,
  QA_EVIDENCE_SUMMARY_SCHEMA_VERSION,
  type QaEvidenceSummaryJson,
} from "./evidence-summary.js";
import { runQaSuiteEvidenceLifecycle } from "./suite-evidence-lifecycle.js";

const [outputDir, mode, markerPath] = process.argv.slice(2);
if (!outputDir || !mode || !markerPath || !process.send) {
  throw new Error("expected outputDir, mode, markerPath, and IPC");
}

const send = (message: object) => process.send?.(message);
const finish = (message: object) =>
  new Promise<void>((resolve) => {
    process.send?.(message, () => {
      process.disconnect();
      resolve();
    });
  });
const evidence: QaEvidenceSummaryJson = {
  kind: QA_EVIDENCE_SUMMARY_KIND,
  schemaVersion: QA_EVIDENCE_SUMMARY_SCHEMA_VERSION,
  generatedAt: "2026-08-08T00:00:00.000Z",
  evidenceMode: "full",
  entries: [],
  profile: mode,
};

const waitForRelease = () =>
  new Promise<void>((resolve) => {
    process.on("message", (message) => {
      if (message === "release") {
        resolve();
      }
    });
  });

try {
  const result = await runQaSuiteEvidenceLifecycle(
    { repoRoot: path.dirname(outputDir), outputDir },
    async () => {
      send({ type: "entered" });
      if (mode === "hold" || mode === "crash") {
        await waitForRelease();
      }
      return Object.freeze({
        evidence,
        result: mode,
        complete: async () => {
          await fs.writeFile(markerPath, `${mode}\n`, "utf8");
          send({ type: "completed" });
        },
      });
    },
  );
  await finish({ type: "result", result });
} catch (error) {
  await finish({
    type: "error",
    code: error && typeof error === "object" && "code" in error ? String(error.code) : undefined,
    lockPath:
      error && typeof error === "object" && "lockPath" in error
        ? String(error.lockPath)
        : undefined,
    message: error instanceof Error ? error.message : String(error),
  });
}
