/**
 * Passthrough external-auth mocks for OAuth tests.
 * Keeps tests that exercise local stores isolated from runtime external auth
 * overlays and persistence decisions.
 */
import { afterAll, vi } from "vitest";

vi.mock("./external-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./external-auth.js")>()),
  syncPersistedExternalCliAuthProfiles: <T>(store: T) => store,
  createExternalAuthRuntime: () => ({
    listRuntimeExternalAuthProfiles: () => [],
    overlayExternalAuthProfiles: <T>(store: T) => store,
  }),
}));

afterAll(() => {
  vi.doUnmock("./external-auth.js");
  vi.resetModules();
});
