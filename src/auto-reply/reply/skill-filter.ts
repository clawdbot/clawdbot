import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";

export function mergeSkillFilters(
  channelFilter?: string[],
  agentFilter?: string[],
): string[] | undefined {
  const normalize = (list?: string[]) =>
    Array.isArray(list) ? normalizeStringEntries(list) : undefined;
  const channel = normalize(channelFilter);
  const agent = normalize(agentFilter);
  if (!channel || !agent) {
    return channel ?? agent;
  }
  if (channel.length === 0 || agent.length === 0) {
    return [];
  }
  const agentSet = new Set(agent);
  return channel.filter((name) => agentSet.has(name));
}
