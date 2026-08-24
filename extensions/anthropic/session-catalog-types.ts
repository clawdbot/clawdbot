import type { SessionCatalogPullRequestSummary } from "openclaw/plugin-sdk/session-catalog";
import type { ClaudeTranscriptItem } from "./session-catalog-transcript.js";

type ClaudeSessionSource = "claude-cli" | "claude-desktop";

export type ClaudeSessionCatalogSession = {
  threadId: string;
  name?: string | null;
  cwd?: string;
  status: "stored";
  createdAt?: number;
  updatedAt?: number;
  recencyAt?: number | null;
  source: ClaudeSessionSource;
  modelProvider: "anthropic";
  cliVersion?: string;
  gitBranch?: string;
  customGroup?: string;
  pullRequest?: SessionCatalogPullRequestSummary;
  archived: false;
};

export type ClaudeSessionCatalogPage = {
  sessions: ClaudeSessionCatalogSession[];
  nextCursor?: string;
};

export type ClaudeSessionCatalogHost = ClaudeSessionCatalogPage & {
  hostId: string;
  label: string;
  kind: "gateway" | "node";
  connected: boolean;
  nodeId?: string;
  canContinueClaude?: boolean;
  canOpenTerminalClaude?: boolean;
  error?: { code: string; message: string };
};

export type ClaudeSessionCatalogResult = {
  hosts: ClaudeSessionCatalogHost[];
};

export type ClaudeSessionTranscriptPage = {
  hostId: string;
  label: string;
  threadId: string;
  items: ClaudeTranscriptItem[];
  nextCursor?: string;
};
