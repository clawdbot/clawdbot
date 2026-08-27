import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { sha256Hex } from "../../infra/crypto-digest.js";
import { resolveWorkspaceSkillInstallDir } from "./archive-install.js";
import { resolveClawHubSkillStatusLinkSync } from "./clawhub-status.js";
import {
  formatClawHubSkillRef,
  parseRequestedClawHubSkillRef,
  untrackClawHubSkill,
} from "./clawhub-store.js";
import {
  dispatchCommittedSkillChangeBestEffort,
  hasCommittedSkillChangeHooks,
  snapshotCommittedSkillArtifactBestEffort,
} from "./skill-change-hook.js";
import { digestClawHubSkillTree } from "./skill-tree-digest.js";

export type ClawHubSkillUninstallPlan = {
  workspaceDir: string;
  // Replan from the registry identity so publisher/source changes cannot retarget deletion.
  requestedRef: string;
  slug: string;
  version: string;
  installedAt: number;
  targetDir: string;
  skillFilePath: string;
  skillFileSha256: string;
  fileTreeSha256: string;
};

type ClawHubSkillUninstallPlanResult =
  | { ok: true; plan: ClawHubSkillUninstallPlan }
  | {
      ok: false;
      code: "missing" | "ambiguous" | "modified";
      error: string;
    };

export async function planClawHubSkillUninstall(params: {
  workspaceDir: string;
  slug: string;
  expectedVersion: string;
}): Promise<ClawHubSkillUninstallPlanResult> {
  let requestedRef: ReturnType<typeof parseRequestedClawHubSkillRef>;
  try {
    requestedRef = parseRequestedClawHubSkillRef(params.slug);
  } catch (error) {
    return { ok: false, code: "ambiguous", error: String(error) };
  }
  return await planTrackedClawHubSkillState({
    workspaceDir: params.workspaceDir,
    requestedRef,
    expectedVersion: params.expectedVersion,
  });
}

export async function planTrackedClawHubSkillState(params: {
  workspaceDir: string;
  requestedRef: ReturnType<typeof parseRequestedClawHubSkillRef>;
  expectedVersion: string;
}): Promise<ClawHubSkillUninstallPlanResult> {
  const requestedRef = params.requestedRef;
  const slug = requestedRef.slug;
  const targetDir = resolveWorkspaceSkillInstallDir(params.workspaceDir, slug);
  const link = resolveClawHubSkillStatusLinkSync({
    workspaceDir: params.workspaceDir,
    skillDir: targetDir,
    skillKey: slug,
  });
  if (!link) {
    return {
      ok: false,
      code: "missing",
      error: `Skill ${JSON.stringify(slug)} is not a tracked ClawHub install.`,
    };
  }
  if (!link.valid || !link.skillFile || !link.fileTreeSha256) {
    return {
      ok: false,
      code: "ambiguous",
      error: link.valid
        ? `Skill ${JSON.stringify(slug)} was installed before OpenClaw recorded file fingerprints, so local changes cannot be detected.`
        : link.reason,
    };
  }
  if (requestedRef.ownerHandle && link.ownerHandle !== requestedRef.ownerHandle) {
    const trackedRef = link.ownerHandle ? `@${link.ownerHandle}/${slug}` : slug;
    return {
      ok: false,
      code: "ambiguous",
      error: `Skill ${JSON.stringify(slug)} is tracked as ${trackedRef}, not @${requestedRef.ownerHandle}/${slug}.`,
    };
  }
  if (
    requestedRef.requestedReference &&
    link.requestedReference !== requestedRef.requestedReference
  ) {
    return {
      ok: false,
      code: "ambiguous",
      error: `Skill ${JSON.stringify(slug)} is not tracked from ${requestedRef.requestedReference}.`,
    };
  }
  if (link.installedVersion !== params.expectedVersion) {
    return {
      ok: false,
      code: "modified",
      error: `Skill ${JSON.stringify(slug)} is at ${link.installedVersion}, expected ${params.expectedVersion}.`,
    };
  }
  const skillFilePath = path.join(targetDir, link.skillFile.path);
  let content: Buffer;
  try {
    const stat = await fs.lstat(targetDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return {
        ok: false,
        code: "ambiguous",
        error: `Skill ${JSON.stringify(slug)} is not a regular managed directory.`,
      };
    }
    content = await fs.readFile(skillFilePath);
  } catch (error) {
    return { ok: false, code: "missing", error: String(error) };
  }
  if (sha256Hex(content) !== link.skillFile.sha256) {
    return {
      ok: false,
      code: "modified",
      error: `Skill ${JSON.stringify(slug)} has local SKILL.md changes.`,
    };
  }
  let fileTreeSha256: string;
  try {
    fileTreeSha256 = await digestClawHubSkillTree(targetDir);
  } catch (error) {
    return { ok: false, code: "ambiguous", error: String(error) };
  }
  if (fileTreeSha256 !== link.fileTreeSha256) {
    return {
      ok: false,
      code: "modified",
      error: `Skill ${JSON.stringify(slug)} has local file changes.`,
    };
  }
  return {
    ok: true,
    plan: {
      workspaceDir: params.workspaceDir,
      requestedRef: requestedRef.requestedReference ?? formatClawHubSkillRef(requestedRef),
      slug,
      version: link.installedVersion,
      installedAt: link.installedAt,
      targetDir,
      skillFilePath: link.skillFile.path,
      skillFileSha256: link.skillFile.sha256,
      fileTreeSha256,
    },
  };
}

