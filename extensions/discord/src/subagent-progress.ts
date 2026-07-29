// Discord plugin module maps portable subagent progress onto source-message feedback.
import { resolveDiscordAccount } from "./accounts.js";
import { reactMessageDiscord, removeReactionDiscord } from "./send.reactions.js";
import { sendTypingDiscord } from "./send.typing.js";
import {
  FAILURE_EMOJI,
  RUNNING_EMOJIS,
  reactionsAreAvailable,
  reservedReactionEmojis,
  resolveDiscordProgressTarget,
  type DiscordProgressRequester,
} from "./subagent-progress-config.js";
import {
  MAX_TRACKED_RUNS,
  PROGRESS_STORE_TTL_MS,
  consumeProgressRun,
  getProgressStore,
  listProgressStateForKey,
  logFailure,
  lookupProgressRun,
  markRunTerminal,
  markProgressRunForCleanup,
  persistedProgressRunFromTracker,
  persistedTerminalOutcome,
  persistProgressRun,
  resetDiscordSubagentProgressStateForTest,
  runQueued,
  terminalOutcome,
  type PersistedProgressRun,
  type PersistProgressResult,
  type ProgressApi,
  type ProgressTracker,
  type SubagentProgressOutcome,
} from "./subagent-progress-state.js";

const TYPING_INTERVAL_MS = 8_500;
const TYPING_TTL_MS = 60 * 60_000;
const TERMINAL_LOOKUP_RETRY_MS = 1_000;
const TERMINAL_RETRY_MAX_DELAY_MS = 60 * 60_000;
const TERMINAL_RETRY_MAX_ATTEMPTS = 12;
const STARTUP_RETRY_MAX_ATTEMPTS = 12;

type SubagentProgressEvent =
  | {
      phase: "started";
      runId: string;
      requester?: DiscordProgressRequester;
    }
  | {
      phase: "ended";
      runId: string;
      outcome: SubagentProgressOutcome;
      requester?: Extract<SubagentProgressEvent, { phase: "started" }>["requester"];
    };

type PersistedReconciliationResult =
  | { ok: false }
  | {
      ok: true;
      activeRunIds: string[];
      reactionsEnabled: boolean;
      typingEnabled: boolean;
      runningEmoji?: string;
    };
type StartupRecovery = { attempts: number; timer?: ReturnType<typeof setTimeout> };

const trackers = new Map<string, ProgressTracker>();

const trackerKeyByRunId = new Map<string, string>();
const terminalRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const terminalRetryExpiresAt = new Map<string, number>();
const terminalRetryAttempts = new Map<string, number>();
const startupRecoveryRetries = new Map<ProgressApi, StartupRecovery>();

function isSubagentProgressEnabled(account: ReturnType<typeof resolveDiscordAccount>): boolean {
  return Boolean(process.env.VITEST) && account.enabled && account.config.subagentProgress === true;
}

function clearTerminalRetry(runId: string) {
  const timer = terminalRetryTimers.get(runId);
  if (timer) {
    clearTimeout(timer);
  }
  terminalRetryTimers.delete(runId);
  terminalRetryExpiresAt.delete(runId);
  terminalRetryAttempts.delete(runId);
}

function cancelTerminalRetryTimer(runId: string) {
  const timer = terminalRetryTimers.get(runId);
  if (timer) {
    clearTimeout(timer);
  }
  terminalRetryTimers.delete(runId);
}

async function setReaction(api: ProgressApi, tracker: ProgressTracker, emoji: string) {
  try {
    const result = await reactMessageDiscord(tracker.channelId, tracker.messageId, emoji, {
      cfg: api.config,
      accountId: tracker.accountId,
    });
    return result.ok;
  } catch (error) {
    logFailure(api, "reaction add", error);
    return false;
  }
}

async function clearReaction(api: ProgressApi, tracker: ProgressTracker, emoji?: string) {
  if (!emoji) {
    return true;
  }
  try {
    const result = await removeReactionDiscord(tracker.channelId, tracker.messageId, emoji, {
      cfg: api.config,
      accountId: tracker.accountId,
    });
    return result.ok;
  } catch (error) {
    logFailure(api, "reaction remove", error);
    return false;
  }
}

async function clearRunningReactions(
  api: ProgressApi,
  tracker: ProgressTracker,
  emojis: readonly string[],
) {
  const results = await Promise.all(emojis.map((emoji) => clearReaction(api, tracker, emoji)));
  return results.every(Boolean);
}

