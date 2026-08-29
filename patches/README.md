# Temporary dependency patches

`@vitest/runner@4.1.11` has an approved temporary pnpm patch for lost trailing task updates. It accepts the exact batching deadline and clears the consumed timer handle before re-entering the throttle, allowing an early callback to rearm. The 100 ms batching interval and immediate-call cancellation stay unchanged; this is not a maintained fork or a reporting SLA.

Remove the runner patch, its registration, and its exact-version guard exception when upgrading to an upstream fixed version with `test/scripts/vitest-runner-task-updates.test.ts` green. Keep that regression to verify completion delivery without later task events or file-finalization rescue. Generate and register patches through pnpm; never edit installed dependency files manually.