export async function checkClawHubSkillPlanAtPath(
  plan: ClawHubSkillUninstallPlan,
  skillDir: string,
  readFile: typeof fs.readFile = fs.readFile,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const stat = await fs.lstat(skillDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return { ok: false, error: `Skill ${JSON.stringify(plan.slug)} changed during update.` };
    }
    const content = await readFile(path.join(skillDir, plan.skillFilePath));
    if (
      sha256Hex(content) !== plan.skillFileSha256 ||
      (await digestClawHubSkillTree(skillDir)) !== plan.fileTreeSha256
    ) {
      return { ok: false, error: `Skill ${JSON.stringify(plan.slug)} changed during update.` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

export async function applyClawHubSkillUninstall(
  plan: ClawHubSkillUninstallPlan,
  deps: {
    readFile?: typeof fs.readFile;
    removeDir?: typeof fs.rm;
    rename?: typeof fs.rename;
    untrack?: typeof untrackClawHubSkill;
  } = {},
): Promise<{ ok: true } | { ok: false; error: string }> {
  const current = await planClawHubSkillUninstall({
    workspaceDir: plan.workspaceDir,
    slug: plan.requestedRef,
    expectedVersion: plan.version,
  });
  if (!current.ok) {
    return { ok: false, error: current.error };
  }
  const shouldDispatchChange = hasCommittedSkillChangeHooks();
  const before = shouldDispatchChange
    ? await snapshotCommittedSkillArtifactBestEffort({
        skillDir: plan.targetDir,
        skillKey: plan.slug,
        source: "clawhub",
        sourceVersion: plan.version,
      })
    : undefined;
  const stagedDir = `${plan.targetDir}.openclaw-skill-remove-${randomUUID()}`;
  let staged = false;
  let restoreTracking: (() => Promise<void>) | undefined;
  const rename = deps.rename ?? fs.rename;
  try {
    await rename(plan.targetDir, stagedDir);
    staged = true;
    const stagedPlan = await checkClawHubSkillPlanAtPath(
      plan,
      stagedDir,
      deps.readFile ?? fs.readFile,
    );
    if (!stagedPlan.ok) {
      await rename(stagedDir, plan.targetDir);
      return { ok: false, error: `Skill ${JSON.stringify(plan.slug)} changed during removal.` };
    }
    restoreTracking = await (deps.untrack ?? untrackClawHubSkill)(plan.workspaceDir, plan.slug);
    await (deps.removeDir ?? fs.rm)(stagedDir, { recursive: true, force: false });
    if (shouldDispatchChange) {
      await dispatchCommittedSkillChangeBestEffort({
        action: "removed",
        source: "clawhub",
        workspaceDir: plan.workspaceDir,
        before,
      });
    }
    return { ok: true };
  } catch (error) {
    const rollbackErrors: string[] = [];
    try {
      await restoreTracking?.();
    } catch (rollbackError) {
      rollbackErrors.push(`could not restore lockfile: ${String(rollbackError)}`);
    }
    if (staged) {
      try {
        await rename(stagedDir, plan.targetDir);
      } catch (rollbackError) {
        rollbackErrors.push(`could not restore skill directory: ${String(rollbackError)}`);
      }
    }
    return {
      ok: false,
      error: `${String(error)}${rollbackErrors.length > 0 ? `; rollback incomplete: ${rollbackErrors.join("; ")}` : ""}`,
    };
  }
}
