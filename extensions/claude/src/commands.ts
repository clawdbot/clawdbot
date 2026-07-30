/**
 * /claude slash command — inspect and control the Claude app-server harness.
 *
 * Mirrors extensions/codex/src/commands.ts. Subcommands:
 *   - status         show shared-client liveness + recent error context
 *   - version        report bridge + installed server package versions
 *   - threads        show the active session's claude thread binding
 *   - conversations  list this agent's other real conversations with a bound Claude thread
 *   - resume <id>    rotate the current session's binding to a given thread_id
 *   - thread-pop     rotate back to the thread you last switched away from via resume
 *   - help           print subcommand listing
 *
 * The bridge client is shared per host process (see app-server/client.ts).
 * Commands that need to spawn the server intentionally avoid doing so —
 * they probe the shared client without forcing a start, so /claude status
 * remains cheap when no turn has run yet.
 */

import type {
  OpenClawPluginCommandDefinition,
  PluginCommandContext,
  PluginCommandResult,
} from "openclaw/plugin-sdk/plugin-entry";
import type { ClaudeAppServerBindingStore } from "./app-server/thread-store.js";

export type ClaudeCommandOptions = {
  pluginConfig?: unknown;
  resolvePluginConfig?: () => unknown;
  /**
   * Shared binding-store resolver from the plugin entry — the SAME instance
   * the harness uses, so command mutations serialize through one
   * lifecycle-lock queue with in-flight turns.
   */
  resolveBindingStore?: () => Promise<ClaudeAppServerBindingStore>;
  /** Test seam: overrides the resolver-provided binding store. */
  bindingStore?: ClaudeAppServerBindingStore;
};

export function createClaudeCommand(
  options: ClaudeCommandOptions = {},
): OpenClawPluginCommandDefinition {
  return {
    name: "claude",
    description: "Inspect and control the Claude app-server harness",
    ownership: "reserved",
    acceptsArgs: true,
    requireAuth: true,
    handler: (ctx) => handleClaudeCommand(ctx, options),
  };
}

const SUBCOMMANDS = [
  "status",
  "version",
  "threads",
  "conversations",
  "resume",
  "thread-pop",
  "help",
] as const;
type ClaudeSubcommand = (typeof SUBCOMMANDS)[number];

function parseSubcommand(raw: string | undefined): {
  sub: ClaudeSubcommand;
  rest: string;
} {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) {
    return { sub: "help", rest: "" };
  }
  const [head, ...tail] = trimmed.split(/\s+/);
  const candidate = (head ?? "").toLowerCase();
  if ((SUBCOMMANDS as readonly string[]).includes(candidate)) {
    return { sub: candidate as ClaudeSubcommand, rest: tail.join(" ") };
  }
  return { sub: "help", rest: trimmed };
}

export async function handleClaudeCommand(
  ctx: PluginCommandContext,
  options: ClaudeCommandOptions = {},
): Promise<PluginCommandResult> {
  const { sub, rest } = parseSubcommand(ctx.args);
  try {
    const handlers = await loadHandlers();
    const resolveBindingStore = async (): Promise<ClaudeAppServerBindingStore> => {
      if (options.bindingStore) {
        return options.bindingStore;
      }
      if (!options.resolveBindingStore) {
        throw new Error("thread bindings are unavailable: no binding store was provided");
      }
      return await options.resolveBindingStore();
    };
    switch (sub) {
      case "status":
        return handlers.handleStatus(ctx);
      case "version":
        return await handlers.handleVersion(ctx);
      case "threads":
        return await handlers.handleThreads(ctx, await resolveBindingStore());
      case "conversations":
        return await handlers.handleConversations(ctx, await resolveBindingStore(), options);
      case "resume":
        return await handlers.handleResume(ctx, rest, await resolveBindingStore());
      case "thread-pop":
        return await handlers.handleThreadPop(ctx, await resolveBindingStore());
      default:
        return handlers.handleHelp();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { text: `Claude command failed: ${message}` };
  }
}

async function loadHandlers() {
  // Lazy-import: keep slash-command registration cheap until invoked.
  const mod = await import("./command-handlers.js");
  return mod;
}
