#!/usr/bin/env node
// Builds a Mantis evidence manifest from Control UI web chat proof artifacts.
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) {
      throw new Error(`Unexpected argument: ${key}`);
    }
    const name = key.slice(2).replaceAll("-", "_");
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${key}`);
    }
    args[name] = value;
    index += 1;
  }
  return args;
}

function normalizeStatus(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (normalized === "pass") {
    return "pass";
  }
  if (normalized === "fail") {
    return "fail";
  }
  throw new Error(`Unsupported web UI chat proof status: ${value}`);
}

function artifactEntry({ inline = false, kind, label, path: artifactPath, required }) {
  return {
    kind,
    lane: "candidate",
    label,
    path: artifactPath,
    targetPath: artifactPath,
    required,
    ...(inline ? { alt: label, inline: true, width: 900 } : {}),
  };
}

function buildWebUiChatEvidenceManifest({ candidateRef, candidateSha, status, captures }) {
  const passed = status === "pass";
  return {
    schemaVersion: 2,
    id: "web-ui-chat-proof",
    title: "Mantis Web UI Chat Proof",
    summary: passed
      ? "Mantis ran the OpenClaw Control UI chat proof against the candidate ref, sent a message through the mocked Gateway, rendered the final reply in the browser, and captured browser artifacts for review."
      : "Mantis could not complete the Control UI chat proof. Retained attempt artifacts and logs describe the failure.",
    scenario: "web-ui-chat-proof",
    comparison: {
      candidate: {
        ...(candidateSha ? { sha: candidateSha } : {}),
        ...(candidateRef ? { ref: candidateRef } : {}),
        expected: "Control UI chat sends through the Gateway and renders the final reply",
        expectationMet: passed,
        status,
        fixed: passed,
      },
      outcome: passed ? "pass" : "fail",
      pass: passed,
    },
    artifacts: [
      ...captures.flatMap(({ directory, complete }) => [
        artifactEntry({
          inline: true,
          kind: "desktopScreenshot",
          label: `Control UI web chat proof (${directory})`,
          path: `${directory}/web-ui-chat.png`,
          required: passed && complete,
        }),
        artifactEntry({
          kind: "fullVideo",
          label: `Control UI web chat recording (${directory})`,
          path: `${directory}/web-ui-chat.webm`,
          required: false,
        }),
        artifactEntry({
          kind: "metadata",
          label: `Control UI web chat proof metadata (${directory})`,
          path: `${directory}/web-ui-chat-proof.json`,
          required: passed && complete,
        }),
      ]),
      artifactEntry({
        kind: "metadata",
        label: "Control UI web chat Vitest log",
        path: "vitest.log",
        required: false,
      }),
      artifactEntry({
        kind: "metadata",
        label: "Control UI web chat setup log",
        path: "setup.log",
        required: false,
      }),
      {
        kind: "report",
        lane: "run",
        label: "Mantis web UI chat report",
        path: "mantis-report.md",
        targetPath: "mantis-report.md",
      },
    ],
  };
}

function renderReport({ candidateRef, candidateSha, outputDir, status, artifacts }) {
  const artifactStatus = (artifactPath) =>
    existsSync(path.join(outputDir, artifactPath)) ? "present" : "missing";
  return [
    "# Mantis Web UI Chat Proof",
    "",
    `Status: ${status}`,
    `Candidate ref: ${candidateRef || "unspecified"}`,
    `Candidate SHA: ${candidateSha || "unspecified"}`,
    "",
    "## Scenario",
    "",
    "The scenario loads OpenClaw Control UI chat in a browser with the mocked Gateway harness, sends a chat message through the GUI, verifies the `chat.send` request, emits a final Gateway reply, and waits for the reply to render in the web chat thread.",
    "",
    "## Artifacts",
    "",
    ...artifacts
      .filter((artifact) => artifact.kind !== "report")
      .map(
        (artifact) =>
          `- ${artifact.label}: \`${artifact.path}\` (${artifactStatus(artifact.path)})`,
      ),
    "",
  ].join("\n");
}

export function writeWebUiChatEvidence(rawArgs = process.argv.slice(2)) {
  const args = parseArgs(rawArgs);
  if (!args.output_dir) {
    throw new Error("Missing --output-dir.");
  }
  if (!args.status) {
    throw new Error("Missing --status.");
  }
  const outputDir = path.resolve(args.output_dir);
  mkdirSync(outputDir, { recursive: true });
  const reportPath = path.join(outputDir, "mantis-report.md");
  const manifestPath = path.join(outputDir, "mantis-evidence.json");
  if (existsSync(reportPath) || existsSync(manifestPath)) {
    throw new Error("Evidence already exists in --output-dir; use a fresh invocation directory.");
  }
  const status = normalizeStatus(args.status);
  // The workflow owns this fresh invocation root. Keep every attempt, including
  // incomplete retries; never pick a newest capture from a shared history root.
  const captures = readdirSync(outputDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("mantis-chat-proof-"))
    .map((entry) => entry.name)
    .toSorted()
    .map((directory) => ({
      directory,
      complete: ["web-ui-chat.png", "web-ui-chat-proof.json"].every((file) =>
        existsSync(path.join(outputDir, directory, file)),
      ),
    }));
  if (status === "pass" && !captures.some((capture) => capture.complete)) {
    throw new Error(
      "Passing proof requires a captured screenshot and proof metadata in --output-dir.",
    );
  }
  const manifest = buildWebUiChatEvidenceManifest({
    candidateRef: args.candidate_ref,
    candidateSha: args.candidate_sha,
    status,
    captures,
  });
  writeFileSync(
    reportPath,
    renderReport({
      candidateRef: args.candidate_ref,
      candidateSha: args.candidate_sha,
      outputDir,
      status,
      artifacts: manifest.artifacts,
    }),
    { encoding: "utf8", flag: "wx" },
  );
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  return { manifest, manifestPath, reportPath };
}

const executedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (executedPath === fileURLToPath(import.meta.url)) {
  try {
    writeWebUiChatEvidence();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
