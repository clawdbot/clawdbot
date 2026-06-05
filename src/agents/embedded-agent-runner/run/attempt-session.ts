/**
 * Creates embedded-agent sessions with the runner resource loader installed.
 */
import type { CreateAgentSessionOptions } from "../../sessions/index.js";

/**
 * Session construction bridge for embedded-attempt runs.
 */
export type EmbeddedAgentSessionOptions = {
  cwd: string;
  agentDir: string;
  authStorage: unknown;
  modelRegistry: unknown;
  model: unknown;
  thinkingLevel: unknown;
  tools: NonNullable<CreateAgentSessionOptions["tools"]>;
  customTools: NonNullable<CreateAgentSessionOptions["customTools"]>;
  sessionManager: unknown;
  settingsManager: unknown;
  resourceLoader: unknown;
  withSessionWriteLock?: CreateAgentSessionOptions["withSessionWriteLock"];
};

/** Invokes the supplied session factory with the prepared embedded-agent session options. */
export async function createEmbeddedAgentSessionWithResourceLoader<Result>(params: {
  createAgentSession: (options: EmbeddedAgentSessionOptions) => Promise<Result> | Result;
  options: EmbeddedAgentSessionOptions;
}): Promise<Result> {
  return await params.createAgentSession(params.options);
}
