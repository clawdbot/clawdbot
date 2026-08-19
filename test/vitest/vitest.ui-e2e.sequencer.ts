// Source-size weighted sharding keeps serial Control UI E2E runners from
// clustering the largest browser suites behind Vitest's equal-file-count hash.
import { statSync } from "node:fs";
import { BaseSequencer, type TestSpecification } from "vitest/node";

type ShardBucket = {
  bytes: number;
  files: TestSpecification[];
};

export class UiE2eSequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    // Vitest invokes shard() only when config.shard is present. File size is a
    // zero-state duration proxy, so new and changed tests rebalance automatically.
    const { count, index } = this.ctx.config.shard!;
    const buckets: ShardBucket[] = Array.from({ length: count }, () => ({
      bytes: 0,
      files: [],
    }));
    const weightedFiles = files
      .map((file) => ({ bytes: statSync(file.moduleId).size, file }))
      .sort(
        (left, right) =>
          right.bytes - left.bytes || left.file.moduleId.localeCompare(right.file.moduleId),
      );

    for (const weightedFile of weightedFiles) {
      const bucket = buckets.reduce((lightest, candidate) =>
        candidate.bytes < lightest.bytes ? candidate : lightest,
      );
      bucket.bytes += weightedFile.bytes;
      bucket.files.push(weightedFile.file);
    }

    return buckets[index - 1]!.files;
  }
}