async function persistTrackerRunningEmoji(api: ProgressApi, tracker: ProgressTracker) {
  const store = getProgressStore(api);
  if (!store) {
    return false;
  }
  try {
    await Promise.all(
      Array.from(tracker.persistedRunIds, (runId) =>
        store.register(runId, persistedProgressRunFromTracker(tracker)),
      ),
    );
    return true;
  } catch (error) {
    logFailure(api, "reaction ownership write", error);
    return false;
  }
}

async function updateRunningReaction(api: ProgressApi, tracker: ProgressTracker) {
  if (!tracker.reactionsEnabled) {
    return true;
  }
  const nextEmoji =
    tracker.activeRunIds.size > 0
      ? RUNNING_EMOJIS[Math.min(tracker.activeRunIds.size, RUNNING_EMOJIS.length) - 1]
      : undefined;
  if (nextEmoji === tracker.runningEmoji) {
    if (!nextEmoji || tracker.runningEmojiConfirmed) {
      return true;
    }
    if (!(await persistTrackerRunningEmoji(api, tracker))) {
      return false;
    }
    tracker.runningEmojiConfirmed = await setReaction(api, tracker, nextEmoji);
    return tracker.runningEmojiConfirmed;
  }
  if (!(await clearReaction(api, tracker, tracker.runningEmoji))) {
    return false;
  }
  tracker.runningEmoji = undefined;
  tracker.runningEmojiConfirmed = false;
  if (nextEmoji) {
    // A lost add response may still have applied; keep attempted ownership for cleanup.
    tracker.runningEmoji = nextEmoji;
    if (!(await persistTrackerRunningEmoji(api, tracker))) {
      tracker.runningEmoji = undefined;
      return false;
    }
    tracker.runningEmojiConfirmed = await setReaction(api, tracker, nextEmoji);
    return tracker.runningEmojiConfirmed;
  }
  await persistTrackerRunningEmoji(api, tracker);
  return true;
}

async function disableTrackerReactionsOnCollision(
  api: ProgressApi,
  tracker: ProgressTracker,
  ackReaction?: string,
) {
  if (!tracker.reactionsEnabled || reactionsAreAvailable(api.config, ackReaction)) {
    return true;
  }
  const reserved = reservedReactionEmojis(api.config, ackReaction);
  if (tracker.runningEmoji && !reserved.has(tracker.runningEmoji)) {
    if (!(await clearReaction(api, tracker, tracker.runningEmoji))) {
      tracker.reactionsEnabled = false;
      return false;
    }
  }
  tracker.runningEmoji = undefined;
  tracker.runningEmojiConfirmed = false;
  tracker.reactionsEnabled = false;
  await persistTrackerRunningEmoji(api, tracker);
  return true;
}

async function sendTyping(api: ProgressApi, tracker: ProgressTracker) {
  try {
    await sendTypingDiscord(tracker.channelId, {
      cfg: api.config,
      accountId: tracker.accountId,
    });
  } catch (error) {
    logFailure(api, "typing", error);
  }
}

function startTyping(api: ProgressApi, tracker: ProgressTracker) {
  tracker.typingExpiresAt = Date.now() + TYPING_TTL_MS;
  void sendTyping(api, tracker);
  if (tracker.typingTimer) {
    return;
  }
  tracker.typingTimer = setInterval(() => {
    if (tracker.activeRunIds.size === 0 || Date.now() >= tracker.typingExpiresAt) {
      stopTyping(tracker);
      return;
    }
    void sendTyping(api, tracker);
  }, TYPING_INTERVAL_MS);
  tracker.typingTimer.unref?.();
}

function stopTyping(tracker: ProgressTracker) {
  if (tracker.typingTimer) {
    clearInterval(tracker.typingTimer);
    tracker.typingTimer = undefined;
  }
}

