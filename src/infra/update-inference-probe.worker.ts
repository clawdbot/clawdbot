import { createNonExitingRuntime } from "../runtime.js";
import { verifySetupInference } from "../system-agent/setup-inference.js";

// Internal one-shot candidate process. The parent bounds imports, planning, and
// inference together and owns process-tree teardown if the provider stalls.
const runtime = { ...createNonExitingRuntime(), log: () => {}, error: () => {} };
void verifySetupInference({ runtime, timeoutMs: 15_000 }).then(
  (result) => process.exit(result.ok ? 0 : 1),
  () => process.exit(1),
);
