import type { SessionToolOverrides } from "./patch.ts";

type BooleanOverrideGroup = "mcpServers" | "skills";

function copyDynamicKeyRecord<T>(
  values: Record<string, T> | undefined,
  copyValue: (value: T) => T = (value) => value,
): Record<string, T> {
  const copy: Record<string, T> = {};
  for (const [name, value] of Object.entries(values ?? {})) {
    Object.defineProperty(copy, name, {
      configurable: true,
      enumerable: true,
      value: copyValue(value),
      writable: true,
    });
  }
  return copy;
}

export function readOwnEntry<T>(
  values: Readonly<Record<string, T>> | null | undefined,
  name: string,
): T | undefined {
  return values != null && Object.hasOwn(values, name) ? values[name] : undefined;
}

function setOwnValue<T>(values: Record<string, T>, name: string, value: T): void {
  Object.defineProperty(values, name, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function copyOverrides(overrides: SessionToolOverrides | null | undefined): SessionToolOverrides {
  return {
    ...(overrides?.mcpServers ? { mcpServers: copyDynamicKeyRecord(overrides.mcpServers) } : {}),
    ...(overrides?.mcpToolsDeny
      ? {
          mcpToolsDeny: copyDynamicKeyRecord(overrides.mcpToolsDeny, (tools) => [...tools]),
        }
      : {}),
    ...(overrides?.skills ? { skills: copyDynamicKeyRecord(overrides.skills) } : {}),
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
  const values = copyDynamicKeyRecord(Object.hasOwn(next, group) ? next[group] : undefined);
  if (nextEnabled === baseEnabled) {
    delete values[name];
  } else {
    setOwnValue(values, name, nextEnabled);
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
  const currentDeny = Object.hasOwn(next, "mcpToolsDeny") ? next.mcpToolsDeny : undefined;
  const deniedTools = new Set(readOwnEntry(currentDeny, server) ?? []);
  if (denied) {
    deniedTools.add(rawToolName);
  } else {
    deniedTools.delete(rawToolName);
  }
  const mcpToolsDeny = copyDynamicKeyRecord(currentDeny, (tools) => [...tools]);
  if (deniedTools.size > 0) {
    setOwnValue(mcpToolsDeny, server, [...deniedTools].toSorted());
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