async function handleStarted(
  api: ProgressApi,
  event: Extract<SubagentProgressEvent, { phase: "started" }>,
) {
  const runId = event.runId.trim();
  const target = resolveDiscordProgressTarget(event.requester);
  if (!runId || !target || terminalOutcome(runId)) {
    return;
  }
  const account = resolveDiscordAccount({ cfg: api.config, accountId: event.requester?.accountId });
  const key = `${account.accountId}:${target.channelId}:${target.messageId}`;
  if (!isSubagentProgressEnabled(account)) {
    await runQueued(key, async () => {
      const tracker = trackers.get(key);
      if (!tracker) {
        return;
      }
      stopTyping(tracker);
      tracker.reactionsEnabled = false;
      if (!account.enabled || !tracker.runningEmoji) {
        return;
      }
      const reserved = reservedReactionEmojis(api.config, account.config.ackReaction);
      if (
        !reserved.has(tracker.runningEmoji) &&
        (await clearReaction(api, tracker, tracker.runningEmoji))
      ) {
        tracker.runningEmoji = undefined;
        tracker.runningEmojiConfirmed = false;
        await persistTrackerRunningEmoji(api, tracker);
      }
    });
    return;
  }
  await runQueued(key, async () => {
    let tracker = trackers.get(key);
    let restoredCurrentRunWasTerminal = false;
    if (!tracker) {
      const reactionsEnabled = reactionsAreAvailable(api.config, account.config.ackReaction);
      const restored = await listProgressStateForKey(api, key);
      if (!restored.ok) {
        return;
      }
      restoredCurrentRunWasTerminal = restored.cleanupRuns.some(
        (cleanup) => cleanup.runId === runId,
      );
      tracker = {
        accountId: account.accountId,
        channelId: target.channelId,
        messageId: target.messageId,
        activeRunIds: new Set(restored.activeRunIds),
        persistedRunIds: new Set(restored.activeRunIds),
        runningEmojiConfirmed: false,
        reactionsEnabled,
        typingExpiresAt: 0,
      };
      // Recover post-registration crashes from bot-owned glyphs instead of guessing.
      if (restored.activeRunIds.length > 0 || restored.cleanupRuns.length > 0) {
        const reserved = reservedReactionEmojis(api.config, account.config.ackReaction);
        const cleanupEmojis = restored.ownedEmojis.filter((emoji) => !reserved.has(emoji));
        const countsCleared = await clearRunningReactions(api, tracker, cleanupEmojis);
        const failedCleanupRuns = restored.cleanupRuns.filter(
          (cleanup) => cleanup.value.outcome !== "ok",
        );
        const failurePresented =
          failedCleanupRuns.length === 0 ||
          !reactionsEnabled ||
          (countsCleared && (await setReaction(api, tracker, FAILURE_EMOJI)));
        if (countsCleared && failurePresented) {
          for (const cleanup of restored.cleanupRuns) {
            markRunTerminal(cleanup.runId, cleanup.value.outcome);
          }
          await Promise.all(
            restored.cleanupRuns.map((cleanup) => consumeProgressRun(api, cleanup.runId)),
          );
        } else {
          tracker.reactionsEnabled = false;
          for (const cleanup of restored.cleanupRuns) {
            scheduleTerminalLookupRetry(
              api,
              {
                phase: "ended",
                runId: cleanup.runId,
                outcome: cleanup.value.outcome,
              },
              cleanup.value,
            );
          }
        }
      }
      trackers.set(key, tracker);
    }
    if (!(await disableTrackerReactionsOnCollision(api, tracker, account.config.ackReaction))) {
      return;
    }
    if (restoredCurrentRunWasTerminal) {
      if (tracker.activeRunIds.size > 0) {
        await updateRunningReaction(api, tracker);
        startTyping(api, tracker);
      } else {
        trackers.delete(key);
      }
      return;
    }
    if (tracker.activeRunIds.has(runId)) {
      trackerKeyByRunId.set(runId, key);
      await updateRunningReaction(api, tracker);
      startTyping(api, tracker);
      return;
    }
    let persistResult: PersistProgressResult = "error";
    if (tracker.reactionsEnabled) {
      persistResult = await persistProgressRun(api, runId, tracker);
      if (persistResult === "terminal") {
        markRunTerminal(runId, "unknown");
        return;
      }
      if (persistResult === "conflict") {
        api.logger.debug?.(`discord subagent progress ignored conflicting run id: ${runId}`);
        return;
      }
      if (persistResult === "error") {
        await clearReaction(api, tracker, tracker.runningEmoji);
        tracker.runningEmoji = undefined;
        tracker.runningEmojiConfirmed = false;
        tracker.reactionsEnabled = false;
      }
    }
    tracker.activeRunIds.add(runId);
    trackerKeyByRunId.set(runId, key);
    if (persistResult === "persisted") {
      tracker.persistedRunIds.add(runId);
    }
    // Tombstone a fast child that ends before presentation so a late start cannot stick.
    const endedOutcome = terminalOutcome(runId);
    if (endedOutcome) {
      const owned = persistedProgressRunFromTracker(tracker);
      await markProgressRunForCleanup(api, runId, owned, endedOutcome);
      const failurePresented =
        endedOutcome === "ok" ||
        !tracker.reactionsEnabled ||
        (await setReaction(api, tracker, FAILURE_EMOJI));
      if (failurePresented) {
        await consumeProgressRun(api, runId);
      } else {
        scheduleTerminalLookupRetry(
          api,
          { phase: "ended", runId, outcome: endedOutcome, requester: event.requester },
          { ...owned, status: "cleanup", outcome: endedOutcome },
        );
      }
      tracker.activeRunIds.delete(runId);
      tracker.persistedRunIds.delete(runId);
      trackerKeyByRunId.delete(runId);
      await updateRunningReaction(api, tracker);
      if (tracker.activeRunIds.size === 0) {
        stopTyping(tracker);
        trackers.delete(key);
      }
      return;
    }
    await updateRunningReaction(api, tracker);
    startTyping(api, tracker);
  });
}

