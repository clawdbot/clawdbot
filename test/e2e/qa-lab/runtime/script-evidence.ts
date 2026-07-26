// Shared QA script evidence writer keeps producer logs and artifact paths bounded.
import fs from "node:fs/promises";
import path from "node:path";
import {
  buildScriptEvidenceSummary,
  QA_EVIDENCE_FILENAME,
  type QaEvidencePackageSource,
  type QaEvidenceStatus,
  type QaEvidenceSummaryJson,
  type QaProviderMode,
} from "../../../../extensions/qa-lab/api.js";
import { readLoggingConfig } from "../../../../src/logging/config.js";
import { redactToolPayloadTextWithConfig } from "../../../../src/logging/redact.js";
import { withFullContextToolPayloadRedaction } from "../../../../src/logging/redact.test-support.js";
import { DEFAULT_CHILD_OUTPUT_TAIL_BYTES } from "../../../helpers/bounded-child-output.js";

const DEFAULT_QA_SCRIPT_EVIDENCE_DETAILS_BYTES = 32 * 1024;
const QA_SCRIPT_STATUS_MATCH_CARRY_CHARS = 1024;
const QA_SCRIPT_LOG_OVERFLOW_MESSAGE = "QA evidence log omitted: safe redaction buffer exceeded.\n";
const QA_SCRIPT_DETAILS_OVERFLOW_MESSAGE =
  "QA evidence details omitted: safe redaction buffer exceeded.";

type QaScriptEvidenceArtifactInput = {
  filePath: string;
  kind: string;
};

type QaScriptEvidenceTarget = {
  codeRefs?: readonly string[];
  docsRefs?: readonly string[];
  id: string;
  sourcePath: string;
  title: string;
};

export type QaScriptEvidenceStatus = Exclude<QaEvidenceStatus, "skipped">;

type QaScriptEvidenceResult = {
  artifacts?: readonly QaScriptEvidenceArtifactInput[];
  details?: string;
  durationMs: number;
  status: QaScriptEvidenceStatus;
};

type QaScriptEvidenceWriterOptions = {
  artifactBase: string;
  env?: NodeJS.ProcessEnv;
  evidenceMode?: "full" | "slim";
  logFileName: string;
  maxDetailsBytes?: number;
  maxLogBytes?: number;
  packageSource?: QaEvidencePackageSource;
  primaryModel: string;
  providerMode: QaProviderMode;
  repoRoot: string;
  target: QaScriptEvidenceTarget;
};

function resolveArtifactPath(artifactBase: string, filePath: string) {
  const absoluteArtifactBase = path.resolve(artifactBase);
  const absoluteFilePath = path.resolve(absoluteArtifactBase, filePath);
  const relativePath = path.relative(absoluteArtifactBase, absoluteFilePath);
  const escapesArtifactBase =
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath);
  if (!relativePath || escapesArtifactBase) {
    throw new Error(`QA evidence artifact must be inside artifact base: ${filePath}`);
  }
  return { absoluteFilePath, relativePath };
}

