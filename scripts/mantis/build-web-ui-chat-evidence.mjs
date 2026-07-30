#!/usr/bin/env node
// Builds a Mantis evidence manifest from Control UI web chat proof artifacts.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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

function artifactEntry({ inline = false, kind, label, path: artifactPath, required, targetPath }) {
  return {
    kind,
    lane: "candidate",
    label,
    path: artifactPath,
    targetPath,
    required,
    ...(inline ? { alt: label, inline: true, width: 900 } : {}),
  };
}

export function buildWebUiChatEvidenceManifest({ candidateRef, candidateSha, status }) {
  const passed = status === "pass";
  return {
    schemaVersion: 1,
    id: "web-ui-chat-proof",
    title: "Mantis Web UI Chat Proof",
    summary:
      "Mantis ran the OpenClaw Control UI chat proof against the candidate ref, sent a message through the mocked Gateway, rendered the final reply in the browser, and captured browser artifacts for review.",
    scenario: "web-ui-chat-proof",
    comparison: {
      candidate: {
        ...(candidateSha ? { sha: candidateSha } : {}),
        ...(candidateRef ? { ref: candidateRef } : {}),
        expected: "Control UI chat sends through the Gateway and renders the final reply",
        status,
        fixed: passed,
      },
      pass: passed,
    },
    artifacts: [
      artifactEntry({
        inline: true,
        kind: "desktopScreenshot",
        label: "Control UI web chat proof",
        path: "web-ui-chat.png",
        required: passed,
        targetPath: "web-ui-chat.png",
      }),
      artifactEntry({
        kind: "fullVideo",
        label: "Control UI web chat recording",
        path: "web-ui-chat.webm",
        required: false,
        targetPath: "web-ui-chat.webm",
      }),
      artifactEntry({
        kind: "metadata",
        label: "Control UI web chat proof metadata",
        path: "web-ui-chat-proof.json",
        required: passed,
        targetPath: "web-ui-chat-proof.json",
      }),
      artifactEntry({
        kind: "metadata",
        label: "Control UI web chat Vitest log",
        path: "vitest.log",
        required: false,
        targetPath: "vitest.log",
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

function renderReport({ candidateRef, candidateSha, outputDir, status }) {
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
    "OpenClaw Control UI chat was loaded in a browser with the mocked Gateway harness. The proof sends a chat message through the GUI, verifies the `chat.send` request, emits a final Gateway reply, and waits for the reply to render in the web chat thread.",
    "",
    "## Artifacts",
    "",
    `- Screenshot: \`web-ui-chat.png\` (${artifactStatus("web-ui-chat.png")})`,
    `- Recording: \`web-ui-chat.webm\` (${artifactStatus("web-ui-chat.webm")})`,
    `- Proof metadata: \`web-ui-chat-proof.json\` (${artifactStatus("web-ui-chat-proof.json")})`,
    `- Vitest log: \`vitest.log\` (${artifactStatus("vitest.log")})`,
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
  const status = normalizeStatus(args.status);
  const manifest = buildWebUiChatEvidenceManifest({
    candidateRef: args.candidate_ref,
    candidateSha: args.candidate_sha,
    status,
  });
  const reportPath = path.join(outputDir, "mantis-report.md");
  writeFileSync(
    reportPath,
    renderReport({
      candidateRef: args.candidate_ref,
      candidateSha: args.candidate_sha,
      outputDir,
      status,
    }),
    "utf8",
  );
  const manifestPath = path.join(outputDir, "mantis-evidence.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
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
