import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { acquireFileLock } from "openclaw/plugin-sdk/file-lock";
import { QA_EVIDENCE_FILENAME, type QaEvidenceSummaryJson } from "./evidence-summary.js";
import { resolveQaSuiteOutputDir } from "./suite-planning.js";

export type QaSuiteDeferredCompletion<Result> = Readonly<{
  result: Result;
  evidence: QaEvidenceSummaryJson;
  complete: () => void | Promise<void>;
  transformStagedEvidence?: (stagedPath: string) => Promise<void>;
}>;

export async function completeQaSuiteWithoutEvidence<Result>(
  run: () => Promise<QaSuiteDeferredCompletion<Result>>,
): Promise<Result> {
  const completion = await run();
  await completion.complete();
  return completion.result;
}

export async function runQaSuiteEvidenceLifecycle<Result>(
  params: { repoRoot?: string; outputDir?: string } | undefined,
  run: (resolved: {
    repoRoot: string;
    outputDir: string;
  }) => QaSuiteDeferredCompletion<Result> | Promise<QaSuiteDeferredCompletion<Result>>,
): Promise<Result> {
  const repoRoot = path.resolve(params?.repoRoot ?? process.cwd());
  const outputDir = await resolveQaSuiteOutputDir(repoRoot, params?.outputDir);
  const canonicalPath = path.join(outputDir, QA_EVIDENCE_FILENAME);
  const stagedPath = path.join(outputDir, `.${QA_EVIDENCE_FILENAME}.${randomUUID()}.staged`);
  const lock = await acquireFileLock(outputDir, {
    retries: { retries: 0, factor: 1, minTimeout: 1, maxTimeout: 1 },
    stale: 5 * 60_000,
    staleRecovery: "remove-if-unchanged",
  });
  let completion!: QaSuiteDeferredCompletion<Result>;
  const errors: unknown[] = [];
  try {
    await fs.rm(canonicalPath, { force: true });
    completion = await run({ repoRoot, outputDir });
    await fs.writeFile(stagedPath, `${JSON.stringify(completion.evidence, null, 2)}\n`, "utf8");
    await completion.transformStagedEvidence?.(stagedPath);
    await fs.rename(stagedPath, canonicalPath);
  } catch (error) {
    errors.push(error);
    await fs
      .rm(stagedPath, { force: true })
      .catch((discardError: unknown) => errors.push(discardError));
  }
  await lock.release().catch((error) => errors.push(error));
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, "QA suite evidence lifecycle failed", { cause: errors[0] });
  }
  await completion.complete();
  return completion.result;
}
