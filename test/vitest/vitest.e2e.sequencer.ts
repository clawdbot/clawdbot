import { statSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { BaseSequencer, type TestSpecification } from "vitest/node";
import { readRepoE2eFileTimings } from "../../scripts/lib/ci-test-timings.mts";
import { selectWeightedShard } from "./vitest.weighted-sharding.ts";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

export class RepoE2eSequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const timings = readRepoE2eFileTimings();
    const estimates = new Map(
      files.map((file) => {
        const repoPath = relative(repoRoot, file.moduleId).replaceAll("\\", "/");
        return [file, { bytes: statSync(file.moduleId).size, seconds: timings[repoPath] }];
      }),
    );
    let measuredSeconds = 0;
    let measuredBytes = 0;
    for (const { bytes, seconds } of estimates.values()) {
      if (seconds !== undefined) {
        measuredSeconds += seconds;
        measuredBytes += bytes;
      }
    }
    // New files use the observed seconds/byte scale. With no measurements,
    // source size alone balances every discovered file without a fixed inventory.
    const secondsPerByte = measuredBytes > 0 ? measuredSeconds / measuredBytes : 1;
    return selectWeightedShard(files, this.ctx.config.shard!, (file) => {
      const { bytes, seconds } = estimates.get(file)!;
      return seconds ?? bytes * secondsPerByte;
    });
  }
}
