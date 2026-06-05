// Re-exported auth wizard test helpers for command tests.
// This keeps command test imports stable while the shared helper lives under test/helpers.

export {
  createAuthTestLifecycle,
  createExitThrowingRuntime,
  createWizardPrompter,
  readAuthProfilesForAgent,
  requireOpenClawAgentDir,
  setupAuthTestEnv,
} from "../../test/helpers/auth-wizard.js";
