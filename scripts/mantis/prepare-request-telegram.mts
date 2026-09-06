#!/usr/bin/env node
// Secretless exact-source preparation; never acquire a Telegram credential here.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
const [
  candidate,
  baseImage = "localhost/mantis-telegram-proof",
  targetImage = "localhost/mantis-telegram-runtime",
] = process.argv.slice(2);
if (
  !candidate ||
  !/^[a-f0-9]{40}$/.test(candidate) ||
  ![baseImage, targetImage].every((name) => /^[a-z0-9][a-z0-9/.:@-]*$/.test(name))
) {
  throw new Error(
    "Usage: prepare-request-telegram.mts <sha> [trusted-telegram-image] [output-image]",
  );
}
execFileSync(
  "git",
  [
    "diff",
    "--quiet",
    "HEAD",
    candidate,
    "--",
    "package.json",
    ":(glob)**/package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    ".npmrc",
    ".pnpmfile.cjs",
    "patches",
  ],
  { stdio: "pipe" },
);
const name = `mantis-telegram-build-${randomUUID()}`;
const versionName = `mantis-telegram-version-${randomUUID()}`;
const podman = (args: string[], input?: Buffer) =>
  execFileSync("podman", args, { input, maxBuffer: 1024 * 1024 * 1024, timeout: 1200_000 });
try {
  podman([
    "create",
    "--name",
    name,
    "--network",
    "none",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "1024",
    "--memory",
    "16g",
    "--cpus",
    "2",
    "--env",
    `GITHUB_SHA=${candidate}`,
    "--env",
    "OPENCLAW_BUILD_PRIVATE_QA=1",
    "--env",
    "OPENCLAW_TSDOWN_MAX_OLD_SPACE_MB=8192",
    "--workdir",
    "/candidate",
    baseImage,
    "sh",
    "-c",
    "corepack pnpm install --offline --frozen-lockfile && corepack pnpm build && test -s dist/entry.js",
  ]);
  podman(
    ["cp", "-", `${name}:/candidate`],
    execFileSync("git", ["archive", "--format=tar", candidate], { maxBuffer: 1024 * 1024 * 1024 }),
  );
  podman(["start", "--attach", name]);
  const state = JSON.parse(podman(["inspect", "--format", "{{json .State}}", name]).toString());
  if (state.Running || state.ExitCode !== 0) {
    throw new Error("Candidate runtime build failed");
  }
  podman([
    "commit",
    "--change",
    `LABEL org.openclaw.mantis.candidate-sha=${candidate}`,
    "--change",
    "WORKDIR /candidate",
    name,
    targetImage,
  ]);
  podman([
    "run",
    "--name",
    versionName,
    "--memory",
    "8g",
    "--cpus",
    "2",
    "--pids-limit",
    "512",
    "--network",
    "none",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    targetImage,
    "node",
    "dist/entry.js",
    "--version",
  ]);
  console.log(
    JSON.stringify({
      candidate_sha: candidate,
      image: targetImage,
      image_id: podman(["image", "inspect", "--format", "{{.Id}}", targetImage]).toString().trim(),
      runtime_entry: "/candidate/dist/entry.js",
      lease_acquired: false,
    }),
  );
} finally {
  try {
    podman(["rm", "--force", "--ignore", versionName]);
  } finally {
    podman(["rm", "--force", "--ignore", name]);
  }
}
