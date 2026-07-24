import type { OpenClawConfig } from "../src/config/types.openclaw.js";

/** Materializes the load-time roster shape ordinary runtime tests receive. */
export function materializeTestAgentRoster(cfg: OpenClawConfig): OpenClawConfig {
  const agents = cfg.agents ?? {};
  const rawEntries = agents.entries;
  let roster: Array<{ id: string; default?: boolean } & Record<string, unknown>>;
  if (rawEntries !== undefined) {
    if (
      !rawEntries ||
      typeof rawEntries !== "object" ||
      Array.isArray(rawEntries) ||
      Object.values(rawEntries).some(
        (entry) => !entry || typeof entry !== "object" || Array.isArray(entry),
      )
    ) {
      return cfg;
    }
    roster = Object.entries(rawEntries).map(([id, entry]) => ({ id, ...entry }));
  } else if (agents.list !== undefined) {
    if (
      !Array.isArray(agents.list) ||
      agents.list.some(
        (entry) =>
          !entry ||
          typeof entry !== "object" ||
          Array.isArray(entry) ||
          typeof entry.id !== "string",
      )
    ) {
      return cfg;
    }
    roster = agents.list.map((entry) => ({ ...entry }));
  } else {
    roster = [];
  }

  if (roster.length === 0) {
    return { ...cfg, agents: { ...agents, entries: { main: { default: true } } } };
  }
  const defaultId = roster.find((entry) => entry.default === true)?.id ?? roster[0]!.id;
  const entries = Object.fromEntries(
    roster.map((entry) => {
      const { id, ...rest } = entry;
      const next = { ...rest };
      if (id === defaultId) {
        next.default = true;
      } else {
        delete next.default;
      }
      return [id, next];
    }),
  );
  const { list: _legacyList, ...rest } = agents;
  return { ...cfg, agents: { ...rest, entries } };
}
