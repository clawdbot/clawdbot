/**
 * Real-runtime proof for the `/claude conversations` subcommand.
 *
 * What's real vs stubbed:
 * - REAL: listSessionEntries (plugin-sdk/session-store-runtime) reading
 *   Tank's actual, live sessions.json store on this box (~5,300+ entries).
 * - REAL: thread bindings read from the claude plugin's actual SQLite
 *   plugin-state namespace in the shared state DB (state/openclaw.sqlite).
 * - Nothing stubbed. This is read-only — it does not write or mutate any
 *   session or plugin state.
 *
 * Note: bindings only exist for sessions whose turns ran AFTER the
 * sidecar-to-SQLite binding migration; on a freshly migrated box the
 * row assertions fail until real Claude turns repopulate the store.
 *
 * Run: pnpm tsx scripts/proof-conversations-command.ts
 */

import {
  CLAUDE_APP_SERVER_BINDING_MAX_ENTRIES,
  CLAUDE_APP_SERVER_BINDING_NAMESPACE,
  createClaudeAppServerBindingStore,
  type StoredClaudeAppServerBinding,
} from "../extensions/claude/src/app-server/thread-store.js";
import {
  buildConversationRows,
  formatConversationsList,
  isConversationSessionKey,
  isExcludedByCustomFilter,
  resolveConversationsExcludePatterns,
  type ConversationSessionEntry,
} from "../extensions/claude/src/command-handlers.js";
import { createPluginStateSyncKeyedStore } from "../src/plugin-state/plugin-state-store.js";

let assertions = 0;
function assert(condition: boolean, message: string): void {
  assertions += 1;
  if (!condition) {
    throw new Error(`ASSERTION FAILED: ${message}`);
  }
  console.log(`✓ ${message}`);
}

async function main(): Promise<void> {
  const { listSessionEntries } = await import("openclaw/plugin-sdk/session-store-runtime");
  const agentId = "tank";
  const rawEntries = listSessionEntries({ agentId });
  assert(
    rawEntries.length > 0,
    `listSessionEntries returned ${rawEntries.length} real entries for agentId=tank`,
  );

  const automationCount = rawEntries.filter((e) => !isConversationSessionKey(e.sessionKey)).length;
  assert(
    automationCount > 0,
    `filtered out ${automationCount} automation (subagent/cron/heartbeat) session keys`,
  );

  // Same store shape openClaudeAppServerBindingStore opens through the plugin
  // runtime, minus the runtime proxy — read-only against the live rows.
  const bindingStore = createClaudeAppServerBindingStore(
    createPluginStateSyncKeyedStore<StoredClaudeAppServerBinding>("claude", {
      namespace: CLAUDE_APP_SERVER_BINDING_NAMESPACE,
      maxEntries: CLAUDE_APP_SERVER_BINDING_MAX_ENTRIES,
      overflowPolicy: "evict-oldest",
    }),
  );

  const entries = rawEntries as unknown as ConversationSessionEntry[];
  const { rows, candidateCount } = await buildConversationRows(entries, {
    readBinding: (identity) => bindingStore.read(identity),
  });
  assert(
    candidateCount > 0,
    `found ${candidateCount} real conversation session(s) with a sessionId`,
  );
  assert(rows.length > 0, `resolved ${rows.length} real conversation(s) with a stored binding`);

  const text = formatConversationsList(rows, candidateCount);
  assert(text.includes("Claude conversations"), "formatted output has the expected header");
  console.log("\n--- Real /claude conversations output for agentId=tank ---\n");
  console.log(text);

  // Custom filter proof: excluding the real "cio-agent-heartbeats" Slack
  // channel (present in this box's actual session store) should measurably
  // shrink the visible row count.
  const excludePatterns = resolveConversationsExcludePatterns({
    conversations: { excludePatterns: ["cio-agent-heartbeats"] },
  });
  const visibleRows = rows.filter((row) => !isExcludedByCustomFilter(row, excludePatterns));
  assert(
    visibleRows.length < rows.length,
    `excludePatterns:["cio-agent-heartbeats"] filtered ${rows.length - visibleRows.length} real row(s) (${rows.length} -> ${visibleRows.length})`,
  );
  const filteredText = formatConversationsList(visibleRows, candidateCount);
  assert(
    !filteredText.toLowerCase().includes("cio-agent-heartbeats"),
    "filtered output no longer mentions the excluded channel",
  );
  console.log('\n--- Same output with excludePatterns:["cio-agent-heartbeats"] ---\n');
  console.log(filteredText);

  console.log(`\nAll ${assertions} runtime assertions passed.`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
