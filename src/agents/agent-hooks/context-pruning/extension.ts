/** Session extension that prunes stale context blocks before model calls. */
import type { ContextEvent, ExtensionAPI, ExtensionContext } from "../../sessions/index.js";
import { pruneContextMessages } from "./pruner.js";
import { getContextPruningRuntime } from "./runtime.js";

// Session extension that prunes context messages before model calls according to
// the active context-pruning runtime settings.
/** Registers the context-pruning hook for sessions with active pruning runtime settings. */
export default function contextPruningExtension(api: ExtensionAPI): void {
  api.on("context", (event: ContextEvent, ctx: ExtensionContext) => {
    const runtime = getContextPruningRuntime(ctx.sessionManager);
    if (!runtime) {
      return undefined;
    }

    if (runtime.settings.mode === "cache-ttl") {
      const ttlMs = runtime.settings.ttlMs;
      const lastTouch = runtime.lastCacheTouchAt ?? null;
      // Cache-TTL mode prunes only after the cache has aged out, preserving
      // prompt-cache reuse for nearby turns.
      if (!lastTouch || ttlMs <= 0) {
        return undefined;
      }
      if (ttlMs > 0 && Date.now() - lastTouch < ttlMs) {
        return undefined;
      }
    }

    const next = pruneContextMessages({
      messages: event.messages,
      settings: runtime.settings,
      ctx,
      isToolPrunable: runtime.isToolPrunable,
      contextWindowTokensOverride: runtime.contextWindowTokens ?? undefined,
      dropThinkingBlocksForEstimate: runtime.dropThinkingBlocks,
    });

    if (next === event.messages) {
      return undefined;
    }

    if (runtime.settings.mode === "cache-ttl") {
      runtime.lastCacheTouchAt = Date.now();
    }

    return { messages: next };
  });
}