async function writeJson(filePath: string, value: unknown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function resolveByteLimit(value: number | undefined, fallback: number) {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function utf8Tail(text: string, maxBytes: number) {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.byteLength <= maxBytes) {
    return text;
  }
  let start = buffer.byteLength - maxBytes;
  while (start < buffer.byteLength && (buffer[start]! & 0xc0) === 0x80) {
    start += 1;
  }
  return buffer.subarray(start).toString("utf8");
}

function createSafeRedactionBuffer(maxBytes: number) {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  let overflowed = false;

  return {
    append(chunk: string) {
      if (overflowed) {
        return;
      }
      const buffer = Buffer.from(chunk);
      if (totalBytes + buffer.byteLength > maxBytes) {
        // Arbitrary configured patterns need the complete raw context. Omit an
        // oversized log instead of truncating before redaction and leaking a tail.
        chunks.length = 0;
        totalBytes = 0;
        overflowed = true;
        return;
      }
      chunks.push(buffer);
      totalBytes += buffer.byteLength;
    },
    overflowed() {
      return overflowed;
    },
    text() {
      return Buffer.concat(chunks, totalBytes).toString("utf8");
    },
  };
}

export function createQaScriptBlockedStatusTracker(blockedPatterns: readonly RegExp[]) {
  let blocked = false;
  let carry = "";

  return {
    append(chunk: unknown) {
      if (blocked) {
        return;
      }
      const text = `${carry}${String(chunk)}`;
      blocked = blockedPatterns.some((pattern) => {
        pattern.lastIndex = 0;
        return pattern.test(text);
      });
      // Keep enough overlap for a prerequisite phrase split across stream chunks.
      carry = text.slice(-QA_SCRIPT_STATUS_MATCH_CARRY_CHARS);
    },
    status(): QaScriptEvidenceStatus {
      return blocked ? "blocked" : "fail";
    },
  };
}

export function createQaScriptEvidenceWriter(options: QaScriptEvidenceWriterOptions) {
  const maxLogBytes = resolveByteLimit(options.maxLogBytes, DEFAULT_CHILD_OUTPUT_TAIL_BYTES);
  const logFile = resolveArtifactPath(options.artifactBase, options.logFileName);
  const maxDetailsBytes = resolveByteLimit(
    options.maxDetailsBytes,
    DEFAULT_QA_SCRIPT_EVIDENCE_DETAILS_BYTES,
  );
  const log = createSafeRedactionBuffer(maxLogBytes + DEFAULT_QA_SCRIPT_EVIDENCE_DETAILS_BYTES);
  const redact = (text: string) =>
    redactToolPayloadTextWithConfig(text, withFullContextToolPayloadRedaction(readLoggingConfig()));
  const boundedLogText = () => {
    if (log.overflowed()) {
      return utf8Tail(QA_SCRIPT_LOG_OVERFLOW_MESSAGE, maxLogBytes);
    }
    return utf8Tail(redact(log.text()), maxLogBytes);
  };

  const boundedDetails = (details: string | undefined) => {
    if (!details) {
      return undefined;
    }
    if (
      Buffer.byteLength(details, "utf8") >
      maxDetailsBytes + DEFAULT_QA_SCRIPT_EVIDENCE_DETAILS_BYTES
    ) {
      return utf8Tail(QA_SCRIPT_DETAILS_OVERFLOW_MESSAGE, maxDetailsBytes);
    }
    return utf8Tail(redact(details), maxDetailsBytes);
  };

  const normalizeArtifacts = (artifacts: readonly QaScriptEvidenceArtifactInput[] = []) => {
    const normalized = [
      { kind: "log", path: logFile.relativePath },
      ...artifacts.map((artifact) => ({
        kind: artifact.kind,
        path: resolveArtifactPath(options.artifactBase, artifact.filePath).relativePath,
      })),
    ];
    return [
      ...new Map(
        normalized.map((artifact) => [`${artifact.kind}:${artifact.path}`, artifact]),
      ).values(),
    ];
  };

  const build = (result: QaScriptEvidenceResult): QaEvidenceSummaryJson =>
    buildScriptEvidenceSummary({
      artifactPaths: normalizeArtifacts(result.artifacts),
      evidenceMode: options.evidenceMode ?? "full",
      env: options.env ?? process.env,
      generatedAt: new Date().toISOString(),
      packageSource: options.packageSource,
      primaryModel: options.primaryModel,
      providerMode: options.providerMode,
      repoRoot: options.repoRoot,
      runner: "script",
      targets: [options.target],
      results: [
        {
          id: options.target.id,
          status: result.status,
          durationMs: result.durationMs,
          failureMessage: boundedDetails(result.details),
        },
      ],
    });

  return {
    appendLog(chunk: unknown) {
      log.append(String(chunk));
    },
    build,
    logText() {
      return boundedLogText();
    },
    async write(result: QaScriptEvidenceResult) {
      const evidence = build(result);
      await fs.mkdir(options.artifactBase, { recursive: true });
      await fs.writeFile(logFile.absoluteFilePath, boundedLogText(), "utf8");
      await writeJson(path.join(options.artifactBase, QA_EVIDENCE_FILENAME), evidence);
      await writeJson(path.join(options.artifactBase, "latest-run.json"), {
        qaEvidence: QA_EVIDENCE_FILENAME,
      });
      return evidence;
    },
  };
}
