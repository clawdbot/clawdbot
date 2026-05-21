import fs from "node:fs/promises";
import path from "node:path";
import { sanitizeHostExecEnv } from "../infra/host-env-security.js";
import { withTempDir } from "../infra/install-source-utils.js";
import { writeJson } from "../infra/json-files.js";
import { parseGitPluginSpec } from "../plugins/git-install.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { redactSensitiveUrlLikeString } from "../shared/net/redact-sensitive-url.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { sanitizeForLog } from "../terminal/ansi.js";
import { resolveUserPath } from "../utils.js";
import { installExtractedSkillRoot, validateRequestedSkillSlug } from "./skills-archive-install.js";
import { untrackClawHubSkill } from "./skills-clawhub.js";
import { parseFrontmatter } from "./skills/frontmatter.js";

type Logger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
};

type SkillSourceOrigin = {
  version: 1;
  source: "path" | "git";
  spec: string;
  slug: string;
  installedAt: number;
  git?: {
    url: string;
    ref?: string;
    commit?: string;
    resolvedAt: string;
  };
};

export type SkillSourceInstallResult =
  | {
      ok: true;
      slug: string;
      targetDir: string;
      source: "path" | "git";
      git?: SkillSourceOrigin["git"];
    }
  | { ok: false; error: string };

const SKILL_SOURCE_ORIGIN_RELATIVE_PATH = path.join(".openclaw", "source-origin.json");
const DEFAULT_GIT_TIMEOUT_MS = 120_000;

function createGitCommandEnv(): NodeJS.ProcessEnv {
  return sanitizeHostExecEnv({
    baseEnv: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
    blockPathOverrides: false,
  });
}

function formatGitCommandFailure(params: {
  action: string;
  label: string;
  stdout: string;
  stderr: string;
}): string {
  const detail = sanitizeForLog(
    redactSensitiveUrlLikeString(params.stderr.trim() || params.stdout.trim() || "git failed"),
  );
  return `failed to ${params.action} ${sanitizeForLog(redactSensitiveUrlLikeString(params.label))}: ${detail}`;
}

async function runGitCommand(params: {
  argv: string[];
  action: string;
  label: string;
  cwd?: string;
  timeoutMs?: number;
}): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
  const result = await runCommandWithTimeout(params.argv, {
    baseEnv: {},
    cwd: params.cwd,
    timeoutMs: params.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
    env: createGitCommandEnv(),
  });
  if (result.code !== 0) {
    return {
      ok: false,
      error: formatGitCommandFailure({
        action: params.action,
        label: params.label,
        stdout: result.stdout,
        stderr: result.stderr,
      }),
    };
  }
  return { ok: true, stdout: result.stdout };
}

async function resolveGitCommitish(params: {
  repoDir: string;
  ref: string;
  label: string;
  timeoutMs?: number;
}): Promise<{ ok: true; commitish: string } | { ok: false; error: string }> {
  const candidates = params.ref.startsWith("origin/")
    ? [params.ref]
    : [params.ref, `origin/${params.ref}`];
  for (const candidate of candidates) {
    const resolved = await runCommandWithTimeout(
      ["git", "rev-parse", "--verify", "--quiet", `${candidate}^{commit}`],
      {
        baseEnv: {},
        cwd: params.repoDir,
        timeoutMs: params.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
        env: createGitCommandEnv(),
      },
    );
    const commit = normalizeOptionalString(resolved.stdout);
    if (resolved.code === 0 && commit) {
      return { ok: true, commitish: commit };
    }
  }

  return {
    ok: false,
    error: `failed to resolve ref ${sanitizeForLog(redactSensitiveUrlLikeString(params.ref))} in ${sanitizeForLog(redactSensitiveUrlLikeString(params.label))}`,
  };
}

async function readSkillNameFromFrontmatter(skillDir: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(skillDir, "SKILL.md"), "utf8");
    const frontmatter = parseFrontmatter(raw);
    return normalizeOptionalString(frontmatter.name) ?? null;
  } catch {
    return null;
  }
}

