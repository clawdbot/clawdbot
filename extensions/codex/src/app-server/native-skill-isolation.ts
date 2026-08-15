import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveRequiredHomeDir, resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import type { CodexAppServerClient } from "./client.js";
import type { JsonObject, JsonValue } from "./protocol.js";

export type CodexNativeSkillIsolation = {
  disabledUserSkillPaths: string[];
};

const MAX_PERSONAL_SKILL_DIRECTORIES = 2_000;
const MAX_PERSONAL_SKILL_DEPTH = 6;
const MAX_PERSONAL_SKILL_ENTRIES = 10_000;
// Keep one bounded workspace/environment snapshot per physical app-server client.
const nativeSkillIsolationByClient = new WeakMap<
  CodexAppServerClient,
  {
    key: string;
    result: Promise<CodexNativeSkillIsolation | undefined>;
    settled: boolean;
    signal?: AbortSignal;
  }
>();

function isMissingPathError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && !relative.startsWith(`..${path.sep}`) && relative !== "..")
  );
}

async function canonicalizeExistingPath(candidate: string): Promise<string> {
  try {
    return await fs.realpath(candidate);
  } catch {
    return path.resolve(candidate);
  }
}

async function usesDefaultStateDir(): Promise<boolean> {
  if (!process.env.OPENCLAW_STATE_DIR?.trim()) {
    return true;
  }
  const home = resolveRequiredHomeDir();
  const [stateDir, defaultStateDir] = await Promise.all([
    canonicalizeExistingPath(resolveStateDir()),
    canonicalizeExistingPath(path.join(home, ".openclaw")),
  ]);
  return stateDir === defaultStateDir;
}

async function collectPersonalSkillRealPaths(
  homes: string[],
  codexHome: string | undefined,
): Promise<{ complete: boolean; skillPaths: Set<string> }> {
  const realStateDir = await canonicalizeExistingPath(resolveStateDir());
  const roots: Array<{ dir: string; onlyEscapedStateTargets: boolean }> = [];
  for (const home of homes) {
    for (const dir of [".agents", ".claude"]) {
      roots.push({
        dir: path.join(home, dir, "skills"),
        onlyEscapedStateTargets: false,
      });
    }
    const defaultCodexHome = path.join(home, ".codex");
    const realDefaultCodexHome = await canonicalizeExistingPath(defaultCodexHome);
    roots.push({
      dir: path.join(defaultCodexHome, "skills"),
      onlyEscapedStateTargets: isPathWithin(realStateDir, realDefaultCodexHome),
    });
  }
  const configuredCodexHome = codexHome?.trim() || process.env.CODEX_HOME?.trim();
  if (configuredCodexHome) {
    const realCodexHome = await canonicalizeExistingPath(configuredCodexHome);
    const stateOwned = isPathWithin(realStateDir, realCodexHome);
    roots.push({
      dir: path.join(configuredCodexHome, "skills"),
      // Direct descendants of a state-owned Codex home belong to this isolated instance.
      // Only realpath escapes cross back into operator-home state and must be disabled.
      onlyEscapedStateTargets: stateOwned,
    });
  }
  const skillPaths = new Set<string>();
  let complete = true;
  const seenDirectories = new Set<string>();
  const queue = roots.map((root) => ({
    dir: root.dir,
    onlyEscapedStateTargets: root.onlyEscapedStateTargets,
    depth: 0,
  }));
  let entryCount = 0;
  const recordSkillFile = async (filePath: string, onlyEscapedStateTargets: boolean) => {
    try {
      const skillRealPath = await fs.realpath(filePath);
      if (!onlyEscapedStateTargets || !isPathWithin(realStateDir, skillRealPath)) {
        skillPaths.add(skillRealPath);
      }
    } catch (error) {
      if (!isMissingPathError(error)) {
        complete = false;
      }
    }
  };
  for (const current of queue) {
    let realDir: string;
    try {
      realDir = await fs.realpath(current.dir);
    } catch (error) {
      if (isMissingPathError(error)) {
        continue;
      }
      complete = false;
      continue;
    }
    if (seenDirectories.has(realDir)) {
      continue;
    }
    seenDirectories.add(realDir);
    if (seenDirectories.size > MAX_PERSONAL_SKILL_DIRECTORIES) {
      complete = false;
      break;
    }
    let directory: Awaited<ReturnType<typeof fs.opendir>>;
    try {
      directory = await fs.opendir(current.dir);
    } catch (error) {
      if (!isMissingPathError(error)) {
        complete = false;
      }
      continue;
    }
    try {
      for await (const entry of directory) {
        entryCount += 1;
        if (entryCount > MAX_PERSONAL_SKILL_ENTRIES) {
          complete = false;
          queue.length = 0;
          break;
        }
        if (entry.name.startsWith(".")) {
          continue;
        }
        const entryPath = path.join(current.dir, entry.name);
        if (entry.name === "SKILL.md" && entry.isFile()) {
          await recordSkillFile(entryPath, current.onlyEscapedStateTargets);
          continue;
        }
        if (entry.isSymbolicLink()) {
          try {
            const stat = await fs.stat(entryPath);
            if (entry.name === "SKILL.md" && stat.isFile()) {
              await recordSkillFile(entryPath, current.onlyEscapedStateTargets);
            } else if (stat.isDirectory()) {
              if (current.depth < MAX_PERSONAL_SKILL_DEPTH) {
                queue.push({
                  dir: entryPath,
                  depth: current.depth + 1,
                  onlyEscapedStateTargets: current.onlyEscapedStateTargets,
                });
              } else {
                complete = false;
              }
            }
          } catch (error) {
            if (!isMissingPathError(error)) {
              complete = false;
            }
          }
          continue;
        }
        if (current.depth >= MAX_PERSONAL_SKILL_DEPTH) {
          if (entry.isDirectory()) {
            complete = false;
          }
          continue;
        }
        if (entry.isDirectory()) {
          queue.push({
            dir: entryPath,
            depth: current.depth + 1,
            onlyEscapedStateTargets: current.onlyEscapedStateTargets,
          });
          continue;
        }
      }
    } catch (error) {
      if (!isMissingPathError(error)) {
        complete = false;
      }
    }
  }
  return { complete, skillPaths };
}

