import { createHash } from "node:crypto";
import fs from "node:fs";
import {
  createTarEntryPreflightChecker,
  extractArchive as extractArchiveSafe,
  mergeExtractedTreeIntoDestination,
  prepareArchiveDestinationDir,
  withStagedArchiveDestination,
} from "../infra/archive.js";
import { formatErrorMessage } from "../infra/errors.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { normalizeStringEntries } from "../shared/string-normalization.js";
import { parseTarVerboseMetadata } from "./skills-install-tar-verbose.js";
import { hasBinary } from "./skills.js";

export type ArchiveExtractResult = { stdout: string; stderr: string; code: number | null };
type TarPreflightResult = {
  entries: string[];
  metadata: ReturnType<typeof parseTarVerboseMetadata>;
};

async function hashFileSha256(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = fs.createReadStream(filePath);
  return await new Promise<string>((resolve, reject) => {
    stream.on("data", (chunk) => {
      hash.update(chunk as Buffer);
    });
    stream.on("error", reject);
    stream.on("end", () => {
      resolve(hash.digest("hex"));
    });
  });
}

function commandFailureResult(
  result: { stdout: string; stderr: string; code: number | null },
  fallbackStderr: string,
): ArchiveExtractResult {
  return {
    stdout: result.stdout,
    stderr: result.stderr || fallbackStderr,
    code: result.code,
  };
}

function buildTarExtractArgv(params: {
  archivePath: string;
  targetDir: string;
  stripComponents: number;
}): string[] {
  const argv = ["tar", "xf", params.archivePath, "-C", params.targetDir];
  if (params.stripComponents > 0) {
    argv.push("--strip-components", String(params.stripComponents));
  }
  return argv;
}

async function readTarPreflight(params: {
  archivePath: string;
  timeoutMs: number;
}): Promise<TarPreflightResult | ArchiveExtractResult> {
  const listResult = await runCommandWithTimeout(["tar", "tf", params.archivePath], {
    timeoutMs: params.timeoutMs,
  });
  if (listResult.code !== 0) {
    return commandFailureResult(listResult, "tar list failed");
  }
  const entries = normalizeStringEntries(listResult.stdout.split("\n"));

  const verboseResult = await runCommandWithTimeout(["tar", "tvf", params.archivePath], {
    timeoutMs: params.timeoutMs,
  });
  if (verboseResult.code !== 0) {
    return commandFailureResult(verboseResult, "tar verbose list failed");
  }
  const metadata = parseTarVerboseMetadata(verboseResult.stdout);
  if (metadata.length !== entries.length) {
    return {
      stdout: verboseResult.stdout,
      stderr: `tar verbose/list entry count mismatch (${metadata.length} vs ${entries.length})`,
      code: 1,
    };
  }
  return { entries, metadata };
}

function isArchiveExtractFailure(
  value: TarPreflightResult | ArchiveExtractResult,
): value is ArchiveExtractResult {
  return "code" in value;
}

async function verifyArchiveHashStable(params: {
  archivePath: string;
  expectedHash: string;
}): Promise<ArchiveExtractResult | null> {
  const postPreflightHash = await hashFileSha256(params.archivePath);
  if (postPreflightHash === params.expectedHash) {
    return null;
  }
  return {
    stdout: "",
    stderr: "tar archive changed during safety preflight; refusing to extract",
    code: 1,
  };
}

async function extractTarBz2WithStaging(params: {
  archivePath: string;
  destinationRealDir: string;
  stripComponents: number;
  timeoutMs: number;
}): Promise<ArchiveExtractResult> {
  return await withStagedArchiveDestination({
    destinationRealDir: params.destinationRealDir,
    run: async (stagingDir) => {
      const extractResult = await runCommandWithTimeout(
        buildTarExtractArgv({
          archivePath: params.archivePath,
          targetDir: stagingDir,
          stripComponents: params.stripComponents,
        }),
        { timeoutMs: params.timeoutMs },
      );
      if (extractResult.code !== 0) {
        return extractResult;
      }
      await mergeExtractedTreeIntoDestination({
        sourceDir: stagingDir,
        destinationDir: params.destinationRealDir,
        destinationRealDir: params.destinationRealDir,
      });
      return extractResult;
    },
  });
}

export async function extractArchive(params: {
  archivePath: string;
  archiveType: string;
  targetDir: string;
  stripComponents?: number;
  timeoutMs: number;
}): Promise<ArchiveExtractResult> {
  const { archivePath, archiveType, targetDir, stripComponents, timeoutMs } = params;
  const strip =
    typeof stripComponents === "number" && Number.isFinite(stripComponents)
      ? Math.max(0, Math.floor(stripComponents))
      : 0;

  try {
    if (archiveType === "zip") {
      await extractArchiveSafe({
        archivePath,
        destDir: targetDir,
        timeoutMs,
        kind: "zip",
        stripComponents: strip,
      });
      return { stdout: "", stderr: "", code: 0 };
    }

    if (archiveType === "tar.gz") {
      await extractArchiveSafe({
        archivePath,
        destDir: targetDir,
        timeoutMs,
        kind: "tar",
        stripComponents: strip,
        tarGzip: true,
      });
      return { stdout: "", stderr: "", code: 0 };
    }

    if (archiveType === "tar.bz2") {
      if (!hasBinary("tar")) {
        return { stdout: "", stderr: "tar not found on PATH", code: null };
      }

      const destinationRealDir = await prepareArchiveDestinationDir(targetDir);
      const preflightHash = await hashFileSha256(archivePath);

      // Preflight list to prevent zip-slip style traversal before extraction.
      const preflight = await readTarPreflight({ archivePath, timeoutMs });
      if (isArchiveExtractFailure(preflight)) {
        return preflight;
      }
      const checkTarEntrySafety = createTarEntryPreflightChecker({
        rootDir: destinationRealDir,
        stripComponents: strip,
        escapeLabel: "targetDir",
      });
      for (let i = 0; i < preflight.entries.length; i += 1) {
        const entryPath = preflight.entries[i];
        const entryMeta = preflight.metadata[i];
        if (!entryPath || !entryMeta) {
          return {
            stdout: "",
            stderr: "tar metadata parse failure",
            code: 1,
          };
        }
        checkTarEntrySafety({
          path: entryPath,
          type: entryMeta.type,
          size: entryMeta.size,
        });
      }

      const hashFailure = await verifyArchiveHashStable({
        archivePath,
        expectedHash: preflightHash,
      });
      if (hashFailure) {
        return hashFailure;
      }

      return await extractTarBz2WithStaging({
        archivePath,
        destinationRealDir,
        stripComponents: strip,
        timeoutMs,
      });
    }

    return { stdout: "", stderr: `unsupported archive type: ${archiveType}`, code: null };
  } catch (err) {
    const message = formatErrorMessage(err);
    return { stdout: "", stderr: message, code: 1 };
  }
}
