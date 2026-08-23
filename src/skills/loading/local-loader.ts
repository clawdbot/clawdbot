// Local skill loader reads skill definitions from local filesystem roots.
import fs from "node:fs";
import path from "node:path";
import {
  isRootFileMissingFailure,
  openRootFileSync,
  readFileDescriptorBoundedSync,
} from "../../infra/boundary-file-read.js";
import type { ParsedSkillFrontmatter } from "../types.js";
import { parseSkillFrontmatter, resolveSkillInvocationPolicy } from "./frontmatter.js";
import {
  createSyntheticSourceInfo,
  resolveSkillDisplayName,
  type Skill,
} from "./skill-contract.js";

type LoadedLocalSkill = {
  skill: Skill;
  frontmatter: ParsedSkillFrontmatter;
};

export type LocalSkillLoadDiagnostic = {
  path: string;
  message: string;
};

// Read SKILL.md through the root boundary helper so symlinks cannot escape the skill root.
function readSkillFileSync(params: {
  rootRealPath: string;
  filePath: string;
  maxBytes?: number;
  onDiagnostic?: (diagnostic: LocalSkillLoadDiagnostic) => void;
}): string | null {
  const opened = openRootFileSync({
    absolutePath: params.filePath,
    rootPath: params.rootRealPath,
    rootRealPath: params.rootRealPath,
    boundaryLabel: "skill root",
    // Operator skill roots are commonly symlinked; fs-safe still rejects hops
    // whose canonical target escapes the skill root.
    rejectSymlinks: false,
  });
  if (!opened.ok) {
    if (!isRootFileMissingFailure(opened)) {
      const message =
        opened.error instanceof Error
          ? opened.error.message
          : `failed to open skill file (${opened.reason})`;
      params.onDiagnostic?.({ path: params.filePath, message });
    }
    return null;
  }
  try {
    return params.maxBytes === undefined
      ? fs.readFileSync(opened.fd, "utf8")
      : readFileDescriptorBoundedSync(opened.fd, params.maxBytes).toString("utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : "failed to read skill file";
    params.onDiagnostic?.({ path: params.filePath, message });
    return null;
  } finally {
    fs.closeSync(opened.fd);
  }
}

function loadSingleSkillDirectory(params: {
  skillDir: string;
  source: string;
  rootRealPath: string;
  maxBytes?: number;
  onDiagnostic?: (diagnostic: LocalSkillLoadDiagnostic) => void;
}): LoadedLocalSkill | null {
  const skillFilePath = path.join(params.skillDir, "SKILL.md");
  const raw = readSkillFileSync({
    rootRealPath: params.rootRealPath,
    filePath: skillFilePath,
    maxBytes: params.maxBytes,
    onDiagnostic: params.onDiagnostic,
  });
  if (raw === null) {
    return null;
  }

  let frontmatter: Record<string, string>;
  try {
    frontmatter = parseSkillFrontmatter(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : "failed to parse skill frontmatter";
    params.onDiagnostic?.({ path: skillFilePath, message });
    return null;
  }

  const fallbackName = path.basename(params.skillDir).trim();
  const name = frontmatter.name?.trim() || fallbackName;
  const description = frontmatter.description?.trim();
  if (!name || !description) {
    params.onDiagnostic?.({
      path: skillFilePath,
      message: !name ? "name is required" : "description is required",
    });
    return null;
  }
  const invocation = resolveSkillInvocationPolicy(frontmatter);
  const filePath = path.resolve(skillFilePath);
  const baseDir = path.resolve(params.skillDir);

  return {
    skill: {
      name,
      displayName: resolveSkillDisplayName(raw, name),
      description,
      filePath,
      baseDir,
      source: params.source,
      sourceInfo: createSyntheticSourceInfo(filePath, {
        source: params.source,
        baseDir,
        scope: "project",
        origin: "top-level",
      }),
      disableModelInvocation: invocation.disableModelInvocation,
    },
    frontmatter,
  };
}

function listCandidateSkillDirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules",
      )
      .map((entry) => path.join(dir, entry.name))
      .toSorted((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

/** Loads skills from a local directory while turning read/parse failures into diagnostics. */
export function loadSkillsFromDirSafe(params: {
  dir: string;
  source: string;
  maxBytes?: number;
  onDiagnostic?: (diagnostic: LocalSkillLoadDiagnostic) => void;
}): {
  skills: Skill[];
  frontmatterByFilePath: ReadonlyMap<string, ParsedSkillFrontmatter>;
} {
  const rootDir = path.resolve(params.dir);
  let rootRealPath: string;
  try {
    rootRealPath = fs.realpathSync(rootDir);
  } catch {
    return { skills: [], frontmatterByFilePath: new Map() };
  }

  const rootSkill = loadSingleSkillDirectory({
    skillDir: rootDir,
    source: params.source,
    rootRealPath,
    maxBytes: params.maxBytes,
    onDiagnostic: params.onDiagnostic,
  });
  if (rootSkill) {
    return {
      skills: [rootSkill.skill],
      frontmatterByFilePath: new Map([[rootSkill.skill.filePath, rootSkill.frontmatter]]),
    };
  }

  const loadedSkills = listCandidateSkillDirs(rootDir)
    .map((skillDir) =>
      loadSingleSkillDirectory({
        skillDir,
        source: params.source,
        rootRealPath,
        maxBytes: params.maxBytes,
        onDiagnostic: params.onDiagnostic,
      }),
    )
    .filter((skill): skill is LoadedLocalSkill => skill !== null);
  const frontmatterByFilePath = new Map<string, ParsedSkillFrontmatter>();
  for (const loaded of loadedSkills) {
    frontmatterByFilePath.set(loaded.skill.filePath, loaded.frontmatter);
  }

  return {
    skills: loadedSkills.map((loaded) => loaded.skill),
    frontmatterByFilePath,
  };
}

export function readSkillFrontmatterSafe(params: {
  rootDir: string;
  filePath: string;
  maxBytes?: number;
}): Record<string, string> | null {
  let rootRealPath: string;
  try {
    rootRealPath = fs.realpathSync(path.resolve(params.rootDir));
  } catch {
    return null;
  }
  const raw = readSkillFileSync({
    rootRealPath,
    filePath: path.resolve(params.filePath),
    maxBytes: params.maxBytes,
  });
  if (raw === null) {
    return null;
  }
  try {
    return parseSkillFrontmatter(raw);
  } catch {
    return null;
  }
}
