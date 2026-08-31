import type { NodeSkillDescriptor } from "../../packages/gateway-protocol/src/schema/nodes.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  NODE_SKILL_MAX_CONTENT_BYTES,
  NODE_SKILL_MAX_COUNT,
  NODE_SKILL_MAX_DESCRIPTION_LENGTH,
  NODE_SKILL_MAX_TOTAL_BYTES,
  NODE_SKILL_NAME_RE,
} from "../shared/node-skill-constraints.js";

const log = createSubsystemLogger("gateway/node-skills");

export function normalizeNodeSkillDescriptors(params: {
  nodeId: string;
  skills?: readonly NodeSkillDescriptor[];
  enabled?: boolean;
}): NodeSkillDescriptor[] {
  if (params.enabled === false) {
    return [];
  }

  const normalized: NodeSkillDescriptor[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;
  let droppedCount = 0;
  for (const skill of params.skills ?? []) {
    const name = skill.name.trim();
    const description = skill.description.trim();
    const contentBytes = Buffer.byteLength(skill.content, "utf8");
    if (
      !NODE_SKILL_NAME_RE.test(name) ||
      !description ||
      description.length > NODE_SKILL_MAX_DESCRIPTION_LENGTH ||
      !skill.content ||
      contentBytes > NODE_SKILL_MAX_CONTENT_BYTES ||
      seen.has(name) ||
      normalized.length >= NODE_SKILL_MAX_COUNT ||
      totalBytes + contentBytes > NODE_SKILL_MAX_TOTAL_BYTES
    ) {
      droppedCount += 1;
      continue;
    }
    seen.add(name);
    totalBytes += contentBytes;
    normalized.push({ name, description, content: skill.content });
  }

  if (droppedCount > 0) {
    log.warn(
      `node ${params.nodeId} published ${params.skills?.length ?? 0} skill descriptors; dropped ${droppedCount} invalid or over-limit descriptors`,
    );
  }
  return normalized.toSorted((left, right) => left.name.localeCompare(right.name, "en"));
}
