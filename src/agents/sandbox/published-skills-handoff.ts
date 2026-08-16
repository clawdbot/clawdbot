/**
 * Opaque per-run published sandbox skill catalogs.
 *
 * The workspace-global sync cache is only a publisher. Each sandbox context or
 * session workspace object carries the catalog selected for that run, so
 * concurrent eligibility snapshots cannot steal each other's prompt. Ownership
 * is weak: nothing here holds a filesystem resource, so dropping the owner is
 * the only cleanup required.
 */
import type { SkillSnapshot } from "../../skills/types.js";

const publishedSkillsByOwner = new WeakMap<object, SkillSnapshot>();

export function attachPublishedSandboxSkills(owner: object, skillsSnapshot: SkillSnapshot): void {
  publishedSkillsByOwner.set(owner, skillsSnapshot);
}

export function readPublishedSandboxSkills(
  owner: object | null | undefined,
): SkillSnapshot | undefined {
  if (!owner) {
    return undefined;
  }
  return publishedSkillsByOwner.get(owner);
}
