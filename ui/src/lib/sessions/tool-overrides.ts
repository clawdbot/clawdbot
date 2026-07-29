import type { SessionToolOverrides } from "./patch.ts";

type BooleanOverrideGroup = "mcpServers" | "skills";

function copyOverrides(overrides: SessionToolOverrides | null | undefined): SessionToolOverrides {
  return {
    ...(overrides?.mcpServers ? { mcpServers: { ...overrides.mcpServers } } : {}),
    ...(overrides?.mcpToolsDeny
      ? {
          mcpToolsDeny: Object.fromEntries(
            Object.entries(overrides.mcpToolsDeny).map(([name, tools]) => [name, [...tools]]),
          ),
        }
      : {}),
    ...(overrides?.skills ? { skills: { ...overrides.skills } } : {}),
    ...(overrides?.webSearch !== undefined ? { webSearch: overrides.webSearch } : {}),
  };
}

export function resolveToolOverrideState(baseEnabled: boolean, override: boolean | undefined) {
  return override ?? baseEnabled;
}

export function nextBooleanToolOverrides(
  current: SessionToolOverrides | null | undefined,
  group: BooleanOverrideGroup,
  name: string,
  nextEnabled: boolean,
  baseEnabled: boolean,
): SessionToolOverrides {
  const next = copyOverrides(current);
  const values = { ...next[group] };
  if (nextEnabled === baseEnabled) {
    delete values[name];
  } else {
    values[name] = nextEnabled;
  }
  if (Object.keys(values).length === 0) {
    delete next[group];
  } else {
    next[group] = values;
  }
  return next;
}

export function nextWebSearchToolOverrides(
  current: SessionToolOverrides | null | undefined,
  nextEnabled: boolean,
  baseEnabled = true,
): SessionToolOverrides {
  const next = copyOverrides(current);
  if (nextEnabled === baseEnabled) {
    delete next.webSearch;
  } else {
    next.webSearch = nextEnabled;
  }
  return next;
}

export function nextMcpToolsDenyOverrides(
  current: SessionToolOverrides | null | undefined,
  server: string,
  rawToolName: string,
  denied: boolean,
): SessionToolOverrides {
  const next = copyOverrides(current);
  const deniedTools = new Set(next.mcpToolsDeny?.[server] ?? []);
  if (denied) {
    deniedTools.add(rawToolName);
  } else {
    deniedTools.delete(rawToolName);
  }
  const mcpToolsDeny = { ...next.mcpToolsDeny };
  if (deniedTools.size > 0) {
    mcpToolsDeny[server] = [...deniedTools].toSorted();
  } else {
    delete mcpToolsDeny[server];
  }
  if (Object.keys(mcpToolsDeny).length === 0) {
    delete next.mcpToolsDeny;
  } else {
    next.mcpToolsDeny = mcpToolsDeny;
  }
  return next;
}

export function countSessionToolOverrides(
  overrides: SessionToolOverrides | null | undefined,
): number {
  return (
    Object.keys(overrides?.mcpServers ?? {}).length +
    Object.keys(overrides?.skills ?? {}).length +
    Object.keys(overrides?.mcpToolsDeny ?? {}).length +
    (overrides?.webSearch !== undefined ? 1 : 0)
  );
}

export function sessionToolOverrideNames(
  overrides: SessionToolOverrides | null | undefined,
  webSearchLabel: string,
): string[] {
  return [
    ...Object.keys(overrides?.mcpServers ?? {}),
    ...Object.keys(overrides?.skills ?? {}),
    ...Object.keys(overrides?.mcpToolsDeny ?? {}),
    ...(overrides?.webSearch !== undefined ? [webSearchLabel] : []),
  ].toSorted((left, right) => left.localeCompare(right));
}
