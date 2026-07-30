/**
 * /claude subcommand handlers. Kept in a separate module so commands.ts
 * stays import-light at slash-command registration time.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginCommandContext, PluginCommandResult } from "openclaw/plugin-sdk/plugin-entry";
import { peekSharedClaudeAppServerClient } from "./app-server/client.js";
import { claudeAppServerPoolKey } from "./app-server/config.js";
import { resolveManagedClaudeBridgeVersion } from "./app-server/managed-binary.js";
import {
  claudeBindingSessionIdentity,
  THREAD_STACK_MAX,
  type ClaudeAppServerBinding,
  type ClaudeAppServerBindingStore,
  type ClaudeBindingSessionIdentity,
} from "./app-server/thread-store.js";
import { compareClaudeBridgeVersions, MIN_CLAUDE_BRIDGE_VERSION } from "./app-server/version.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// /claude status|version are Claude-extension-scoped commands, so they must
// report THIS extension's own bridge process — the default-anthropic pool slot
// — not whichever bridge (e.g. glm-bridge → Z.ai) ran a turn most recently.
// Peeking the pool by our own key removes the lastAccessedKey ambiguity that
// surfaces when both the Claude and GLM harness extensions are active
// (GLM review G7). glm-bridge, when it grows its own /glm command, would peek
// claudeAppServerPoolKey("zai") the same way.
const CLAUDE_APP_SERVER_POOL_KEY = claudeAppServerPoolKey();

export function handleHelp(): PluginCommandResult {
  return {
    text: [
      "**/claude** — Inspect and control the Claude app-server harness.",
      "",
      "Subcommands:",
      "  `status`             show shared-client liveness and recent error context",
      "  `version`            report plugin, running, installed, and required bridge versions",
      "  `threads`            list the active session's claude thread binding",
      "  `conversations`      list this agent's other real conversations with a bound Claude thread",
      "  `resume <thread_id>` rotate the active session's binding to a specific thread",
      "  `thread-pop`         rotate back to the thread you last switched away from via resume",
      "",
      "Example: `/claude status`",
    ].join("\n"),
  };
}

export function handleStatus(_ctx: PluginCommandContext): PluginCommandResult {
  const snapshot = peekSharedClaudeAppServerClient(CLAUDE_APP_SERVER_POOL_KEY);
  const lines = ["**Claude app-server status**", ""];
  if (!snapshot) {
    lines.push("- Shared client: not yet created (no claude turn has run this process)");
    return { text: lines.join("\n") };
  }
  lines.push(`- Shared client: ${snapshot.running ? "running" : "stopped"}`);
  if (snapshot.command) {
    lines.push(`- Command: \`${snapshot.command}\``);
  }
  if (snapshot.runningVersion) {
    lines.push(`- Running version: ${snapshot.runningVersion}`);
  }
  if (snapshot.pendingRequests > 0) {
    lines.push(`- In-flight requests: ${snapshot.pendingRequests}`);
  }
  const bundled = resolveManagedClaudeBridgeVersion();
  if (
    snapshot.runningVersion &&
    bundled &&
    compareClaudeBridgeVersions(snapshot.runningVersion, bundled) < 0
  ) {
    lines.push(
      `- Update pending: running ${snapshot.runningVersion}, bundled ${bundled} (restart the gateway to apply)`,
    );
  }
  if (snapshot.lastError) {
    lines.push(`- Last stderr: \`${snapshot.lastError}\``);
  }
  return { text: lines.join("\n") };
}

export async function handleVersion(_ctx: PluginCommandContext): Promise<PluginCommandResult> {
  const lines = ["**Claude harness versions**", ""];
  const plugin = await readPackageVersion(path.resolve(HERE, "..", "package.json"));
  if (plugin) {
    lines.push(`- Plugin (extensions/claude): ${plugin}`);
  }
  lines.push(`- Minimum bridge required: ${MIN_CLAUDE_BRIDGE_VERSION}`);

  const bundled = resolveManagedClaudeBridgeVersion();
  lines.push(
    bundled
      ? `- Bundled bridge (managed): ${bundled}`
      : "- Bundled bridge (managed): not found — reinstall OpenClaw or run `pnpm install`",
  );

  const snapshot = peekSharedClaudeAppServerClient(CLAUDE_APP_SERVER_POOL_KEY);
  const running = snapshot?.running ? snapshot.runningVersion : undefined;
  lines.push(`- Running bridge (spawned): ${running ?? "not running"}`);

  if (running && compareClaudeBridgeVersions(running, MIN_CLAUDE_BRIDGE_VERSION) < 0) {
    lines.push(
      "- ⚠ Running bridge is below the required minimum; reinstall the bridge and restart the gateway.",
    );
  } else if (running && bundled && compareClaudeBridgeVersions(running, bundled) < 0) {
    lines.push("- Update pending: a newer bridge is bundled; restart the gateway to apply.");
  }
  return { text: lines.join("\n") };
}

