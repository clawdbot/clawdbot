// Duration-weighted sharding keeps serial Control UI E2E runners from
// clustering the slowest browser suites behind Vitest's equal-file-count hash.
import { statSync } from "node:fs";
import { basename } from "node:path";
import { BaseSequencer, type TestSpecification } from "vitest/node";

// Measured wall seconds per file, medianed over CI runs 32617320781 and
// 32617488420 (2026-08-23) after normalizing each run by its own VM speed; the
// two runs agreed within p10 0.88 / p90 1.17, so these are stable enough to pack
// against. Only the slowest suites are listed: they dominate the tallest shard,
// while the 3.5s median file is interchangeable and rides the byte proxy below.
// Source bytes alone correlate at r=0.79 with duration and mispredict by up to
// 3.6x (0.20-0.73 s/KB), which left the widest shard at 182s against a 130s
// ideal. Refresh by summing `<file> (n tests) <ms>` per file from the
// checks-ui-e2e job logs of two runs.
const UI_E2E_FILE_SECONDS_HINTS = new Map<string, number>([
  ["activity-run-inspector.e2e.test.ts", 15],
  ["agent-file-lifecycle.e2e.test.ts", 22],
  ["board-fixture.e2e.test.ts", 16],
  ["chat-composer-capability-menu.e2e.test.ts", 15],
  ["chat-flow.history-recovery.e2e.test.ts", 18],
  ["chat-flow.media-files.e2e.test.ts", 15],
  ["chat-flow.messaging.e2e.test.ts", 20],
  ["chat-flow.models-reasoning.e2e.test.ts", 18],
  ["chat-flow.navigation-presentation.e2e.test.ts", 15],
  ["chat-flow.streaming.e2e.test.ts", 22],
  ["chat-rail-columns.e2e.test.ts", 25],
  ["chat-retained-pane-hydration.e2e.test.ts", 15],
  ["chat-sidebar-panel-contract.e2e.test.ts", 27],
  ["chat-tool-turn-outcome.e2e.test.ts", 17],
  ["desktop-panel.e2e.test.ts", 16],
  ["device-scope-upgrade.e2e.test.ts", 18],
  ["native-link-routing.e2e.test.ts", 16],
  ["native-nav-sidebar-toggle.e2e.test.ts", 18],
  ["new-session-page.catalog-reconnect.e2e.test.ts", 20],
  ["new-session-page.prompt-attachments.e2e.test.ts", 21],
  ["new-session-page.workspace-memory.e2e.test.ts", 17],
  ["new-session-page.workspace-validation.e2e.test.ts", 19],
  ["question-flow.e2e.test.ts", 15],
  ["service-worker-update.e2e.test.ts", 17],
  ["session-management.groups.e2e.test.ts", 21],
  ["session-management.sidebar.e2e.test.ts", 23],
  ["session-placement.move.e2e.test.ts", 25],
  ["session-progress-hovercard.e2e.test.ts", 19],
  ["sidebar-customization.e2e.test.ts", 16],
  ["update-lifecycle.e2e.test.ts", 16],
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
