import type { AgentsListResult, SkillStatusEntry, SkillStatusReport } from "../../api/types.ts";
import type { renderSkills } from "./view.ts";

type SkillsProps = Parameters<typeof renderSkills>[0];

export function normalizeText(node: Element | DocumentFragment): string {
  return node.textContent?.replace(/\s+/g, " ").trim() ?? "";
}

export function createSkill(overrides: Partial<SkillStatusEntry> = {}): SkillStatusEntry {
  return {
    name: "Repo Skill",
    description: "Skill description",
    source: "workspace",
    filePath: "/tmp/skill",
    baseDir: "/tmp",
    skillKey: "repo-skill",
    bundled: false,
    primaryEnv: "OPENAI_API_KEY",
    emoji: undefined,
    homepage: "https://example.com",
    always: false,
    disabled: false,
    blockedByAllowlist: false,
    blockedByAgentFilter: false,
    eligible: true,
    requirements: {
      anyBins: [],
      bins: [],
      env: [],
      config: [],
      os: [],
    },
    missing: {
      anyBins: [],
      bins: [],
      env: [],
      config: [],
      os: [],
    },
    configChecks: [],
    install: [],
    ...overrides,
  };
}

export function createProps(overrides: Partial<SkillsProps> = {}): SkillsProps {
  const report: SkillStatusReport = {
    workspaceDir: "/tmp/workspace",
    managedSkillsDir: "/tmp/skills",
    skills: [createSkill()],
  };
  const agentsList: AgentsListResult = {
    defaultId: "main",
    mainKey: "main",
    scope: "per-sender",
    agents: [
      { id: "main", name: "Main" },
      { id: "research", identity: { name: "Research", avatar: "R" } },
    ],
  };

  return {
    canUpdate: true,
    canInstall: true,
    connected: true,
    loading: false,
    report,
    agentsList,
    selectedAgentId: "main",
    error: null,
    filter: "",
    statusFilter: "all",
    edits: {},
    operation: null,
    messages: {},
    detailKey: null,
    detailTab: "overview",
    clawhubVerdicts: {},
    clawhubVerdictsLoading: false,
    clawhubVerdictsError: null,
    skillCardContents: {},
    skillCardLoadingKey: null,
    skillCardErrors: {},
    clawhubQuery: "",
    clawhubResults: null,
    clawhubIconUrls: {},
    clawhubSearchLoading: false,
    clawhubSearchError: null,
    clawhubDetail: null,
    clawhubDetailRef: null,
    clawhubDetailLoading: false,
    clawhubDetailError: null,
    clawhubInstallMessage: null,
    onAgentChange: () => undefined,
    onFilterChange: () => undefined,
    onStatusFilterChange: () => undefined,
    onRefresh: () => undefined,
    onToggle: () => undefined,
    onEdit: () => undefined,
    onSaveKey: () => undefined,
    onInstall: () => undefined,
    onDetailOpen: () => undefined,
    onDetailClose: () => undefined,
    onDetailTabChange: () => undefined,
    onClawHubQueryChange: () => undefined,
    onClawHubDetailOpen: () => undefined,
    onClawHubDetailClose: () => undefined,
    onClawHubInstall: () => undefined,
    ...overrides,
  };
}

/**
 * Each split test file owns its own cleanup stack, so a patched dialog prototype from one file
 * can never leak into the other when Vitest runs them in a shared environment.
 */
export function createDialogMethodInstaller(restores: Array<() => void>) {
  return function installDialogMethod(
    name: "showModal" | "close",
    value: (this: HTMLDialogElement) => void,
  ) {
    const proto = HTMLDialogElement.prototype as HTMLDialogElement & Record<string, unknown>;
    const original = Object.getOwnPropertyDescriptor(proto, name);
    Object.defineProperty(proto, name, {
      configurable: true,
      writable: true,
      value,
    });
    restores.push(() => {
      if (original) {
        Object.defineProperty(proto, name, original);
        return;
      }
      delete proto[name];
    });
  };
}