export async function handleThreads(
  ctx: PluginCommandContext,
  bindingStore: ClaudeAppServerBindingStore,
): Promise<PluginCommandResult> {
  const identity = commandSessionIdentity(ctx);
  if (!identity) {
    return {
      text: "**Claude threads**\n\nNo session is bound to this invocation; run `/claude threads` from an active agent session.",
    };
  }
  const binding = await safeReadBinding(bindingStore, identity);
  if (!binding) {
    return {
      text: "**Claude threads**\n\nNo claude thread is bound to this session yet. A new thread will start on the next turn.",
    };
  }
  return { text: formatBinding(identity, binding) };
}

const CONVERSATIONS_LIST_LIMIT = 15;

/**
 * Session-key segments that mark automation, not a real user-facing
 * conversation — cron runs, native subagent dispatches, and isolated
 * heartbeat sessions. Everything else (`:direct:`, `:channel:`, etc.) is a
 * real channel/DM conversation. Session KEYS already carry this signal for
 * free (see `agent:<id>:direct:<peer>` vs `agent:<id>:subagent:<uuid>` /
 * `agent:<id>:cron:<uuid>` / `...:heartbeat`) — no new metadata needed.
 */
export function isConversationSessionKey(sessionKey: string): boolean {
  if (sessionKey.includes(":subagent:") || sessionKey.includes(":cron:")) {
    return false;
  }
  if (sessionKey.endsWith(":heartbeat")) {
    return false;
  }
  return true;
}

export type ConversationSessionEntry = {
  sessionKey: string;
  entry: {
    sessionId?: string;
    origin?: { label?: string };
  };
};

export type ConversationRow = {
  label: string;
  sessionKey: string;
  binding: ClaudeAppServerBinding;
};

/**
 * Filters session entries down to real conversations with a bound
 * Claude thread, and resolves each one's binding summary. Takes
 * `readBinding` as a param (rather than importing the binding store
 * directly) so this stays unit-testable without real plugin state.
 */
export async function buildConversationRows(
  entries: readonly ConversationSessionEntry[],
  deps: {
    readBinding: (identity: ClaudeBindingSessionIdentity) => Promise<ClaudeAppServerBinding | null>;
  },
): Promise<{ rows: ConversationRow[]; candidateCount: number }> {
  const rows: ConversationRow[] = [];
  let candidateCount = 0;
  for (const { sessionKey, entry } of entries) {
    if (!isConversationSessionKey(sessionKey) || !entry.sessionId) {
      continue;
    }
    candidateCount += 1;
    // The binding's own existence is the real signal that this session had a
    // Claude app-server turn — NOT entry.cliSessionBindings (the
    // openclaw-pg9 provider-owned-session marker). That marker is only
    // written by a turn completing AFTER that fix landed, so gating on it
    // silently hid every older conversation whose binding predates it.
    const binding = await deps.readBinding({ sessionKey, sessionId: entry.sessionId });
    if (!binding) {
      continue;
    }
    rows.push({ label: entry.origin?.label ?? sessionKey, sessionKey, binding });
  }
  return { rows, candidateCount };
}

export function formatConversationsList(
  rows: readonly ConversationRow[],
  candidateCount: number,
): string {
  if (rows.length === 0) {
    return candidateCount === 0
      ? "**Claude conversations**\n\nNo other real conversation sessions found for this agent yet."
      : `**Claude conversations**\n\nFound ${candidateCount} other real conversation session(s), but none have a bound Claude thread yet (no turn has completed through the Claude app-server harness for them).`;
  }
  const sorted = rows.toSorted((a, b) => b.binding.updatedAt - a.binding.updatedAt);
  const top = sorted.slice(0, CONVERSATIONS_LIST_LIMIT);

  const lines = ["**Claude conversations**", ""];
  lines.push(
    `Showing ${top.length} of ${sorted.length} conversation(s) with a bound Claude thread (use \`/claude resume <thread_id>\` in that conversation to rejoin one):`,
  );
  lines.push("");
  for (const row of top) {
    lines.push(`- **${row.label}**`);
    lines.push(`  - Thread: \`${row.binding.threadId}\``);
    if (row.binding.model) {
      const providerSuffix = row.binding.modelProvider ? ` (${row.binding.modelProvider})` : "";
      lines.push(`  - Model: ${row.binding.model}${providerSuffix}`);
    }
    if (typeof row.binding.turnCount === "number") {
      lines.push(`  - Turns: ${row.binding.turnCount}`);
    }
    if (row.binding.lastAssistantPreview) {
      lines.push(`  - Last reply: ${row.binding.lastAssistantPreview}`);
    }
    lines.push(`  - Updated: ${new Date(row.binding.updatedAt).toISOString()}`);
  }
  if (sorted.length > top.length) {
    lines.push("", `_${sorted.length - top.length} more not shown._`);
  }
  return lines.join("\n");
}

