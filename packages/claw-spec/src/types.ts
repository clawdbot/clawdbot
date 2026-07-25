export const CLAW_SCHEMA_VERSION = 1 as const;

export const CLAW_BOOTSTRAP_FILE_NAMES = [
  "AGENTS.md",
  "SOUL.md",
  "IDENTITY.md",
  "TOOLS.md",
  "HEARTBEAT.md",
] as const;

export type ClawDiagnostic = {
  level: "error" | "warning";
  code: string;
  phase: "parse" | "schema" | "policy" | "plan" | "mutation";
  path: string;
  message: string;
};

export type ClawAgent = {
  id: string;
  name?: string;
  description?: string;
  identity?: {
    name?: string;
    theme?: string;
    emoji?: string;
    avatar?: string;
  };
};

export type ClawBootstrapFileName = (typeof CLAW_BOOTSTRAP_FILE_NAMES)[number];

export type ClawWorkspaceFile = {
  source: string;
  path: string;
};

export type ClawWorkspace = {
  bootstrapFiles: Partial<Record<ClawBootstrapFileName, { source: string }>>;
  files: ClawWorkspaceFile[];
};

export type ClawPackage = {
  kind: "skill" | "plugin";
  source: "clawhub";
  ref: string;
  version: string;
};

export type ClawMcpServerCommon = {
  toolFilter?: {
    include?: string[];
    exclude?: string[];
  };
  timeout?: number;
  connectTimeout?: number;
};

export type ClawStdioMcpServer = ClawMcpServerCommon & {
  command: string;
  transport?: "stdio";
  args?: string[];
  env?: Record<string, string>;
};

export type ClawRemoteMcpServer = ClawMcpServerCommon & {
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
  metadata?: Record<string, string>;
  workspace: ClawWorkspace;
  packages: ClawPackage[];
  mcpServers: Record<string, ClawMcpServer>;
  cronJobs: ClawCronJob[];
};