async function reconcilePersistedTracker(
  api: ProgressApi,
  persisted: PersistedProgressRun,
  outcome: Extract<SubagentProgressEvent, { phase: "ended" }>["outcome"],
  endingRunId: string,
): Promise<PersistedReconciliationResult> {
  const store = getProgressStore(api);
  let activeRunIds: string[] = [];
  if (store) {
    try {
      const entries = await store.entries();
      activeRunIds = entries
        .filter(
          (entry) =>
            entry.key !== endingRunId &&
            entry.value.key === persisted.key &&
            entry.value.status === "active",
        )
        .map((entry) => entry.key);
    } catch (error) {
      logFailure(api, "state store list", error);
      return { ok: false };
    }
  }
  const tracker: ProgressTracker = {
    accountId: persisted.accountId,
    channelId: persisted.channelId,
    messageId: persisted.messageId,
    activeRunIds: new Set(activeRunIds),
    persistedRunIds: new Set(activeRunIds),
    runningEmojiConfirmed: false,
    reactionsEnabled: true,
    typingExpiresAt: 0,
  };
  const account = resolveDiscordAccount({ cfg: api.config, accountId: persisted.accountId });
  const typingEnabled = isSubagentProgressEnabled(account);
  const reserved = reservedReactionEmojis(api.config, account.config.ackReaction);
  const cleanupEmojis =
    persisted.runningEmoji && !reserved.has(persisted.runningEmoji) ? [persisted.runningEmoji] : [];
  const reactionsEnabled =
    typingEnabled && reactionsAreAvailable(api.config, account.config.ackReaction);
  // Preserve newly reserved keycaps, but remove every unreserved glyph that
  // this feature could have left behind under the previous configuration.
  const reactionsCleared =
    account.enabled && (await clearRunningReactions(api, tracker, cleanupEmojis));
  const nextEmoji = RUNNING_EMOJIS[Math.min(activeRunIds.length, RUNNING_EMOJIS.length) - 1];
  let countPresented = true;
  if (reactionsEnabled && reactionsCleared && nextEmoji) {
    tracker.runningEmoji = nextEmoji;
    countPresented =
      (await persistTrackerRunningEmoji(api, tracker)) &&
      (await setReaction(api, tracker, nextEmoji));
    tracker.runningEmojiConfirmed = countPresented;
  }
  const outcomePresented =
    outcome === "ok" ||
    !reactionsEnabled ||
    (reactionsCleared && countPresented && (await setReaction(api, tracker, FAILURE_EMOJI)));
  if (!reactionsCleared || !countPresented || !outcomePresented) {
    return { ok: false };
  }
  return {
    ok: true,
    activeRunIds,
    reactionsEnabled,
    typingEnabled,
    ...(reactionsEnabled && nextEmoji ? { runningEmoji: nextEmoji } : {}),
  };
}

