import type { AgentsListResult } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import type { WorkboardCard, WorkboardUiState } from "../../lib/workboard/index.ts";

type WorkboardAgentRow = AgentsListResult["agents"][number];
type WorkboardConfiguredAgentOption = { id: string; label: string; isDefault: boolean };
type WorkboardAgentFilterOption = {
  id: WorkboardUiState["agentFilter"];
  label: string;
  description?: string;
};

export function agentDisplayName(agent: WorkboardAgentRow | undefined, fallback: string): string {
  return agent?.name ?? agent?.identity?.name ?? agent?.id ?? fallback;
}

function cardAgentId(card: WorkboardCard, agentsList: AgentsListResult | null): string {
  return card.agentId?.trim() || agentsList?.defaultId || "";
}

export function findCardAgent(card: WorkboardCard, agentsList: AgentsListResult | null) {
  const id = cardAgentId(card, agentsList);
  return id ? agentsList?.agents.find((agent) => agent.id === id) : undefined;
}

export function cardAgentLabel(card: WorkboardCard, agentsList: AgentsListResult | null): string {
  const fallback = card.agentId?.trim() || t("workboard.defaultAgent");
  return agentDisplayName(findCardAgent(card, agentsList), fallback);
}

export function matchesAgentFilter(
  card: WorkboardCard,
  agentsList: AgentsListResult | null,
  filter: WorkboardUiState["agentFilter"],
): boolean {
  if (filter === "all") {
    return true;
  }
  const explicitAgentId = card.agentId?.trim();
  if (filter === "default") {
    return !explicitAgentId;
  }
  void agentsList;
  return explicitAgentId === filter;
}

export function matchesAgentScope(
  card: WorkboardCard,
  agentsList: AgentsListResult | null,
  agentId: string | null | undefined,
): boolean {
  if (!agentId) {
    return true;
  }
  const explicitAgentId = card.agentId?.trim();
  return explicitAgentId === agentId || (!explicitAgentId && agentsList?.defaultId === agentId);
}

function normalizeAgentOptionId(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function buildConfiguredAgentOptions(
  agentsList: AgentsListResult | null,
): WorkboardConfiguredAgentOption[] {
  const seen = new Set<string>();
  const defaultAgentId = normalizeAgentOptionId(agentsList?.defaultId);
  const options: WorkboardConfiguredAgentOption[] = [];
  for (const agent of agentsList?.agents ?? []) {
    const id = normalizeAgentOptionId(agent.id);
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    options.push({
      id,
      label: agentDisplayName(agent, id),
      isDefault: Boolean(defaultAgentId && id === defaultAgentId),
    });
  }
  return options;
}

function defaultAgentFilterLabel(configuredAgents: readonly WorkboardConfiguredAgentOption[]) {
  return configuredAgents.find((agent) => agent.isDefault)?.label ?? t("workboard.defaultAgent");
}

export function buildAgentFilterOptions(
  agentsList: AgentsListResult | null,
  cards: readonly WorkboardCard[],
) {
  const configuredAgents = buildConfiguredAgentOptions(agentsList);
  const configuredIds = new Set(configuredAgents.map((agent) => agent.id));
  const cardAgentIds = [
    ...new Set(
      cards
        .map((card) => normalizeAgentOptionId(card.agentId))
        .filter((id) => id && !configuredIds.has(id)),
    ),
  ].toSorted((left, right) => left.localeCompare(right));
  const options: WorkboardAgentFilterOption[] = [
    { id: "all", label: t("workboard.allAgents") },
    {
      id: "default",
      label: t("workboard.agentFilterUnassigned", {
        agent: defaultAgentFilterLabel(configuredAgents),
      }),
      description: t("workboard.agentFilterUnassignedHelp"),
    },
  ];
  for (const agent of configuredAgents) {
    options.push({
      id: agent.id,
      label: agent.isDefault
        ? t("workboard.agentFilterConfiguredDefault", { agent: agent.label })
        : agent.label,
      ...(agent.isDefault ? { description: t("workboard.agentFilterConfiguredDefaultHelp") } : {}),
    });
  }
  for (const id of cardAgentIds) {
    options.push({ id, label: t("workboard.agentCurrentUnconfigured", { agent: id }) });
  }
  return options;
}

export function buildAssignableAgentOptions(
  agentsList: AgentsListResult | null,
  currentAgentId: string,
) {
  const configuredAgents = buildConfiguredAgentOptions(agentsList);
  const currentId = normalizeAgentOptionId(currentAgentId);
  const hasCurrent = currentId ? configuredAgents.some((agent) => agent.id === currentId) : true;
  return [
    {
      id: "",
      label: t("workboard.agentFilterUnassigned", {
        agent: defaultAgentFilterLabel(configuredAgents),
      }),
    },
    ...configuredAgents.map((agent) => ({
      id: agent.id,
      label: agent.isDefault
        ? t("workboard.agentFilterConfiguredDefault", { agent: agent.label })
        : agent.label,
    })),
    ...(hasCurrent
      ? []
      : [{ id: currentId, label: t("workboard.agentCurrentUnconfigured", { agent: currentId }) }]),
  ];
}

export function normalizeActiveAgentFilter(
  options: readonly WorkboardAgentFilterOption[],
  filter: WorkboardUiState["agentFilter"],
): WorkboardUiState["agentFilter"] {
  return options.some((option) => option.id === filter) ? filter : "all";
}
