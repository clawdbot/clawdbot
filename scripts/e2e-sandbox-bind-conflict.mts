/**
 * End-to-end verification: protected skill mounts keep authority; conflicting
 * user binds are skipped to prevent duplicate mount destination errors.
 *
 * Prerequisites: Docker or Podman, Node >=22.19, pnpm install, and the selected image.
 * Usage:
 *   OPENCLAW_SANDBOX_E2E_ENGINE=podman \
 *   OPENCLAW_SANDBOX_E2E_IMAGE=alpine:3.24 \
 *   node --import tsx scripts/e2e-sandbox-bind-conflict.mts
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveRepoRoot } from "./lib/repo-root.mjs";

type WorkspaceMountModule = Pick<
  typeof import("../src/agents/sandbox/workspace-mounts.js"),
  | "resolveReadOnlyWorkspaceSkillMounts"
  | "resolveProtectedSkillMountContainerPaths"
  | "filterBindsConflictingWithProtectedMounts"
>;

const repoRoot = resolveRepoRoot(import.meta.url);
const engine = process.env.OPENCLAW_SANDBOX_E2E_ENGINE?.trim() || "docker";
const image = process.env.OPENCLAW_SANDBOX_E2E_IMAGE?.trim() || "e2e-sleep:latest";
const useSudo = process.env.OPENCLAW_SANDBOX_E2E_SUDO === "1";
if (engine !== "docker" && engine !== "podman") {
  throw new Error(`Unsupported container engine "${engine}". Use docker or podman.`);
}

const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-e2e-"));
const skillsDir = path.join(workspaceDir, "skills", "demo");
fs.mkdirSync(skillsDir, { recursive: true });
fs.writeFileSync(path.join(skillsDir, "SKILL.md"), "# E2E demo\n");
console.log("Workspace:", workspaceDir);

const customBindHost = path.join(workspaceDir, "custom-mount");
fs.mkdirSync(customBindHost, { recursive: true });
fs.writeFileSync(path.join(customBindHost, "data.txt"), "user data\n");

const userBinds = [`${customBindHost}:/workspace/skills:rw`];
const containerName = `oc-e2e-${engine}-bind-${Date.now()}`.slice(0, 63);

let failureCount = 0;
function fail(label: string) {
  console.log(`❌ FAIL: ${label}`);
  failureCount += 1;
}
function pass(label: string) {
  console.log(`✅ ${label}`);
}

// ── Load production code ──────────────────────────────────────────────
const {
  resolveReadOnlyWorkspaceSkillMounts,
  resolveProtectedSkillMountContainerPaths,
  filterBindsConflictingWithProtectedMounts,
}: WorkspaceMountModule = await import(
  path.join(repoRoot, "src/agents/sandbox/workspace-mounts.js")
);

// ── Resolve protected skill mounts ────────────────────────────────────
console.log("\n--- Protected skill mounts ---");
const protectedMounts = resolveReadOnlyWorkspaceSkillMounts({
  workspaceDir,
  agentWorkspaceDir: workspaceDir,
  workdir: "/workspace",
  workspaceAccess: "rw",
});
console.log(
  "Protected:",
  protectedMounts.map((m) => `${m.hostPath} -> ${m.containerPath}`),
);

// ── Resolve protected container paths ─────────────────────────────────
const protectedPaths = resolveProtectedSkillMountContainerPaths(protectedMounts);
console.log("Protected paths:", [...protectedPaths]);

// ── Filter user binds ─────────────────────────────────────────────────
console.log("\nUser binds:", userBinds);
const safeBinds = filterBindsConflictingWithProtectedMounts(userBinds, protectedPaths);
console.log(
  "Safe binds (after skipping conflicts):",
  safeBinds.length === 0 ? "(none)" : safeBinds,
);

// Conflicting bind should be filtered out (no safe binds remain)
if (safeBinds.length > 0) {
  fail("conflicting user bind was not filtered out");
} else {
  pass("conflicting user bind correctly skipped");
}

// ── Build container create args ───────────────────────────────────────
const createArgs = [
  "create",
  "--name",
  containerName,
  "--label",
  "openclaw.e2e=1",
  "--workdir",
  "/workspace",
  "-v",
  `${workspaceDir}:/workspace`,
  ...safeBinds.flatMap((b) => ["-v", b]),
];
// Protected skill mounts always appended (authoritative, read-only)
for (const m of protectedMounts) {
  createArgs.push("-v", `${m.hostPath}:${m.containerPath}:ro`);
}
createArgs.push(image, "sleep", "infinity");

// ── Duplicate check ───────────────────────────────────────────────────
console.log(`\n--- ${engine} args ---`);
let nextIsMount = false;
for (const a of createArgs) {
  if (nextIsMount) {
    console.log(`  -v ${a}`);
    nextIsMount = false;
  } else if (a === "-v") {
    nextIsMount = true;
  } else if (a.startsWith("-")) {
    console.log(`  ${a}`);
  } else {
    console.log(`  ${a}`);
  }
}

console.log("\n--- Duplicate check ---");
const seen = new Map<string, string>();
let dupes = 0;
for (let i = 0; i < createArgs.length - 1; i++) {
  if (createArgs[i] !== "-v") {
    continue;
  }
  const mountArg = createArgs[i + 1] ?? "";
  const [, cpath] = mountArg.split(":");
  if (!cpath) {
    continue;
  }
  if (seen.has(cpath)) {
    console.log(`❌ DUPLICATE: ${cpath}`);
    dupes++;
  } else {
    seen.set(cpath, mountArg);
  }
}
if (dupes === 0) {
  console.log("✅ No duplicate container paths in -v args");
} else {
  fail(`found ${dupes} duplicate container paths`);
}

// ── Helper: run the selected engine with argv (no shell string) ───────
function runEngine(args: string[], opts: { stdio?: "pipe" | "inherit" } = {}) {
  return spawnSync(useSudo ? "sudo" : engine, useSudo ? [engine, ...args] : args, {
    encoding: "utf8",
    timeout: 30_000,
    ...opts,
  });
}

// ── Container create ──────────────────────────────────────────────────
console.log(`\n--- ${engine} create ${containerName} ---`);
let created = false;
try {
  const result = runEngine(createArgs, { stdio: "pipe" });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw Object.assign(
      new Error(result.stderr?.trim() || `docker create exited ${result.status}`),
      { code: result.status, stdout: result.stdout, stderr: result.stderr },
    );
  }
  created = true;
  pass(`Container created with ${engine} without duplicate mount destinations`);

  const inspectResult = runEngine(["inspect", containerName]);
  if (inspectResult.error) {
    throw inspectResult.error;
  }
  if (inspectResult.status !== 0) {
    throw Object.assign(new Error(`inspect exited ${inspectResult.status}`), {
      stderr: inspectResult.stderr,
    });
  }
  const inspected: unknown = JSON.parse(inspectResult.stdout);
  const inspectedContainer = Array.isArray(inspected) ? inspected[0] : undefined;
  const mounts =
    isRecord(inspectedContainer) && Array.isArray(inspectedContainer.Mounts)
      ? inspectedContainer.Mounts.filter(isRecord)
      : [];
  const dests = mounts
    .map((mount) => mount.Destination)
    .filter((destination): destination is string => typeof destination === "string");
  const skillsCount = dests.filter((d) => d === "/workspace/skills").length;
  console.log(`Mount destinations: ${dests.join(" ")}`);
  console.log(`/workspace/skills count: ${skillsCount}`);
  if (skillsCount <= 1) {
    pass("/workspace/skills appears at most once");
  } else {
    fail(`/workspace/skills appears ${skillsCount} times (expected ≤1)`);
  }

  // Verify protected mount source (not user bind)
  const skillMount = mounts.find((mount) => mount.Destination === "/workspace/skills");
  const mountSrc = typeof skillMount?.Source === "string" ? skillMount.Source : "";
  console.log(`Mount source for /workspace/skills: ${mountSrc}`);
  const isReadOnly = skillMount?.RW === false;
  const isProtectedSource = mountSrc === path.join(workspaceDir, "skills");
  if (isReadOnly) {
    pass("mount is read-only");
  } else {
    fail("mount is NOT read-only");
  }
  if (isProtectedSource) {
    pass("mount source is the protected skill directory");
  } else {
    fail("mount source is NOT the protected skill directory");
  }
} catch (err) {
  const engineError = isRecord(err) ? err : {};
  const msg = engineError.stderr ? String(engineError.stderr) : String(engineError.message ?? err);
  if (msg.includes("Duplicate mount point") || msg.includes("duplicate mount")) {
    fail(`Duplicate mount point rejected by ${engine}`);
    console.log(msg.slice(0, 500));
  } else {
    console.log(`❌ Error: ${msg.slice(0, 500)}`);
    fail(msg.slice(0, 200));
  }
} finally {
  if (created) {
    runEngine(["rm", "-f", containerName]);
  }
  fs.rmSync(workspaceDir, { recursive: true, force: true });
}

console.log(
  failureCount > 0 ? `\n❌ Done. ${failureCount} failure(s)` : "\n✅ Done. All checks passed.",
);
process.exitCode = failureCount > 0 ? 1 : 0;
