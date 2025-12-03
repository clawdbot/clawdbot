export type AgentKind = "claude" | "opencode" | "pi" | "codex" | "gemini";

export type AgentMeta = {
  model?: string;
  provider?: string;
  stopReason?: string;
  sessionId?: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
  extra?: Record<string, unknown>;
};

export type AgentParseResult = {
  // Plural to support agents that emit multiple assistant turns per prompt.
  texts?: string[];
  mediaUrls?: string[];
  meta?: AgentMeta;
};

export type BuildArgsContext = {
  argv: string[];
  bodyIndex: number; // index of prompt/body argument in argv
  isNewSession: boolean;
  sessionId?: string;
  sendSystemOnce: boolean;
  systemSent: boolean;
  identityPrefix?: string;
  format?: "text" | "json";
  sessionArgNew?: string[];
  sessionArgResume?: string[];
};

export interface AgentSpec {
  kind: AgentKind;
  isInvocation: (argv: string[]) => boolean;
  buildArgs: (ctx: BuildArgsContext) => string[];
  parseOutput: (rawStdout: string) => AgentParseResult;
}
