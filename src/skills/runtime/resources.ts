import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Value } from "typebox/value";
import {
  SKILL_LIBRARY_MAX_BUNDLE_BYTES,
  SKILL_LIBRARY_MAX_FILE_BYTES,
} from "../../../packages/gateway-protocol/src/schema/skill-library.js";
import {
  SkillResourceDeliverySchema,
  type SkillResourceDelivery,
} from "../../../packages/gateway-protocol/src/schema/skill-resources.js";
import { removeTemporaryArtifacts } from "../../infra/temp-artifact-cleanup.js";
import { prepareSkillBundle, readSkillBundleTree } from "../library/bundle.js";
import { loadSkillLibrarySelection, readSelectedSkillLibraryFiles } from "../library/selection.js";
import { loadSingleSkillDirectory } from "../loading/local-loader.js";
import { createSyntheticSourceInfo } from "../loading/skill-contract.js";
import { shouldSyncSkillPath } from "../loading/skill-paths.js";
import { formatSkillsForPromptBounded } from "../loading/skill-prompt-limits.js";
import type { ExplicitSkillSelection, SkillSnapshot } from "../types.js";

// The caller retains these bytes for its turn. Catalog versions do not version supporting files.
export async function prepareSkillResourceDelivery(
  snapshot: SkillSnapshot | undefined,
  assertCurrent: () => void,
  explicitSelections: readonly ExplicitSkillSelection[] = [],
): Promise<SkillResourceDelivery | undefined> {
  if (!snapshot) {
    return undefined;
  }
  assertCurrent();
  if (
    !snapshot.resolvedSkills?.length &&
    !snapshot.librarySelections?.length &&
    !explicitSelections.length
  ) {
    return undefined;
  }
  const skills: SkillResourceDelivery["skills"] = [];
  let total = 0;
  const candidates = [...(snapshot.resolvedSkills ?? [])];
  for (const entry of loadSkillLibrarySelection(snapshot.librarySelections ?? [])) {
    if (
      snapshot.skills.some((skill) => skill.name === entry.skill.name) &&
      !candidates.some((skill) => skill.name === entry.skill.name)
    ) {
      candidates.push(entry.skill);
    }
  }
  for (const selected of explicitSelections) {
    if (
      selected.path.startsWith("node://") ||
      candidates.some((skill) => skill.filePath === selected.path)
    ) {
      continue;
    }
    // Explicit references are host-resolved command paths, including eligible hidden skills.
    // Read only that directory; a resource turn must not repeat global skill discovery.
    const skillDir = path.dirname(selected.path);
    const rootRealPath = await fs.realpath(skillDir);
    assertCurrent();
    const loaded = loadSingleSkillDirectory({
      skillDir,
      rootRealPath,
      source: "openclaw-resources",
      maxBytes: SKILL_LIBRARY_MAX_FILE_BYTES,
    });
    if (
      !loaded ||
      loaded.skill.filePath !== selected.path ||
      !snapshot.skills.some((skill) => skill.name === loaded.skill.name) ||
      candidates.some((skill) => skill.name === loaded.skill.name)
    ) {
      throw new Error(
        "Explicit skill no longer matches the prepared catalog. Refresh skill selection and retry.",
      );
    }
    candidates.push(loaded.skill);
  }
  for (const skill of candidates) {
    if (skill.filePath.startsWith("node://")) {
      continue;
    }
    const pin = snapshot.librarySelections?.find((selection) => selection.name === skill.name);
    const files = pin
      ? await readSelectedSkillLibraryFiles(pin)
      : await readSkillBundleTree(skill.baseDir, shouldSyncSkillPath);
    assertCurrent();
    const bundle = prepareSkillBundle(files);
    total += bundle.files.reduce((sum, file) => sum + file.sizeBytes, 0);
    if (total > SKILL_LIBRARY_MAX_BUNDLE_BYTES) {
      throw new Error(
        "Selected skill resources exceed the worker delivery limit (8 MiB). Select fewer skills before retrying.",
      );
    }
    skills.push({
      name: skill.name,
      sourcePath: skill.filePath,
      modelVisible:
        (snapshot.resolvedSkills?.some((selected) => selected.filePath === skill.filePath) ??
          false) ||
        explicitSelections.some((selected) => selected.path === skill.filePath),
      ...(skill.displayName ? { displayName: skill.displayName } : {}),
      description: skill.description,
      revision: bundle.revision,
      files,
    });
  }
  const delivery = { version: 1 as const, skills };
  if (!Value.Check(SkillResourceDeliverySchema, delivery)) {
    throw new Error("Selected skill catalog exceeds the worker resource contract.");
  }
  return delivery;
}

/** Owns private turn inputs independently of credential-bearing worker state. */
export async function materializeSkillResources(
  delivery: SkillResourceDelivery,
  assertCurrent: () => void,
): Promise<{
  directory: string;
  snapshot: SkillSnapshot;
  rewriteReferences: (text: string) => string;
  cleanup: () => Promise<void>;
}> {
  if (!Value.Check(SkillResourceDeliverySchema, delivery)) {
    throw new Error("Invalid skill resource delivery.");
  }
  const bundles = delivery.skills.map((skill) => ({
    skill,
    bundle: prepareSkillBundle(skill.files),
  }));
  if (
    bundles.some(({ skill, bundle }) => skill.revision !== bundle.revision) ||
    bundles.reduce(
      (sum, { bundle }) => sum + bundle.files.reduce((bytes, file) => bytes + file.sizeBytes, 0),
      0,
    ) > SKILL_LIBRARY_MAX_BUNDLE_BYTES
  ) {
    throw new Error("Skill resource integrity or delivery limit check failed.");
  }
  assertCurrent();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skill-resources-"));
  const cleanup = () => removeTemporaryArtifacts(directory, "Materialized skill");
  try {
    const pathMappings: Array<[string, string]> = [];
    const resolvedSkills: NonNullable<SkillSnapshot["resolvedSkills"]> = [];
    for (const [index, { skill, bundle }] of bundles.entries()) {
      const baseDir = path.join(directory, String(index));
      for (const file of bundle.files) {
        assertCurrent();
        const target = path.join(baseDir, file.path);
        await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        assertCurrent();
        await fs.writeFile(target, file.bytes, {
          mode: file.executable ? 0o500 : 0o400,
          flag: "wx",
        });
      }
      const filePath = path.join(baseDir, "SKILL.md");
      if (skill.sourcePath) {
        pathMappings.push([skill.sourcePath, filePath]);
        // Explicit supporting-file references share the same verified bundle root.
        pathMappings.push([skill.sourcePath.slice(0, -"SKILL.md".length), `${baseDir}${path.sep}`]);
      }
      resolvedSkills.push({
        name: skill.name,
        displayName: skill.displayName,
        description: skill.description,
        filePath,
        baseDir,
        source: "openclaw-resources",
        sourceInfo: createSyntheticSourceInfo(filePath, { source: "openclaw-resources", baseDir }),
        disableModelInvocation: skill.modelVisible === false,
      });
    }
    assertCurrent();
    return {
      directory,
      snapshot: {
        skills: resolvedSkills.map((skill) => ({ name: skill.name, skillKey: skill.name })),
        resolvedSkills,
        prompt: formatSkillsForPromptBounded({
          skills: resolvedSkills.filter((skill) => !skill.disableModelInvocation),
          preserveOrder: true,
        }),
      },
      rewriteReferences: (text) =>
        pathMappings.reduce(
          (rewritten, [source, target]) => rewritten.replaceAll(source, target),
          text,
        ),
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
