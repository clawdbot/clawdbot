import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fileLockMocks = vi.hoisted(() => ({
  acquire: vi.fn(),
  actualAcquire: undefined as
    | typeof import("openclaw/plugin-sdk/file-lock").acquireFileLock
    | undefined,
}));

vi.mock("openclaw/plugin-sdk/file-lock", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/file-lock")>();
  fileLockMocks.actualAcquire = actual.acquireFileLock;
  return { ...actual, acquireFileLock: fileLockMocks.acquire };
});

import { drainFileLockStateForTest } from "openclaw/plugin-sdk/file-lock";
import {
  QA_EVIDENCE_SUMMARY_KIND,
  QA_EVIDENCE_SUMMARY_SCHEMA_VERSION,
  type QaEvidenceSummaryJson,
} from "./evidence-summary.js";
import { runQaSuiteEvidenceLifecycle } from "./suite-evidence-lifecycle.js";

const tempRoots: string[] = [];

async function makeOutputDir(label: string) {
  const repoRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), label)));
  const outputDir = path.join(repoRoot, "output");
  tempRoots.push(repoRoot);
  await fs.mkdir(outputDir, { recursive: true });
  return { outputDir, repoRoot };
}

function makeEvidence(profile: string): QaEvidenceSummaryJson {
  return {
    kind: QA_EVIDENCE_SUMMARY_KIND,
    schemaVersion: QA_EVIDENCE_SUMMARY_SCHEMA_VERSION,
    generatedAt: "2026-08-08T00:00:00.000Z",
    evidenceMode: "full",
    entries: [],
    profile,
  };
}

beforeEach(() => {
  const actualAcquire = fileLockMocks.actualAcquire;
  if (!actualAcquire) {
    throw new Error("expected the real file-lock implementation");
  }
  fileLockMocks.acquire.mockReset().mockImplementation(actualAcquire);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await drainFileLockStateForTest();
  await Promise.all(
    tempRoots.splice(0).map((repoRoot) => fs.rm(repoRoot, { recursive: true, force: true })),
  );
});

