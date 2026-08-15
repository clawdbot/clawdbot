// Root-matrix unit-fast config preserves cross-file cleanup when CLI filters bypass lane ownership.
import { nonIsolatedRunnerPath } from "./vitest.shared.config.ts";
import { createUnitFastVitestConfig } from "./vitest.unit-fast.config.ts";

export default createUnitFastVitestConfig(process.env, { runner: nonIsolatedRunnerPath });
