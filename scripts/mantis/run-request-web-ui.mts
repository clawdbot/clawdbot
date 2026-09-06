#!/usr/bin/env node
// Host orchestration only: candidate processes never receive host mounts.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assertPodmanProofStorage } from "./telegram-proof-storage.mts";

const [candidate, outputArg, image = "localhost/mantis-request-proof"] = process.argv.slice(2);
if (
  !candidate ||
  !/^[a-f0-9]{40}$/.test(candidate) ||
  !outputArg ||
  process.argv.length > 5 ||
  !/^[a-z0-9][a-z0-9/.:@-]*$/.test(image)
) {
  throw new Error(
    "Usage: run-request-web-ui.mts <candidate-sha> <fresh-output> [trusted-podman-image]",
  );
}
// The harness owns dependency installation. A candidate with different install
// inputs needs another scenario; testing it with baseline packages could lie.
try {
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
} catch {
  throw new Error(
    "Cannot verify matching candidate/harness dependency inputs. This scenario requires unchanged manifests, lockfile, workspace configuration, and patches; no candidate code was executed.",
  );
}
assertPodmanProofStorage();
const output = path.resolve(outputArg);
mkdirSync(path.dirname(output), { recursive: true });
mkdirSync(output);
chmodSync(output, 0o777); // Disposable, secretless artifact directory for container UID 1001.
const scratch = mkdtempSync(path.join(path.dirname(output), "request-build-"));
const name = `mantis-candidate-${randomUUID()}`;
const observer = `mantis-observer-${randomUUID()}`;
const restrictions = [
  "--network",
  "none",
  "--cap-drop",
  "ALL",
  "--security-opt",
  "no-new-privileges",
  "--pids-limit",
  "512",
  "--memory",
  "8g",
];
function container(args: string[], options: { input?: Buffer; timeout?: number } = {}) {
  return execFileSync("podman", args, {
    maxBuffer: 300 * 1024 * 1024,
    timeout: options.timeout ?? 120_000,
    ...options,
  });
}
try {
  // All source overlays are inside a stopped disposable container. The image
  // has only trusted dependencies in /candidate, not fallback baseline source.
  container([
    "create",
    "--name",
    name,
    ...restrictions,
    // Match the canonical mock Gateway build identity, not a live-server claim.
    "--env",
    "OPENCLAW_CONTROL_UI_BUILD_ID=e2e",
    "--env",
    `GITHUB_SHA=${candidate}`,
    "--workdir",
    "/candidate",
    image,
    "sh",
    "-c",
    // Re-run candidate install hooks too, but only with the preloaded store and
    // inside the restricted container. Baseline-generated state is not proof.
    "corepack pnpm install --offline --frozen-lockfile && cd ui && node ../scripts/run-node-package-bin.mts vite build",
  ]);
  const source = execFileSync("git", ["archive", "--format=tar", candidate], {
    maxBuffer: 1024 * 1024 * 1024,
  });
  container(["cp", "-", `${name}:/candidate`], { input: source });
  container(["start", "--attach", name], { timeout: 20 * 60_000 });
  const state = JSON.parse(container(["inspect", "--format", "{{json .State}}", name]).toString());
  if (state.Running || state.ExitCode !== 0) {
    throw new Error("Candidate build did not complete successfully");
  }
  const archive = path.join(scratch, "bundle.tar");
  writeFileSync(archive, container(["cp", `${name}:/candidate/dist/control-ui/.`, "-"]));
  const bundle = path.join(scratch, "bundle");
  execFileSync(
    "python3",
    ["-I", "-S", "scripts/mantis/read-request-archive.py", "bundle", archive, bundle],
    { timeout: 60_000 },
  );
  chmodSync(scratch, 0o755);
  chmodSync(bundle, 0o755);
  // Fresh observer image: no candidate runner, configuration, hooks or writes.
  // Browser sandbox stays enabled; its process has no external network.
  container(
    [
      "run",
      "--name",
      observer,
      ...restrictions,
      // Default container seccomp permits chroot with this capability. Chromium
      // needs it inside its user namespace; never disable the browser sandbox.
      "--cap-add",
      "SYS_CHROOT",
      "--read-only",
      "--user",
      "pwuser",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,size=1g",
      "--shm-size",
      "1g",
      "--mount",
      `type=bind,source=${bundle},target=/bundle,readonly`,
      "--mount",
      `type=bind,source=${output},target=/out`,
      image,
      "node",
      "--import",
      "tsx",
      "scripts/mantis/observe-request-web-ui.mts",
      "/bundle",
      "/out",
    ],
    { timeout: 120_000 },
  );
  // A zero exit without complete retained observations is not a proof.
  JSON.parse(readFileSync(path.join(output, "observer.json"), "utf8"));
} finally {
  for (const owned of [observer, name]) {
    try {
      container(["rm", "--force", owned]);
    } catch {
      console.error(`Cleanup requires checking owned container ${owned}`);
    }
  }
  rmSync(scratch, { recursive: true, force: true });
}
