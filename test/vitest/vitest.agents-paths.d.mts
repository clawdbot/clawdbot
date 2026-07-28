export type AgentVitestProjectOwner = {
  kind: string;
  name: string;
  config: string;
  root: string;
  dir: string;
  include: string[];
  exclude: string[];
};

export const agentVitestProjectOwners: {
  all: AgentVitestProjectOwner;
  coreIsolated: AgentVitestProjectOwner;
  core: AgentVitestProjectOwner;
  embedded: AgentVitestProjectOwner;
  embeddedIncompleteTurn: AgentVitestProjectOwner;
  embeddedOverflowCompaction: AgentVitestProjectOwner;
  embeddedRun: AgentVitestProjectOwner;
  support: AgentVitestProjectOwner;
  tools: AgentVitestProjectOwner;
};

export const agentVitestProjectConfigs: string[];
export const embeddedAgentVitestProjectOwners: AgentVitestProjectOwner[];
export function isAgentsCoreIsolatedTestFile(file: string): boolean;
