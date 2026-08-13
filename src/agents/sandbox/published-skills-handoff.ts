/**
 * Opaque per-run published sandbox skill catalogs.
 *
 * The workspace-global sync cache is only a publisher. Each sandbox context or
 * session workspace object carries the catalog and generation lease selected
 * for that run so concurrent eligibility snapshots cannot steal each other's
 * prompt, and prune cannot delete files a still-running consumer advertised.
 */
import type { SkillSnapshot } from "../../skills/types.js";

export type PublishedSandboxSkillsHandoff = {
  releaseGeneration: () => void;
  skillsSnapshot: SkillSnapshot;
};

const publishedSkillsByOwner = new WeakMap<object, PublishedSandboxSkillsHandoff>();

export function attachPublishedSandboxSkills(
  owner: object,
  handoff: PublishedSandboxSkillsHandoff,
): void {
  publishedSkillsByOwner.get(owner)?.releaseGeneration();
  publishedSkillsByOwner.set(owner, handoff);
}

export function readPublishedSandboxSkills(
  owner: object | null | undefined,
): PublishedSandboxSkillsHandoff | undefined {
  if (!owner) {
    return undefined;
  }
  return publishedSkillsByOwner.get(owner);
}

export function releasePublishedSandboxSkills(owner: object | null | undefined): void {
  if (!owner) {
    return;
  }
  const handoff = publishedSkillsByOwner.get(owner);
  if (!handoff) {
    return;
  }
  publishedSkillsByOwner.delete(owner);
  handoff.releaseGeneration();
}

export async function releasePublishedSandboxSkillsOnThrow<T>(
  owner: object | null | undefined,
  work: () => Promise<T>,
): Promise<T> {
  // WeakMap GC does not run the releaser. If preparation throws before a
  // runtime owner is returned, this must drop the generation lease here.
  try {
    return await work();
  } catch (error) {
    releasePublishedSandboxSkills(owner);
    throw error;
  }
}
