import { vi } from "vitest";

// OAuth tests use local stores only; external auth overlays are mocked as
// passthroughs so profile persistence assertions stay focused.
vi.mock("./external-auth.js", () => ({
  listRuntimeExternalAuthProfiles: () => [],
  overlayExternalAuthProfiles: <T>(store: T) => store,
  shouldPersistExternalAuthProfile: () => true,
  syncPersistedExternalCliAuthProfiles: <T>(store: T) => store,
}));