describe("QA suite evidence lifecycle", () => {
  it("holds one canonical lock through publication and completes after release", async () => {
    const { outputDir, repoRoot } = await makeOutputDir("qa-evidence-publish-");
    const canonicalPath = path.join(outputDir, "qa-evidence.json");
    const events: string[] = [];
    await fs.writeFile(canonicalPath, "stale\n", "utf8");
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
      events.push("publish");
      return await rename(...args);
    });
    const actualAcquire = fileLockMocks.actualAcquire!;
    fileLockMocks.acquire.mockImplementationOnce(async (...args) => {
      events.push("acquire");
      expect(args[0]).toBe(outputDir);
      expect(args[1]?.retries).toEqual({
        retries: 0,
        factor: 1,
        minTimeout: 1,
        maxTimeout: 1,
      });
      const lock = await actualAcquire(...args);
      expect(lock.lockPath).toBe(`${outputDir}.lock`);
      return {
        ...lock,
        release: async () => {
          events.push("release");
          await lock.release();
        },
      };
    });

    const result = await runQaSuiteEvidenceLifecycle({ repoRoot, outputDir }, async () => {
      events.push("run");
      await expect(fs.access(`${outputDir}.lock`)).resolves.toBeUndefined();
      await expect(fs.access(canonicalPath)).rejects.toMatchObject({ code: "ENOENT" });
      return Object.freeze({
        evidence: makeEvidence("winner"),
        result: "result",
        complete: () => events.push("complete"),
      });
    });

    expect(result).toBe("result");
    expect(events).toEqual(["acquire", "run", "publish", "release", "complete"]);
    await expect(fs.access(`${outputDir}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await fs.readFile(canonicalPath, "utf8"))).toMatchObject({
      profile: "winner",
    });
  });

  it("keeps the run failure primary when discard and release also fail", async () => {
    const { outputDir, repoRoot } = await makeOutputDir("qa-evidence-errors-");
    const runError = new Error("run failed");
    const discardError = new Error("discard failed");
    const releaseError = new Error("release failed");
    const rm = fs.rm.bind(fs);
    vi.spyOn(fs, "rm").mockImplementation(async (targetPath, options) => {
      if (String(targetPath).endsWith(".staged")) {
        throw discardError;
      }
      return await rm(targetPath, options);
    });
    const actualAcquire = fileLockMocks.actualAcquire!;
    fileLockMocks.acquire.mockImplementationOnce(async (...args) => {
      const lock = await actualAcquire(...args);
      return {
        ...lock,
        release: async () => {
          await lock.release();
          throw releaseError;
        },
      };
    });

    const thrown = await runQaSuiteEvidenceLifecycle({ repoRoot, outputDir }, async () => {
      throw runError;
    }).catch((error: unknown) => error);

    expect(thrown).toMatchObject({
      cause: runError,
      errors: [runError, discardError, releaseError],
    });
  });

  it("suppresses completion when the staged profile transform fails", async () => {
    const { outputDir, repoRoot } = await makeOutputDir("qa-evidence-transform-");
    const canonicalPath = path.join(outputDir, "qa-evidence.json");
    const diagnosticPath = path.join(outputDir, "qa-suite-report.md");
    const transformError = new Error("profile transform failed");
    const complete = vi.fn();

    await expect(
      runQaSuiteEvidenceLifecycle({ repoRoot, outputDir }, async () => {
        await fs.writeFile(diagnosticPath, "diagnostic\n", "utf8");
        return Object.freeze({
          evidence: makeEvidence("profile"),
          result: undefined,
          complete,
          transformStagedEvidence: async () => {
            throw transformError;
          },
        });
      }),
    ).rejects.toBe(transformError);

    expect(complete).not.toHaveBeenCalled();
    await expect(fs.access(canonicalPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(diagnosticPath, "utf8")).resolves.toBe("diagnostic\n");
  });

  it("discards after rename failure, releases last, and emits no completion", async () => {
    const { outputDir, repoRoot } = await makeOutputDir("qa-evidence-rename-");
    const publishError = new Error("publish failed");
    const events: string[] = [];
    const complete = vi.fn();
    vi.spyOn(fs, "rename").mockImplementation(async () => {
      events.push("publish");
      throw publishError;
    });
    const rm = fs.rm.bind(fs);
    vi.spyOn(fs, "rm").mockImplementation(async (targetPath, options) => {
      if (String(targetPath).endsWith(".staged")) {
        events.push("discard");
      }
      return await rm(targetPath, options);
    });
    const actualAcquire = fileLockMocks.actualAcquire!;
    fileLockMocks.acquire.mockImplementationOnce(async (...args) => {
      const lock = await actualAcquire(...args);
      return {
        ...lock,
        release: async () => {
          events.push("release");
          await lock.release();
        },
      };
    });

    await expect(
      runQaSuiteEvidenceLifecycle({ repoRoot, outputDir }, async () =>
        Object.freeze({ evidence: makeEvidence("rename"), result: undefined, complete }),
      ),
    ).rejects.toBe(publishError);

    expect(events).toEqual(["publish", "discard", "release"]);
    expect(complete).not.toHaveBeenCalled();
  });

  it("keeps published canonical evidence and emits no completion when release fails", async () => {
    const { outputDir, repoRoot } = await makeOutputDir("qa-evidence-release-");
    const canonicalPath = path.join(outputDir, "qa-evidence.json");
    const releaseError = new Error("release failed after publish");
    const complete = vi.fn();
    const actualAcquire = fileLockMocks.actualAcquire!;
    fileLockMocks.acquire.mockImplementationOnce(async (...args) => {
      const lock = await actualAcquire(...args);
      return {
        ...lock,
        release: async () => {
          await lock.release();
          throw releaseError;
        },
      };
    });

    await expect(
      runQaSuiteEvidenceLifecycle({ repoRoot, outputDir }, async () =>
        Object.freeze({ evidence: makeEvidence("published"), result: undefined, complete }),
      ),
    ).rejects.toBe(releaseError);

    expect(complete).not.toHaveBeenCalled();
    expect(JSON.parse(await fs.readFile(canonicalPath, "utf8"))).toMatchObject({
      profile: "published",
    });
  });
});