/** Resolves the native user-scope skills that an isolated OpenClaw thread must disable. */
export async function resolveCodexNativeSkillIsolation(params: {
  client: CodexAppServerClient;
  codexHome?: string;
  cwd: string;
  home?: string;
  userProfile?: string;
  signal?: AbortSignal;
}): Promise<CodexNativeSkillIsolation | undefined> {
  params.signal?.throwIfAborted();
  if (!process.env.OPENCLAW_STATE_DIR?.trim()) {
    return undefined;
  }
  const key = JSON.stringify([
    path.resolve(resolveStateDir()),
    path.resolve(params.cwd),
    params.codexHome?.trim() || process.env.CODEX_HOME?.trim() || "",
    params.home?.trim() || process.env.HOME?.trim() || "",
    params.userProfile?.trim() || process.env.USERPROFILE?.trim() || "",
  ]);
  const cached = nativeSkillIsolationByClient.get(params.client);
  if (cached?.key === key && (cached.settled || cached.signal === params.signal)) {
    const isolation = await cached.result;
    params.signal?.throwIfAborted();
    return isolation;
  }
  const result = resolveUncachedCodexNativeSkillIsolation(params);
  const entry = { key, result, settled: false, signal: params.signal };
  nativeSkillIsolationByClient.set(params.client, entry);
  try {
    const isolation = await result;
    entry.settled = true;
    params.signal?.throwIfAborted();
    return isolation;
  } catch (error) {
    if (nativeSkillIsolationByClient.get(params.client)?.result === result) {
      nativeSkillIsolationByClient.delete(params.client);
    }
    throw error;
  }
}

async function resolveUncachedCodexNativeSkillIsolation(
  params: Parameters<typeof resolveCodexNativeSkillIsolation>[0],
): Promise<CodexNativeSkillIsolation | undefined> {
  if (await usesDefaultStateDir()) {
    return undefined;
  }
  const response = await params.client.request(
    "skills/list",
    { cwds: [params.cwd], forceReload: true },
    { signal: params.signal },
  );
  const effectiveHome =
    params.home?.trim() ||
    process.env.HOME?.trim() ||
    process.env.USERPROFILE?.trim() ||
    os.homedir();
  const homes = [effectiveHome];
  if (process.platform === "win32") {
    homes.push(params.userProfile?.trim() || os.homedir());
  }
  const personalSkills = await collectPersonalSkillRealPaths(
    [...new Set(homes.map((home) => path.resolve(home)))],
    params.codexHome,
  );
  const disabledUserSkillPaths = [
    // Codex also labels explicit plugin and extra roots as user scope. Preserve those on a
    // complete provenance scan; fall back to all user paths only when personal-root proof failed.
    ...(personalSkills.complete
      ? personalSkills.skillPaths
      : new Set([
          ...personalSkills.skillPaths,
          ...response.data.flatMap((entry) =>
            entry.skills.filter((skill) => skill.scope === "user").map((skill) => skill.path),
          ),
        ])),
  ].toSorted((left, right) => left.localeCompare(right));
  return { disabledUserSkillPaths };
}

/** Applies path-exact session rules after caller config so isolated user skills stay disabled. */
export function applyCodexNativeSkillIsolation(
  config: JsonObject | undefined,
  isolation: CodexNativeSkillIsolation | undefined,
): JsonObject | undefined {
  if (!isolation) {
    return config;
  }
  const existingRules = config?.["skills.config"];
  if (existingRules !== undefined && !Array.isArray(existingRules)) {
    throw new Error("Codex thread skills.config must be an array");
  }
  const disabledRules: JsonValue[] = isolation.disabledUserSkillPaths.map((skillPath) => ({
    path: skillPath,
    enabled: false,
  }));
  return {
    ...config,
    "skills.include_instructions": false,
    "skills.config": [...(existingRules ?? []), ...disabledRules],
  };
}