/**
 * Reads `conversations.excludePatterns` off a resolved plugin config object.
 * Defensive against the config being absent/malformed — an unusable value
 * just yields no exclusions rather than throwing.
 */
export function resolveConversationsExcludePatterns(pluginConfig: unknown): string[] {
  const conversations = (
    pluginConfig as { conversations?: { excludePatterns?: unknown } } | undefined
  )?.conversations;
  const raw = conversations?.excludePatterns;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter((p): p is string => typeof p === "string" && p.trim().length > 0);
}

/**
 * Case-insensitive substring match against either the session's key or its
 * display label — whichever the operator finds easier to target. A channel
 * rename only affects the label; the session key (and any channel id baked
 * into it) stays stable, so matching both sides covers either angle.
 */
export function isExcludedByCustomFilter(
  row: Pick<ConversationRow, "sessionKey" | "label">,
  excludePatterns: readonly string[],
): boolean {
  if (excludePatterns.length === 0) {
    return false;
  }
  const haystack = `${row.sessionKey} ${row.label}`.toLowerCase();
  return excludePatterns.some((pattern) => haystack.includes(pattern.trim().toLowerCase()));
}

export async function handleConversations(
  ctx: PluginCommandContext,
  bindingStore: ClaudeAppServerBindingStore,
  options?: { pluginConfig?: unknown; resolvePluginConfig?: () => unknown },
): Promise<PluginCommandResult> {
  if (!ctx.sessionKey) {
    return {
      text: "**Claude conversations**\n\nNo session key available for this invocation; run `/claude conversations` from an active agent session.",
    };
  }
  const { resolveAgentIdFromSessionKey } = await import("openclaw/plugin-sdk/session-key-runtime");
  const { listSessionEntries } = await import("openclaw/plugin-sdk/session-store-runtime");
  const agentId = resolveAgentIdFromSessionKey(ctx.sessionKey);
  const entries = listSessionEntries({ agentId }) as unknown as ConversationSessionEntry[];
  const { rows, candidateCount } = await buildConversationRows(entries, {
    readBinding: (identity) => safeReadBinding(bindingStore, identity),
  });
  const excludePatterns = resolveConversationsExcludePatterns(
    options?.resolvePluginConfig?.() ?? options?.pluginConfig,
  );
  const visibleRows = rows.filter((row) => !isExcludedByCustomFilter(row, excludePatterns));
  return { text: formatConversationsList(visibleRows, candidateCount) };
}

