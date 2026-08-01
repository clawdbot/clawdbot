import { afterEach, describe, expect, it } from "vitest";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { formatExecApprovalContinuationSourceOutput } from "./bash-tools.exec-approval-output.js";
import { runExecProcess } from "./bash-tools.exec-runtime.js";

describe("approved exec continuation producer", () => {
  afterEach(() => {
    resetProcessRegistryForTests();
  });

  it.runIf(process.platform !== "win32")(
    "preserves real multiline output beyond the legacy 16k boundary",
    async () => {
      const handle = await runExecProcess({
        command: "/usr/bin/printf 'first line\\n\\tindented\\n\\n'; /usr/bin/printf '%017000d' 0",
        workdir: process.cwd(),
        env: {
          HOME: process.env.HOME ?? "/tmp",
          PATH: process.env.PATH ?? "/usr/bin:/bin",
        },
        usePty: false,
        warnings: [],
        maxOutput: 200_000,
        pendingMaxOutput: 200_000,
        notifyOnExit: false,
        timeoutSec: 10,
      });

      const outcome = await handle.promise;
      expect(outcome.status).toBe("completed");
      const source = formatExecApprovalContinuationSourceOutput([
        { label: "output", value: outcome.aggregated },
      ]);
      expect(source).toContain("first line\n\tindented\n\n");
      expect(source.length).toBeGreaterThan(16_000);
      expect(source).toBe(outcome.aggregated);
    },
  );
});
