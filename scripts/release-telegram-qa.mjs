#!/usr/bin/env node
// Trusted helpers for the release Telegram workflow. Keep policy here so it can
// be exercised directly rather than inferred from a workflow shell snippet.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const SHA = /^[a-f0-9]{40}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const POSITIVE_ID = /^[1-9][0-9]*$/u;

function required(name) {
  const value = process.env[name];
  if (value === undefined) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function appendOutput(lines) {
  appendFileSync(required("GITHUB_OUTPUT"), `${lines.join("\n")}\n`, "utf8");
}

function requireExactCandidateSource() {
  const targetSha = required("TARGET_SHA");
  const sourceSha = required("CANDIDATE_SOURCE_SHA");
  if (!SHA.test(targetSha) || !SHA.test(sourceSha) || sourceSha !== targetSha) {
    throw new Error("Candidate artifact source SHA must exactly match TARGET_SHA.");
  }
  return targetSha;
}

function resolveEvidenceMode() {
  requireExactCandidateSource();
  const candidateVersion = required("CANDIDATE_VERSION");
  const evidenceMode =
    candidateVersion === "2026.6.34" ? "legacy-direct-runner-v1" : "process-boundary-v1";
  process.stdout.write(`${evidenceMode}\n`);
}

function writeLegacyDirectRunnerAttestation() {
  const targetSha = requireExactCandidateSource();
  const candidateVersion = required("CANDIDATE_VERSION");
  if (candidateVersion !== "2026.6.34") {
    throw new Error(
      "Legacy direct-runner evidence is only defined for candidate version 2026.6.34.",
    );
  }

  const contextPath = required("CONTEXT_PATH");
  const aggregatePath = required("AGGREGATE_PATH");
  const context = JSON.parse(readFileSync(contextPath, "utf8"));
  if (
    context?.version !== 1 ||
    context?.kind !== "telegram-sut-boundary" ||
    context.targetSha !== targetSha ||
    context.candidateArtifact?.sourceSha !== targetSha ||
    context.candidateArtifact?.version !== candidateVersion
  ) {
    throw new Error(
      "Legacy Telegram evidence context does not match the attested candidate identity.",
    );
  }

  const aggregate = {
    ...context,
    evidenceMode: "legacy-direct-runner-v1",
    legacyDirectRunnerAttestation: {
      version: 1,
      kind: "telegram-legacy-direct-runner-attestation",
      targetSha,
      candidateArtifact: {
        sourceSha: targetSha,
        version: candidateVersion,
      },
    },
  };
  writeFileSync(aggregatePath, `${JSON.stringify(aggregate, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function advisoryStatus() {
  const env = process.env;
  const cancelled = [
    env.IDENTITY_RESULT,
    env.BUILD_RESULT,
    env.ATTESTATION_RESULT,
    env.RUN_RESULT,
  ].includes("cancelled");
  const succeeded = [
    env.IDENTITY_STATUS,
    env.BUILD_STATUS,
    env.ATTESTATION_STATUS,
    env.EXECUTION_STATUS,
  ].every((value) => value === "success");
  const status = cancelled ? "cancelled" : succeeded ? "success" : "failure";
  const runId = required("GITHUB_RUN_ID");
  const runAttempt = required("GITHUB_RUN_ATTEMPT");
  const targetSha = required("TARGET_SHA");
  const candidateArtifact =
    POSITIVE_ID.test(env.CANDIDATE_ARTIFACT_ID ?? "") &&
    DIGEST.test(env.CANDIDATE_ARTIFACT_DIGEST ?? "") &&
    env.ARCHIVE_NAME === `release-telegram-candidate-${runId}-${runAttempt}-${targetSha}.tar.zst` &&
    DIGEST.test(env.ARCHIVE_SHA256 ?? "") &&
    Boolean(env.CANDIDATE_VERSION)
      ? {
          id: env.CANDIDATE_ARTIFACT_ID,
          name: env.ARCHIVE_NAME,
          digest: env.CANDIDATE_ARTIFACT_DIGEST,
          runId,
          runAttempt: Number(runAttempt),
          fileName: env.ARCHIVE_NAME,
          sha256: env.ARCHIVE_SHA256,
          sourceSha: targetSha,
          version: env.CANDIDATE_VERSION,
        }
      : null;
  if (
    status === "success" &&
    (!candidateArtifact ||
      !SHA.test(env.WORKFLOW_SHA ?? "") ||
      !SHA.test(targetSha) ||
      !POSITIVE_ID.test(env.EVIDENCE_ARTIFACT_ID ?? "") ||
      !DIGEST.test(env.EVIDENCE_ARTIFACT_DIGEST ?? "") ||
      env.EVIDENCE_ARTIFACT_NAME !== `release-qa-live-telegram-${runId}-${runAttempt}-${targetSha}`)
  ) {
    throw new Error("Successful Telegram release status has incomplete evidence.");
  }
  const statusDir = ".artifacts/release-check-status";
  const fileStem = `qa_live_telegram_release_checks-${runId}-${runAttempt}`;
  const statusFile = `${statusDir}/${fileStem}.env`;
  const evidenceFile = `${statusDir}/${fileStem}.json`;
  const stepOutcomes = [
    `identity:${env.IDENTITY_STATUS ?? ""}`,
    `build:${env.BUILD_STATUS ?? ""}`,
    `attest:${env.ATTESTATION_STATUS ?? ""}`,
    `execute:${env.EXECUTION_STATUS ?? ""}`,
  ];
  mkdirSync(statusDir, { recursive: true });
  writeFileSync(
    statusFile,
    [
      `run_id=${runId}`,
      `run_attempt=${runAttempt}`,
      `target_sha=${targetSha}`,
      `workflow_sha=${env.WORKFLOW_SHA ?? ""}`,
      "job=qa_live_telegram_release_checks",
      "variant=",
      `status=${status}`,
      `job_status=${env.RUN_RESULT ?? ""}`,
      `step_outcomes=${stepOutcomes.join(" ")}`,
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    evidenceFile,
    `${JSON.stringify(
      {
        version: 1,
        kind: "release-check-status",
        job: "qa_live_telegram_release_checks",
        status,
        jobStatus: env.RUN_RESULT ?? "",
        stepOutcomes,
        runId,
        runAttempt: Number(runAttempt),
        workflowSha: env.WORKFLOW_SHA ?? "",
        targetSha,
        evidenceArtifact: {
          id: env.EVIDENCE_ARTIFACT_ID ?? "",
          name: env.EVIDENCE_ARTIFACT_NAME ?? "",
          digest: env.EVIDENCE_ARTIFACT_DIGEST ?? "",
          runId,
          runAttempt: Number(runAttempt),
        },
        candidateArtifact,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  appendOutput([`status=${status}`, `status_file=${statusFile}`, `evidence_file=${evidenceFile}`]);
}

const command = process.argv[2];
try {
  if (command === "advisory-status") {
    advisoryStatus();
  } else if (command === "resolve-evidence-mode") {
    resolveEvidenceMode();
  } else if (command === "write-legacy-direct-runner-attestation") {
    writeLegacyDirectRunnerAttestation();
  } else {
    throw new Error(`Unknown release Telegram QA command: ${command ?? ""}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