export async function handleResume(
  ctx: PluginCommandContext,
  rest: string,
  bindingStore: ClaudeAppServerBindingStore,
): Promise<PluginCommandResult> {
  const identity = commandSessionIdentity(ctx);
  if (!identity) {
    return {
      text: "**/claude resume**\n\nNo session is bound to this invocation; run from an active agent session.",
    };
  }
  const targetThreadId = rest.trim();
  if (!targetThreadId) {
    return {
      text: "**/claude resume**\n\nUsage: `/claude resume <thread_id>` — rotates the current session's claude binding to the given thread on the next turn.",
    };
  }
  // Inside the lifecycle lock: an in-flight turn's read-classify-write for
  // this session must not interleave with the rebind, or its trailing binding
  // write would silently revert the thread id the user just selected.
  const pushedFrom = await bindingStore.withLifecycleLock(identity, async () => {
    const existing = await safeReadBinding(bindingStore, identity);
    // Push the thread we're switching AWAY from onto the back-stack, so
    // `/claude thread-pop` can bring the user back without needing to already
    // know the id. Only push a real switch (skip if resuming to the same
    // thread, or if there was no prior thread to leave behind).
    const from =
      existing?.threadId && existing.threadId !== targetThreadId ? existing.threadId : undefined;
    const threadStack = from
      ? [...(existing?.threadStack ?? []), from].slice(-THREAD_STACK_MAX)
      : existing?.threadStack;
    await bindingStore.write(
      identity,
      existing
        ? { ...existing, threadId: targetThreadId, threadStack, createdAt: existing.createdAt }
        : { threadId: targetThreadId, cwd: process.cwd() },
    );
    return from;
  });
  return {
    text: `**/claude resume**\n\nRebound session to thread \`${targetThreadId}\`. Next turn will issue \`thread/resume\` instead of \`thread/start\`.${pushedFrom ? ` (\`${pushedFrom}\` pushed onto the back-stack — \`/claude thread-pop\` returns to it.)` : ""}`,
  };
}

export async function handleThreadPop(
  ctx: PluginCommandContext,
  bindingStore: ClaudeAppServerBindingStore,
): Promise<PluginCommandResult> {
  const identity = commandSessionIdentity(ctx);
  if (!identity) {
    return {
      text: "**/claude thread-pop**\n\nNo session is bound to this invocation; run from an active agent session.",
    };
  }
  // Same lifecycle-lock discipline as handleResume: never interleave with an
  // in-flight turn's binding read-classify-write for this session.
  const popped = await bindingStore.withLifecycleLock(identity, async () => {
    const existing = await safeReadBinding(bindingStore, identity);
    const stack = existing?.threadStack ?? [];
    if (!existing || stack.length === 0) {
      return null;
    }
    const poppedThreadId = stack[stack.length - 1] as string;
    const remainingStack = stack.slice(0, -1);
    await bindingStore.write(identity, {
      ...existing,
      threadId: poppedThreadId,
      threadStack: remainingStack,
      createdAt: existing.createdAt,
    });
    return { poppedThreadId, remaining: remainingStack.length };
  });
  if (!popped) {
    return {
      text: "**/claude thread-pop**\n\nNo previous thread on the back-stack — nothing to pop back to. The stack only grows when you switch away from a thread with `/claude resume`.",
    };
  }
  return {
    text: `**/claude thread-pop**\n\nPopped back to thread \`${popped.poppedThreadId}\`. Next turn will issue \`thread/resume\` instead of \`thread/start\`. (${popped.remaining} more on the back-stack.)`,
  };
}

// ── helpers ─────────────────────────────────────────────────────────────────

function commandSessionIdentity(ctx: PluginCommandContext): ClaudeBindingSessionIdentity | null {
  if (!ctx.sessionKey && !ctx.sessionId) {
    return null;
  }
  return claudeBindingSessionIdentity(ctx);
}

async function safeReadBinding(
  bindingStore: ClaudeAppServerBindingStore,
  identity: ClaudeBindingSessionIdentity,
): Promise<ClaudeAppServerBinding | null> {
  try {
    return await bindingStore.read(identity);
  } catch {
    return null;
  }
}

function formatBinding(identity: ClaudeBindingSessionIdentity, b: ClaudeAppServerBinding): string {
  const lines = ["**Claude threads**", ""];
  lines.push(`- Session: \`${identity.sessionKey ?? identity.sessionId}\``);
  lines.push(`- Thread ID: \`${b.threadId}\``);
  if (b.model) {
    const providerSuffix = b.modelProvider ? ` (${b.modelProvider})` : "";
    lines.push(`- Model: ${b.model}${providerSuffix}`);
  }
  lines.push(`- cwd: \`${b.cwd}\``);
  if (b.approvalPolicy) {
    lines.push(`- Approval policy: ${b.approvalPolicy}`);
  }
  if (b.sandbox) {
    lines.push(`- Sandbox: ${b.sandbox.type}`);
  }
  if (b.dynamicToolsFingerprint) {
    lines.push(`- Dynamic tools fingerprint: \`${b.dynamicToolsFingerprint.slice(0, 16)}…\``);
  }
  if (typeof b.turnCount === "number") {
    lines.push(`- Turns completed: ${b.turnCount}`);
  }
  if (b.lastTurnStopReason) {
    lines.push(`- Last stop reason: ${b.lastTurnStopReason}`);
  }
  if (b.lastTurnUsage) {
    const { input, output, total } = b.lastTurnUsage;
    lines.push(`- Last turn usage: ${input} in / ${output} out / ${total} total tokens`);
  }
  if (b.lastAssistantPreview) {
    lines.push(`- Last reply: ${b.lastAssistantPreview}`);
  }
  if (b.threadStack && b.threadStack.length > 0) {
    lines.push(
      `- Back-stack: ${b.threadStack.length} thread(s) (\`/claude thread-pop\` to return)`,
    );
  }
  lines.push(`- Updated: ${new Date(b.updatedAt).toISOString()}`);
  return lines.join("\n");
}

async function readPackageVersion(packageJsonPath: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(packageJsonPath, "utf-8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}
