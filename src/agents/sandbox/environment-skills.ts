import path from "node:path";
import { z } from "zod";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveEffectiveAgentSkillsLimits } from "../../skills/discovery/agent-filter.js";
import {
  resolveSkillInvocationPolicy,
  resolveSkillManifestMetadata,
} from "../../skills/loading/frontmatter.js";
import { parseSkillContent } from "../../skills/loading/local-loader.js";
import type { Skill } from "../../skills/loading/skill-contract.js";
import { formatSkillsForPromptBounded } from "../../skills/loading/skill-prompt-limits.js";
import { buildSkillSnapshot } from "../../skills/loading/workspace-skill-prompt.js";
import type { SkillEntry, SkillSnapshot } from "../../skills/types.js";
import { resolveCodeModeSkills } from "../code-mode-skills.js";
import {
  mapSandboxSkillUsagePaths,
  resolveSandboxSkillRuntimeInputs,
} from "../embedded-agent-runner/sandbox-skills.js";
import type { SandboxCapabilityRootDiscovery } from "./backend-handle.types.js";
import { isPathInsideContainerRoot } from "./path-utils.js";
import type { SandboxContext } from "./types.js";
import { resolveReadOnlyWorkspaceSkillMounts } from "./workspace-mounts.js";

export const MAX_ENVIRONMENT_SKILL_BYTES = 64 * 1024;
const MAX_ENVIRONMENT_SKILLS = 64;

// Probe only names from bounded, parsed requirements. Never return environment values,
// source shell code from a skill, or copy Gateway credentials into the executor.
const REQUIREMENTS_SCRIPT = String.raw`
set -eu
python_bin=$(command -v python3 || command -v python)
"$python_bin" -c '
import json, os, shutil, sys
request = json.loads(sys.argv[1])
print(json.dumps({"platform": sys.platform,
    "bins": [name for name in request["bins"] if shutil.which(name)],
    "env": [name for name in request["env"] if os.environ.get(name, "").strip()]}))
' "$1"
`;
const factsSchema = z.object({
  platform: z.string().min(1).max(32),
  bins: z.array(z.string().max(128)).max(128),
  env: z.array(z.string().max(128)).max(128),
});

/** Prepared exclusions distinguish delivered host resources from executor-owned files. */
export function resolveSandboxEnvironmentSkillExclusions(sandbox: SandboxContext): string[] {
  const inputs = resolveSandboxSkillRuntimeInputs({
    sandbox,
    skillsAnchorWorkspace: sandbox.workspaceDir,
  });
  const delivered = mapSandboxSkillUsagePaths({ ...inputs, paths: sandbox.skillUsagePaths });
  const roots = [
    ...new Set([
      ...resolveReadOnlyWorkspaceSkillMounts({ ...sandbox, workdir: sandbox.containerWorkdir }).map(
        (mount) => mount.containerPath,
      ),
      ...(sandbox.readOnlyResourceMounts ?? []).map((mount) => mount.containerPath),
      ...(delivered ?? []).map((skill) => path.posix.dirname(skill.readPath)),
      path.posix.join(sandbox.containerWorkdir, ".openclaw/sandbox-skills"),
    ]),
  ]
    .filter((root) =>
      isPathInsideContainerRoot(sandbox.backend?.workdir ?? sandbox.containerWorkdir, root),
    )
    .toSorted();
  return roots.filter(
    (root, index) =>
      !roots.slice(0, index).some((parent) => isPathInsideContainerRoot(parent, root)),
  );
}

