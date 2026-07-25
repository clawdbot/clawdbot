/**
 * Passthrough external-auth mocks for OAuth tests.
 * Keeps tests that exercise local stores isolated from runtime external auth
 * overlays and persistence decisions.
 */
import { afterAll, vi } from "vitest";

vi.mock("./external-auth.js", () => ({
  listRuntimeExternalAuthProfiles: () => [],
  overlayExternalAuthProfiles: <T>(store: T) => store,
  syncPersistedExternalCliAuthProfiles: <T>(store: T) => store,
}));

afterAll(() => {
  vi.doUnmock("./external-auth.js");
  vi.resetModules();
});
