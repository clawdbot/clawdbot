// Duration-weighted sharding keeps serial Control UI E2E runners from
// clustering the slowest browser suites behind Vitest's equal-file-count hash.
import { statSync } from "node:fs";
import { basename } from "node:path";
import { BaseSequencer, type TestSpecification } from "vitest/node";

// Measured wall seconds per file, medianed over the checks-ui-e2e job logs of
// CI runs 33063115103 and 33055390669 (2026-08-27). Only the slowest files are
// listed, and deliberately so: they carry the tallest shard, while the ~4s
// median file is interchangeable and rides the byte proxy below.
//
// Listing every file does not pay. Cross-validated over runs 33116963478,
// 33117411412, and 33117811987 (weights fit on two runs, shards scored on the
// held-out third), a full 286-file table beat this one by ~13s on the tallest
// shard at 11 shards and by ~0-7s at 13-14, because per-file run-to-run noise
// (p50 16%, p90 40%) swamps the remaining prediction error. Dropping the hints
// entirely does cost real time -- bytes alone correlate at r=0.79, mispredict
// by up to 3.6x, and push the tallest shard from ~222s to ~259s at 11 shards --
// so keep this table sized to the slow tail and re-measure it when that tail
// shifts. The tallest shard is bounded by shard count and the ~116s per-shard
// job floor, not by this map; see the `checks-ui-e2e` note in docs/ci.md.
// Refresh by summing `<file> (n tests) <ms>` per file across two runs' logs.
const UI_E2E_FILE_SECONDS_HINTS = new Map<string, number>([
  ["activity-run-inspector.e2e.test.ts", 23],
  ["agent-file-lifecycle.e2e.test.ts", 35],
  ["appearance-settings-defaults.e2e.test.ts", 19],
  ["board-fixture.e2e.test.ts", 25],
  ["board-mcp-app.e2e.test.ts", 12],
  ["board-split-transcript.e2e.test.ts", 14],
  ["browser-dictation-status.e2e.test.ts", 14],
  ["browser-talk-start-stop.e2e.test.ts", 25],
  ["channels-whatsapp-logout.e2e.test.ts", 11],
  ["chat-code-block-fences.e2e.test.ts", 16],
  ["chat-composer-capability-menu.e2e.test.ts", 22],
  ["chat-composer-catalog.e2e.test.ts", 14],
  ["chat-composer-redesign.e2e.test.ts", 11],
  ["chat-flow.active-run-follow-ups.e2e.test.ts", 24],
  ["chat-flow.clipboard.e2e.test.ts", 50],
  ["chat-flow.history-recovery.e2e.test.ts", 20],
  ["chat-flow.media-files.e2e.test.ts", 19],
  ["chat-flow.messaging.e2e.test.ts", 31],
  ["chat-flow.models-reasoning.e2e.test.ts", 28],
  ["chat-flow.navigation-presentation.e2e.test.ts", 15],
  ["chat-flow.queue-edit.e2e.test.ts", 12],
  ["chat-flow.sidebar-presentation.e2e.test.ts", 12],
  ["chat-flow.streaming.e2e.test.ts", 20],
  ["chat-pull-requests.e2e.test.ts", 14],
  ["chat-rail-columns.e2e.test.ts", 36],
  ["chat-reply-preview-recovery.e2e.test.ts", 15],
  ["chat-retained-pane-hydration.e2e.test.ts", 15],
  ["chat-run-lifecycle.e2e.test.ts", 13],
  ["chat-session-diff.e2e.test.ts", 15],
  ["chat-sidebar-panel-contract.e2e.test.ts", 35],
  ["chat-stream-runtime-budgets.e2e.test.ts", 30],
  ["chat-tool-turn-outcome.e2e.test.ts", 32],
  ["chat-transcript-disclosure-anchor.e2e.test.ts", 40],
  ["claude-sessions.e2e.test.ts", 13],
  ["cloud-workers-settings.e2e.test.ts", 12],
  ["cloud-workspace-conflict.e2e.test.ts", 22],
  ["composer-draft-store.e2e.test.ts", 16],
  ["config-safe-write.e2e.test.ts", 14],
  ["cron-filters.e2e.test.ts", 17],
  ["desktop-panel.e2e.test.ts", 27],
  ["device-scope-upgrade.e2e.test.ts", 19],
  ["device-token-reconnect.e2e.test.ts", 12],
  ["github-link-hovercard.e2e.test.ts", 11],
  ["initial-connect-splash.e2e.test.ts", 16],
  ["lobster-pet-dismiss-menu-overflow.e2e.test.ts", 12],
  ["locale-offline-retry.e2e.test.ts", 13],
  ["mobile-pairing.e2e.test.ts", 12],
  ["model-providers.e2e.test.ts", 13],
  ["model-setup.e2e.test.ts", 12],
  ["native-link-routing.e2e.test.ts", 16],
  ["native-nav-sidebar-toggle.e2e.test.ts", 24],
  ["new-session-page.catalog-reconnect.e2e.test.ts", 23],
  ["new-session-page.cloud-dispatch.e2e.test.ts", 38],
  ["new-session-page.device-dispatch.e2e.test.ts", 17],
  ["new-session-page.operator-scopes.e2e.test.ts", 17],
  ["new-session-page.prompt-attachments.e2e.test.ts", 18],
  ["new-session-page.workspace-memory.e2e.test.ts", 21],
  ["new-session-page.workspace-validation.e2e.test.ts", 33],
  ["operator-admin.e2e.test.ts", 12],
  ["question-flow.e2e.test.ts", 24],
  ["service-worker-update.e2e.test.ts", 22],
  ["session-dashboard.e2e.test.ts", 14],
  ["session-management.archive.e2e.test.ts", 16],
  ["session-management.delete.e2e.test.ts", 16],
  ["session-management.group-defaults.e2e.test.ts", 16],
  ["session-management.groups.e2e.test.ts", 31],
  ["session-management.sidebar.e2e.test.ts", 26],
  ["session-ownership.e2e.test.ts", 39],
  ["session-placement.move.e2e.test.ts", 34],
  ["session-progress-hovercard.e2e.test.ts", 19],
  ["settings-prefs-reconnect.e2e.test.ts", 19],
  ["sidebar-account-footer.e2e.test.ts", 17],
  ["sidebar-customization.e2e.test.ts", 17],
  ["sidebar-interactions.e2e.test.ts", 11],
  ["sidebar-transient-surfaces.e2e.test.ts", 13],
  ["theme-muted-contrast.e2e.test.ts", 18],
  ["theme-typography.e2e.test.ts", 15],
  ["update-coalesced.e2e.test.ts", 16],
  ["update-confirmation.e2e.test.ts", 17],
  ["update-lifecycle.e2e.test.ts", 20],
]);