function resolveFallbackSlugFromPath(sourcePath: string): string {
  return path.basename(path.resolve(sourcePath)).trim();
}

async function resolveSkillInstallSlug(params: {
  sourceDir: string;
  fallbackLabel: string;
  slug?: string;
}): Promise<string> {
  const explicit = normalizeOptionalString(params.slug);
  if (explicit) {
    return validateRequestedSkillSlug(explicit);
  }

  const frontmatterName = await readSkillNameFromFrontmatter(params.sourceDir);
  if (frontmatterName) {
    try {
      return validateRequestedSkillSlug(frontmatterName);
    } catch {
      // Fall back to the source label when the display name is not a valid install slug.
    }
  }

  return validateRequestedSkillSlug(params.fallbackLabel);
}

async function writeSkillSourceOrigin(targetDir: string, origin: SkillSourceOrigin): Promise<void> {
  await writeJson(path.join(targetDir, SKILL_SOURCE_ORIGIN_RELATIVE_PATH), origin, {
    trailingNewline: true,
  });
}

async function removeClawHubInstallMetadata(targetDir: string): Promise<void> {
  await Promise.all([
    fs.rm(path.join(targetDir, ".clawhub"), { recursive: true, force: true }),
    fs.rm(path.join(targetDir, ".clawdhub"), { recursive: true, force: true }),
  ]);
}

