import { AgentSessionTree } from "./agent-session-tree.js";
import type { AgentSessionConfig } from "./agent-session-types.js";

export * from "./agent-session-types.js";
export { parseSkillBlock, type ParsedSkillBlock } from "./agent-session-utils.js";

/**
 * Core abstraction for agent lifecycle and session management.
 *
 * Shared by interactive, print, and RPC modes. Mode-specific I/O stays above
 * this class while the feature layers below own session behavior.
 */
export class AgentSession extends AgentSessionTree {
  constructor(config: AgentSessionConfig) {
    super(config);
    this.unsubscribeAgent = this.agent.subscribe(this.handleAgentEvent);
    this.installAgentToolHooks();
    this.buildRuntime({
      activeToolNames: this.initialActiveToolNames,
      includeAllExtensionTools: true,
    });
  }
}