function scheduleTerminalLookupRetry(
  api: ProgressApi,
  event: Extract<SubagentProgressEvent, { phase: "ended" }>,
  owned?: PersistedProgressRun,
) {
  const runId = event.runId.trim();
  if (!runId || terminalRetryTimers.has(runId)) {
    return;
  }
  if (!owned) {
    const target = resolveDiscordProgressTarget(event.requester);
    const account = resolveDiscordAccount({
      cfg: api.config,
      accountId: event.requester?.accountId,
    });
    if (!target || !isSubagentProgressEnabled(account)) {
      return;
    }
  }
  if (terminalRetryTimers.size >= MAX_TRACKED_RUNS) {
    return;
  }
  const expiresAt = terminalRetryExpiresAt.get(runId) ?? Date.now() + PROGRESS_STORE_TTL_MS;
  const attempts = terminalRetryAttempts.get(runId) ?? 0;
  if (expiresAt <= Date.now() || attempts >= TERMINAL_RETRY_MAX_ATTEMPTS) {
    clearTerminalRetry(runId);
    return;
  }
  terminalRetryExpiresAt.set(runId, expiresAt);
  terminalRetryAttempts.set(runId, attempts + 1);
  const retryDelayMs = Math.min(
    TERMINAL_LOOKUP_RETRY_MS * 2 ** Math.min(attempts, 12),
    TERMINAL_RETRY_MAX_DELAY_MS,
  );
  const timer = setTimeout(() => {
    terminalRetryTimers.delete(runId);
    void handleEnded(api, event, owned);
  }, retryDelayMs);
  timer.unref?.();
  terminalRetryTimers.set(runId, timer);
}

async function handleEnded(
  api: ProgressApi,
  event: Extract<SubagentProgressEvent, { phase: "ended" }>,
  persistedHint?: PersistedProgressRun,
) {
  const runId = event.runId.trim();
  if (!runId) {
    return;
  }
  markRunTerminal(runId, event.outcome);
  const lookup = await lookupProgressRun(api, runId);
  const persisted = lookup.status === "found" ? lookup.value : persistedHint;
  const key = trackerKeyByRunId.get(runId) ?? persisted?.key;
  if (!key) {
    if (lookup.status === "error") {
      scheduleTerminalLookupRetry(api, event);
    } else {
      clearTerminalRetry(runId);
    }
    return;
  }
  cancelTerminalRetryTimer(runId);
  await runQueued(key, async () => {
    const tracker = trackers.get(key);
    const currentLookup = await lookupProgressRun(api, runId);
    const currentPersisted =
      currentLookup.status === "found"
        ? currentLookup.value
        : currentLookup.status === "error"
          ? (persistedHint ?? persisted)
          : (persistedHint ?? (tracker ? undefined : persisted));
    const outcome =
      persistedTerminalOutcome(currentPersisted) ??
      persistedTerminalOutcome(persisted) ??
      event.outcome;
    const retryEvent = outcome === event.outcome ? event : { ...event, outcome };
    trackerKeyByRunId.delete(runId);
    const owned =
      tracker?.persistedRunIds.has(runId) && currentPersisted?.status !== "cleanup"
        ? persistedProgressRunFromTracker(tracker)
        : currentPersisted;
    const cleanupMarked = owned
      ? owned.status === "cleanup" || (await markProgressRunForCleanup(api, runId, owned, outcome))
      : true;
    if (tracker) {
      const currentAccount = resolveDiscordAccount({
        cfg: api.config,
        accountId: tracker.accountId,
      });
      if (!isSubagentProgressEnabled(currentAccount)) {
        tracker.reactionsEnabled = false;
        stopTyping(tracker);
      } else {
        await disableTrackerReactionsOnCollision(api, tracker, currentAccount.config.ackReaction);
      }
    }
    if (!tracker) {
      const reconciliation = owned
        ? await reconcilePersistedTracker(api, owned, outcome, runId)
        : { ok: false as const };
      if (reconciliation.ok && owned) {
        const consumed = await consumeProgressRun(api, runId);
        if (!consumed) {
          scheduleTerminalLookupRetry(api, retryEvent, owned);
        } else {
          clearTerminalRetry(runId);
        }
        if (reconciliation.typingEnabled && reconciliation.activeRunIds.length > 0) {
          const restoredTracker: ProgressTracker = {
            accountId: owned.accountId,
            channelId: owned.channelId,
            messageId: owned.messageId,
            activeRunIds: new Set(reconciliation.activeRunIds),
            persistedRunIds: new Set(reconciliation.activeRunIds),
            runningEmojiConfirmed: Boolean(reconciliation.runningEmoji),
            reactionsEnabled: reconciliation.reactionsEnabled,
            ...(reconciliation.runningEmoji ? { runningEmoji: reconciliation.runningEmoji } : {}),
            typingExpiresAt: 0,
          };
          trackers.set(key, restoredTracker);
          for (const activeRunId of reconciliation.activeRunIds) {
            trackerKeyByRunId.set(activeRunId, key);
          }
          startTyping(api, restoredTracker);
        }
      } else if (owned) {
        scheduleTerminalLookupRetry(api, retryEvent, owned);
      }
      return;
    }
    tracker.activeRunIds.delete(runId);
    tracker.persistedRunIds.delete(runId);
    const countReconciled = tracker.reactionsEnabled
      ? await updateRunningReaction(api, tracker)
      : owned
        ? (await reconcilePersistedTracker(api, owned, outcome, runId)).ok
        : true;
    const outcomePresented =
      outcome === "ok" ||
      !tracker.reactionsEnabled ||
      (countReconciled && (await setReaction(api, tracker, FAILURE_EMOJI)));
    const reconciled = countReconciled && outcomePresented;
    if (reconciled && owned) {
      const consumed = await consumeProgressRun(api, runId);
      if (!consumed) {
        scheduleTerminalLookupRetry(api, retryEvent, owned);
      } else {
        clearTerminalRetry(runId);
      }
      if (!consumed && !cleanupMarked) {
        await markProgressRunForCleanup(api, runId, owned, outcome);
      }
    } else if (owned) {
      scheduleTerminalLookupRetry(api, retryEvent, owned);
    }
    if (tracker.activeRunIds.size === 0) {
      stopTyping(tracker);
      trackers.delete(key);
    }
  });
}