async function copyGitWorktreeExport(params: {
  repoDir: string;
  exportDir: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await fs.cp(params.repoDir, params.exportDir, {
      recursive: true,
      filter: (source) => !path.relative(params.repoDir, source).split(path.sep).includes(".git"),
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `failed to prepare git skill source: ${String(err)}` };
  }
}

async function installLocalSkillDir(params: {
  workspaceDir: string;
  sourceDir: string;
  sourceSpec: string;
  source: "path" | "git";
  fallbackLabel: string;
  slug?: string;
  force?: boolean;
  timeoutMs?: number;
  logger?: Logger;
  git?: SkillSourceOrigin["git"];
}): Promise<SkillSourceInstallResult> {
  const slug = await resolveSkillInstallSlug({
    sourceDir: params.sourceDir,
    fallbackLabel: params.fallbackLabel,
    slug: params.slug,
  });
  const install = await installExtractedSkillRoot({
    workspaceDir: params.workspaceDir,
    slug,
    extractedRoot: params.sourceDir,
    mode: params.force ? "update" : "install",
    timeoutMs: params.timeoutMs,
    logger: params.logger,
    scan: {
      installId: params.source,
      origin: params.sourceSpec,
    },
  });
  if (!install.ok) {
    return { ok: false, error: install.error };
  }

  await removeClawHubInstallMetadata(install.targetDir);
  await writeSkillSourceOrigin(install.targetDir, {
    version: 1,
    source: params.source,
    spec: params.sourceSpec,
    slug,
    installedAt: Date.now(),
    ...(params.git ? { git: params.git } : {}),
  });
  await untrackClawHubSkill(params.workspaceDir, slug);

  return {
    ok: true,
    slug,
    targetDir: install.targetDir,
    source: params.source,
    ...(params.git ? { git: params.git } : {}),
  };
}

async function installGitSkill(params: {
  workspaceDir: string;
  spec: string;
  slug?: string;
  force?: boolean;
  timeoutMs?: number;
  logger?: Logger;
}): Promise<SkillSourceInstallResult> {
  const parsed = parseGitPluginSpec(params.spec);
  if (!parsed) {
    return { ok: false, error: `Unsupported git skill spec: ${params.spec}` };
  }

  return await withTempDir("openclaw-git-skill-", async (tmpDir) => {
    const repoDir = path.join(tmpDir, "repo");
    const exportDir = path.join(tmpDir, "export");
    params.logger?.info?.(
      `Cloning ${sanitizeForLog(redactSensitiveUrlLikeString(parsed.label))}...`,
    );
    const cloneArgs = parsed.ref
      ? ["git", "clone", parsed.url, repoDir]
      : ["git", "clone", "--depth", "1", parsed.url, repoDir];
    const clone = await runGitCommand({
      argv: cloneArgs,
      action: "clone",
      label: parsed.label,
      timeoutMs: params.timeoutMs,
    });
    if (!clone.ok) {
      return clone;
    }

    if (parsed.ref) {
      const commitish = await resolveGitCommitish({
        repoDir,
        ref: parsed.ref,
        label: parsed.label,
        timeoutMs: params.timeoutMs,
      });
      if (!commitish.ok) {
        return commitish;
      }
      const checkout = await runGitCommand({
        argv: ["git", "switch", "--detach", "--", commitish.commitish],
        action: `checkout ${parsed.ref}`,
        label: parsed.label,
        cwd: repoDir,
        timeoutMs: params.timeoutMs,
      });
      if (!checkout.ok) {
        return checkout;
      }
    }

    const rev = await runGitCommand({
      argv: ["git", "rev-parse", "HEAD"],
      action: "resolve commit for",
      label: parsed.label,
      cwd: repoDir,
      timeoutMs: params.timeoutMs,
    });
    if (!rev.ok) {
      return rev;
    }

    const git = {
      url: redactSensitiveUrlLikeString(parsed.url),
      ...(parsed.ref ? { ref: parsed.ref } : {}),
      commit: normalizeOptionalString(rev.stdout),
      resolvedAt: new Date().toISOString(),
    };
    const exported = await copyGitWorktreeExport({ repoDir, exportDir });
    if (!exported.ok) {
      return exported;
    }

    return await installLocalSkillDir({
      workspaceDir: params.workspaceDir,
      sourceDir: exportDir,
      sourceSpec: redactSensitiveUrlLikeString(parsed.normalizedSpec),
      source: "git",
      fallbackLabel: path.basename(parsed.label),
      slug: params.slug,
      force: params.force,
      timeoutMs: params.timeoutMs,
      logger: params.logger,
      git,
    });
  });
}

async function installPathSkill(params: {
  workspaceDir: string;
  spec: string;
  slug?: string;
  force?: boolean;
  timeoutMs?: number;
  logger?: Logger;
}): Promise<SkillSourceInstallResult> {
  const sourceDir = resolveUserPath(params.spec);
  let stat;
  try {
    stat = await fs.stat(sourceDir);
  } catch {
    return { ok: false, error: `Skill path not found: ${sourceDir}` };
  }
  if (!stat.isDirectory()) {
    return { ok: false, error: `Skill path is not a directory: ${sourceDir}` };
  }
  return await installLocalSkillDir({
    workspaceDir: params.workspaceDir,
    sourceDir,
    sourceSpec: params.spec,
    source: "path",
    fallbackLabel: resolveFallbackSlugFromPath(sourceDir),
    slug: params.slug,
    force: params.force,
    timeoutMs: params.timeoutMs,
    logger: params.logger,
  });
}

export function isSkillSourceInstallSpec(raw: string): boolean {
  const trimmed = raw.trim();
  return (
    trimmed.toLowerCase().startsWith("git:") ||
    trimmed.startsWith("./") ||
    trimmed.startsWith("../") ||
    trimmed.startsWith("~/") ||
    path.isAbsolute(trimmed)
  );
}

export async function installSkillFromSource(params: {
  workspaceDir: string;
  spec: string;
  slug?: string;
  force?: boolean;
  timeoutMs?: number;
  logger?: Logger;
}): Promise<SkillSourceInstallResult> {
  const spec = params.spec.trim();
  if (spec.toLowerCase().startsWith("git:")) {
    return await installGitSkill({ ...params, spec });
  }
  return await installPathSkill({ ...params, spec });
}