// Median seconds per KB across all 247 measured suites. Unlisted files -- new
// tests included -- keep rebalancing automatically off their source size.
const UI_E2E_FALLBACK_SECONDS_PER_KB = 0.38;

type ShardBucket = {
  seconds: number;
  files: TestSpecification[];
};

function estimateFileSeconds(moduleId: string): number {
  const hint = UI_E2E_FILE_SECONDS_HINTS.get(basename(moduleId));
  if (hint !== undefined) {
    return hint;
  }
  return (statSync(moduleId).size / 1024) * UI_E2E_FALLBACK_SECONDS_PER_KB;
}

export class UiE2eSequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    // Vitest invokes shard() only when config.shard is present.
    const { count, index } = this.ctx.config.shard!;
    const buckets: ShardBucket[] = Array.from({ length: count }, () => ({
      seconds: 0,
      files: [],
    }));
    const weightedFiles = files
      .map((file) => ({ seconds: estimateFileSeconds(file.moduleId), file }))
      .sort(
        (left, right) =>
          right.seconds - left.seconds || left.file.moduleId.localeCompare(right.file.moduleId),
      );

    for (const weightedFile of weightedFiles) {
      const bucket = buckets.reduce((lightest, candidate) =>
        candidate.seconds < lightest.seconds ? candidate : lightest,
      );
      bucket.seconds += weightedFile.seconds;
      bucket.files.push(weightedFile.file);
    }

    return buckets[index - 1]!.files;
  }
}