async function handleDiscordSubagentProgressImpl(api: ProgressApi, event: SubagentProgressEvent) {
  if (event.phase === "started") {
    await handleStarted(api, event);
    return;
  }
  await handleEnded(api, event);
}

function clearStartupRecoveryRetry(api: ProgressApi) {
  const retry = startupRecoveryRetries.get(api);
  if (retry?.timer) {
    clearTimeout(retry.timer);
  }
  startupRecoveryRetries.delete(api);
}

function scheduleStartupRecoveryRetry(api: ProgressApi) {
  const retry = startupRecoveryRetries.get(api) ?? { attempts: 0 };
  if (retry.timer || retry.attempts >= STARTUP_RETRY_MAX_ATTEMPTS) {
    return;
  }
  const delayMs = Math.min(
    TERMINAL_LOOKUP_RETRY_MS * 2 ** retry.attempts,
    TERMINAL_RETRY_MAX_DELAY_MS,
  );
  retry.attempts += 1;
  retry.timer = setTimeout(() => {
    retry.timer = undefined;
    void recoverDiscordSubagentProgress(api);
  }, delayMs);
  retry.timer.unref?.();
  startupRecoveryRetries.set(api, retry);
}

export async function recoverDiscordSubagentProgress(api: ProgressApi) {
  const store = getProgressStore(api);
  if (!store) {
    if (api.runtime?.state) {
      scheduleStartupRecoveryRetry(api);
    }
    return;
  }
  let persistedRuns: Array<{ key: string; value: PersistedProgressRun }>;
  try {
    persistedRuns = await store.entries();
  } catch (error) {
    logFailure(api, "startup recovery list", error);
    scheduleStartupRecoveryRetry(api);
    return;
  }
  clearStartupRecoveryRetry(api);
  // Subagents share the gateway process, so no active run survives a cold
  // start. Replaying every row repairs both interrupted and pending cleanup.
  for (const entry of persistedRuns) {
    await handleEnded(
      api,
      {
        phase: "ended",
        runId: entry.key,
        outcome: persistedTerminalOutcome(entry.value) ?? "unknown",
      },
      entry.value,
    );
  }
}

function resetDiscordSubagentProgressForTest() {
  for (const tracker of trackers.values()) {
    stopTyping(tracker);
  }
  trackers.clear();
  trackerKeyByRunId.clear();
  for (const timer of terminalRetryTimers.values()) {
    clearTimeout(timer);
  }
  terminalRetryTimers.clear();
  terminalRetryExpiresAt.clear();
  terminalRetryAttempts.clear();
  for (const retry of startupRecoveryRetries.values()) {
    if (retry.timer) {
      clearTimeout(retry.timer);
    }
  }
  startupRecoveryRetries.clear();
  resetDiscordSubagentProgressStateForTest();
}

export const handleDiscordSubagentProgress = Object.assign(handleDiscordSubagentProgressImpl, {
  resetForTest: resetDiscordSubagentProgressForTest,
});
