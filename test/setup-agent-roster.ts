// Ordinary runtime tests receive config after load-time roster migration.
// Keep raw-roster contract tests explicitly unmocked instead of reintroducing a production fallback.
import { vi } from "vitest";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";

vi.mock("../src/agents/agent-scope-config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agents/agent-scope-config.js")>();

  const materializeRoster = (cfg: OpenClawConfig): OpenClawConfig => {
    const property = actual.readAgentRosterProperty(cfg);
    if (
      property?.kind === "list" &&
      (!Array.isArray(property.value) ||
        property.value.some(
          (entry) =>
            !entry ||
            typeof entry !== "object" ||
            Array.isArray(entry) ||
            typeof (entry as { id?: unknown }).id !== "string",
        ))
    ) {
      return cfg;
    }
    if (
      property?.kind === "entries" &&
      (!property.value ||
        typeof property.value !== "object" ||
        Array.isArray(property.value) ||
        Object.values(property.value).some(
          (entry) => !entry || typeof entry !== "object" || Array.isArray(entry),
        ))
    ) {
      return cfg;
    }

    const listed = actual.listAgentEntries(cfg);
    if (listed.length === 0) {
      return {
        ...cfg,
        agents: { ...cfg.agents, entries: { main: { default: true } } },
      };
    }
    const effectiveDefaultId = listed.find((entry) => entry.default === true)?.id ?? listed[0]!.id;
    const entries = actual.toAgentEntriesRecord(
      listed.map((entry) => {
        const next = { ...entry };
        if (entry.id === effectiveDefaultId) {
          next.default = true;
        } else {
          delete next.default;
        }
        return next;
      }),
    );
    const { list: _legacyList, ...agents } = cfg.agents ?? {};
    return { ...cfg, agents: { ...agents, entries } };
  };

  return {
    ...actual,
    resolveDefaultAgentId: (cfg: OpenClawConfig) =>
      actual.resolveDefaultAgentId(materializeRoster(cfg)),
    resolveAgentWorkspaceDir: (cfg: OpenClawConfig, agentId: string, env?: NodeJS.ProcessEnv) =>
      actual.resolveAgentWorkspaceDir(materializeRoster(cfg), agentId, env),
    resolveDefaultAgentDir: (cfg: OpenClawConfig, env?: NodeJS.ProcessEnv) =>
      actual.resolveDefaultAgentDir(materializeRoster(cfg), env),
  };
});

// The gateway prepares the current roster default before constructing CronService.
// Direct unit constructions model that boundary unless a contract test passes its own value.
vi.mock("../src/cron/service/state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/cron/service/state.js")>();
  return {
    ...actual,
    createCronServiceState: (params: Parameters<typeof actual.createCronServiceState>[0]) =>
      actual.createCronServiceState({ defaultAgentId: "main", ...params }),
  };
});

// Most schema tests exercise unrelated fields with authored configs. Production validates
// after the raw roster migration, so model that ordering while AgentsSchema tests stay raw.
vi.mock("../src/config/zod-schema.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/config/zod-schema.js")>();
  const [{ z }, { migratePersistedImplicitMainRoster }] = await Promise.all([
    import("zod"),
    import("../src/config/legacy.roster.js"),
  ]);
  return {
    ...actual,
    OpenClawSchema: z.preprocess(
      (value) => migratePersistedImplicitMainRoster(value).config,
      actual.OpenClawSchema,
    ),
  };
});
