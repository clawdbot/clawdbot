// Shared types for grouped OpenClaw Claw manifests and read-only add plans.

export const CLAW_SCHEMA_VERSION = 1 as const;
export const CLAW_ADD_PLAN_SCHEMA_VERSION = "openclaw.clawAddPlan.v1" as const;
export const CLAW_INSPECT_RESULT_SCHEMA_VERSION = "openclaw.clawInspect.v1" as const;
export const CLAW_OUTPUT_STABILITY = "experimental" as const;

type ClawDiagnosticLevel = "error" | "warning";

export type ClawDiagnostic = {
  level: ClawDiagnosticLevel;
  code: string;
  phase: "parse" | "schema" | "policy" | "plan" | "mutation";
  path: string;
  message: string;
};

type ClawAgent = {
  id: string;
  name?: string;
  description?: string;
  identity?: {
    name?: string;
    theme?: string;
    emoji?: string;
    avatar?: string;
  };
  groupChat?: {
    mentionPatterns?: string[];
  };
  sandbox?: {
    mode?: "off" | "non-main" | "all";
    scope?: "session" | "agent" | "shared";
    workspaceAccess?: "none" | "ro" | "rw";
  };
  tools?: {
    allow?: string[];
    deny?: string[];
  };
  heartbeat?: {
    every?: string;
    activeHours?: {
      start?: string;
      end?: string;
      timezone?: string;
    };
    lightContext?: boolean;
    isolatedSession?: boolean;
    skipWhenBusy?: boolean;
    timeoutSeconds?: number;
  };
  humanDelay?: {
    mode?: "off" | "natural" | "custom";
    minMs?: number;
    maxMs?: number;
  };
};

export const CLAW_BOOTSTRAP_FILE_NAMES = [
  "AGENTS.md",
  "SOUL.md",
  "IDENTITY.md",
  "TOOLS.md",
  "HEARTBEAT.md",
] as const;

type ClawBootstrapFileName = (typeof CLAW_BOOTSTRAP_FILE_NAMES)[number];

type ClawWorkspaceFile = {
  source: string;
  path: string;
};

type ClawWorkspace = {
  bootstrapFiles: Partial<Record<ClawBootstrapFileName, { source: string }>>;
  files: ClawWorkspaceFile[];
};

export type ClawPackage = {
  kind: "skill" | "plugin";
  source: "clawhub";
  ref: string;
  version: string;
};

export type ResolvedClawPackage = ClawPackage & { integrity: string };

type ClawMcpServerCommon = {
  toolFilter?: {
    include?: string[];
    exclude?: string[];
  };
  timeout?: number;
  connectTimeout?: number;
};

type ClawStdioMcpServer = ClawMcpServerCommon & {
  command: string;
  transport?: "stdio";
  args?: string[];
  env?: Record<string, string>;
};

type ClawRemoteMcpServer = ClawMcpServerCommon & {
  url: string;
  transport: "sse" | "streamable-http";
  auth?: "oauth";
};

export type ClawMcpServer = ClawStdioMcpServer | ClawRemoteMcpServer;

export type ClawCronJob = {
  id: string;
  name?: string;
  schedule: {
    cron: string;
    timezone: string;
  };
  session: "main" | "isolated";
  message: string;
  delivery?: {
    mode: "none" | "announce";
    channel?: "last";
  };
};

export type ClawManifest = {
  schemaVersion: typeof CLAW_SCHEMA_VERSION;
  agent: ClawAgent;
  workspace: ClawWorkspace;
  packages: ClawPackage[];
  mcpServers: Record<string, ClawMcpServer>;
  cronJobs: ClawCronJob[];
};

export type ClawSourceIdentity = {
  kind: "package" | "development";
  name: string;
  version: string;
  packageRoot: string;
  manifestPath: string;
  integrityKind: "artifact" | "development-snapshot";
  integrity: string;
  byteLength: number;
};

export type ClawWorkspaceSourceSnapshot = {
  sourcePath: string;
  realPath: string;
  byteLength: number;
  digest: string;
};

type ClawSourceSnapshot = {
  workspaceSources: ClawWorkspaceSourceSnapshot[];
};

export type ClawReadResult =
  | {
      ok: true;
      manifest: ClawManifest;
      source: ClawSourceIdentity;
      snapshot: ClawSourceSnapshot;
      diagnostics: ClawDiagnostic[];
    }
  | {
      ok: false;
      diagnostics: ClawDiagnostic[];
    };

export type ClawAddPlanAction = {
  kind: "agent" | "workspace" | "workspaceFile" | "package" | "mcpServer" | "cronJob";
  id: string;
  action: "create" | "write" | "install" | "configure" | "schedule";
  target: string;
  source?: string;
  digest?: string;
  details?: Record<string, unknown>;
  blocked: boolean;
  reason?: string;
};

export type ClawAddCapabilityChange = {
  kind: "agent" | "package" | "mcpServer" | "cronJob";
  id: string;
  path: string;
  action: "create" | "install" | "configure" | "schedule";
  classification: "escalation";
  requiresDistinctConsent: true;
  reason: string;
  effect: Record<string, unknown>;
  digest: string;
};

export type ClawLocalPrerequisite =
  | { kind: "environment"; mcpServer: string; name: string }
  | { kind: "oauth"; mcpServer: string };

export type ClawAddPlan = {
  schemaVersion: typeof CLAW_ADD_PLAN_SCHEMA_VERSION;
  manifestSchemaVersion: typeof CLAW_SCHEMA_VERSION;
  stability: typeof CLAW_OUTPUT_STABILITY;
  dryRun: true;
  mutationAllowed: false;
  planIntegrity: string;
  claw: ClawSourceIdentity;
  agent: {
    requestedId: string;
    finalId: string;
    workspace: string;
    config: ClawAgent & { workspace: string };
  };
  summary: {
    totalActions: number;
    agentActions: number;
    workspaceActions: number;
    packageActions: number;
    mcpServerActions: number;
    cronJobActions: number;
    blockedActions: number;
    capabilityEscalations: number;
  };
  actions: ClawAddPlanAction[];
  capabilityChanges: ClawAddCapabilityChange[];
  readiness: {
    ready: boolean;
    requirements: ClawLocalPrerequisite[];
  };
  blockers: ClawDiagnostic[];
  diagnostics: ClawDiagnostic[];
};
