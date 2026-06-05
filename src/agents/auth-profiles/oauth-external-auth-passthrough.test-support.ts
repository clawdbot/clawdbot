/**
 * Passthrough external-auth mocks for OAuth tests.
 * Keeps tests that exercise local stores isolated from runtime external auth
 * overlays and persistence decisions.
 */
import { vi } from "vitest";

vi.mock("./external-auth.js", () => ({
  listRuntimeExternalAuthProfiles: () => [],
  overlayExternalAuthProfiles: <T>(store: T) => store,
  shouldPersistExternalAuthProfile: () => true,
  syncPersistedExternalCliAuthProfiles: <T>(store: T) => store,
}));