/** Consume the attempt snapshot shared with MCP; never rediscover roots per consumer. */
export async function prepareSandboxEnvironmentSkills(params: {
  sandbox?: SandboxContext | null;
  discoveries?: readonly SandboxCapabilityRootDiscovery[];
  maxSkillFileBytes?: number;
  signal?: AbortSignal;
  warn: (message: string) => void;
}): Promise<SkillEntry[]> {
  const sandbox = params.sandbox;
  const backend = sandbox?.backend;
  if (
    !sandbox?.enabled ||
    backend?.capabilities?.environment?.capabilityRootDiscovery !== true ||
    !params.discoveries?.length
  ) {
    return [];
  }
  const excluded = resolveSandboxEnvironmentSkillExclusions(sandbox);
  const entries: SkillEntry[] = [];
  let remaining = 1024 * 1024;
  for (const discovery of params.discoveries.slice(0, 8)) {
    if (discovery.error || discovery.path !== backend.workdir) {
      continue;
    }
    for (const { instructions } of (discovery.skills ?? []).slice(0, MAX_ENVIRONMENT_SKILLS)) {
      const filePath = instructions.path;
      const bytes = Buffer.byteLength(instructions.contents);
      if (
        entries.length >= MAX_ENVIRONMENT_SKILLS ||
        bytes >
          Math.min(
            MAX_ENVIRONMENT_SKILL_BYTES,
            params.maxSkillFileBytes ?? MAX_ENVIRONMENT_SKILL_BYTES,
          ) ||
        bytes > remaining ||
        filePath.length > 4096 ||
        !path.posix.isAbsolute(filePath) ||
        path.posix.normalize(filePath) !== filePath ||
        !isPathInsideContainerRoot(discovery.path, filePath) ||
        path.posix.basename(filePath) !== "SKILL.md"
      ) {
        params.warn("Environment skill skipped: file boundary or size limit.");
        continue;
      }
      if (excluded.some((root) => isPathInsideContainerRoot(root, filePath))) {
        continue;
      }
      remaining -= bytes;
      const loaded = parseSkillContent({
        filePath,
        content: instructions.contents,
        source: "openclaw-environment",
        onDiagnostic: () => params.warn("Environment skill skipped: invalid frontmatter."),
      });
      if (!loaded) {
        continue;
      }
      const metadata = resolveSkillManifestMetadata(loaded.frontmatter);
      const requirements = [
        ...(metadata?.requires?.bins ?? []),
        ...(metadata?.requires?.anyBins ?? []),
        ...(metadata?.requires?.env ?? []),
      ];
      if (
        loaded.skill.name.length > 128 ||
        loaded.skill.description.length > 1024 ||
        requirements.length > 128 ||
        requirements.some((name) => !/^[A-Za-z0-9_][A-Za-z0-9_.+-]{0,127}$/u.test(name))
      ) {
        params.warn("Environment skill skipped: metadata or requirement limit.");
        continue;
      }
      entries.push({
        ...loaded,
        metadata,
        invocation: resolveSkillInvocationPolicy(loaded.frontmatter),
        disableCommandDispatch: true,
      });
    }
  }
  if (entries.length === 0) {
    return [];
  }
  const bins = [
    ...new Set(
      entries.flatMap((entry) => [
        ...(entry.metadata?.requires?.bins ?? []),
        ...(entry.metadata?.requires?.anyBins ?? []),
      ]),
    ),
  ].toSorted();
  const env = [
    ...new Set(entries.flatMap((entry) => entry.metadata?.requires?.env ?? [])),
  ].toSorted();
  // Bound probe payloads across all skills. Unprobed requirements remain unsatisfied.
  if (bins.length > 128 || env.length > 128) {
    params.warn("Environment skill requirements truncated to the probe budget.");
    bins.length = Math.min(bins.length, 128);
    env.length = Math.min(env.length, 128);
  }
  try {
    params.signal?.throwIfAborted();
    const result = await backend.runShellCommand({
      script: REQUIREMENTS_SCRIPT,
      args: [JSON.stringify({ bins, env })],
      signal: params.signal,
      allowFailure: true,
    });
    params.signal?.throwIfAborted();
    if (result.code !== 0 || result.stdout.length > 64 * 1024) {
      throw new Error("requirements probe failed");
    }
    const facts = factsSchema.parse(JSON.parse(result.stdout.toString("utf8")));
    for (const entry of entries) {
      entry.environment = facts;
    }
    return entries;
  } catch {
    params.signal?.throwIfAborted();
    params.warn("Environment skills unavailable: runtime requirements probe failed.");
    return [];
  }
}

/** Keep explicit/native skills first and apply the existing policy and formatter to additions. */
export function mergeSandboxEnvironmentSkillCatalog(params: {
  skillsPrompt: string;
  candidates: Skill[];
  environmentEntries: SkillEntry[];
  config?: OpenClawConfig;
  agentId: string;
  workspaceDir: string;
  snapshot?: SkillSnapshot;
  remoteNote?: string;
  warn: (message: string) => void;
}): { skillsPrompt: string; candidates: Skill[] } {
  if (params.environmentEntries.length === 0) {
    return params;
  }
  const nativeByName = new Map(params.candidates.map((skill) => [skill.name, skill]));
  const used = new Set(nativeByName.keys());
  const uniqueEntries = params.environmentEntries
    .toSorted((a, b) => a.skill.filePath.localeCompare(b.skill.filePath, "en"))
    .filter((entry) => {
      if (used.has(entry.skill.name)) {
        params.warn("Environment skill name collision: keeping the existing skill.");
        return false;
      }
      used.add(entry.skill.name);
      return true;
    });
  const environment = buildSkillSnapshot(params.workspaceDir, {
    entries: uniqueEntries,
    config: params.config,
    agentId: params.agentId,
    skillFilter: params.snapshot?.skillFilter,
    skillOverrides: params.snapshot?.skillOverrides,
  });
  // The native owner already mapped candidates to sandbox paths; retain those prepared facts.
  const native = resolveCodeModeSkills(params).map((skill) => nativeByName.get(skill.name)!);
  const candidates = [...native, ...(environment.resolvedSkills ?? [])];
  const limits = params.config?.skills?.limits;
  const agentLimits = resolveEffectiveAgentSkillsLimits(params.config, params.agentId);
  return {
    candidates,
    // Environment catalogs add at most 4K characters; full instruction bodies remain on demand.
    skillsPrompt: formatSkillsForPromptBounded({
      skills: candidates,
      remoteNote: params.remoteNote,
      preserveOrder: true,
      maxSkillsInPrompt: limits?.maxSkillsInPrompt,
      maxSkillsPromptChars: Math.min(
        agentLimits?.maxSkillsPromptChars ?? limits?.maxSkillsPromptChars ?? 18_000,
        params.skillsPrompt.length + 4096,
      ),
    }),
  };
}
