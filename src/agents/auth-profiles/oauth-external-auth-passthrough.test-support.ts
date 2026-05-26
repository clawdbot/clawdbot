import { vi } from "vitest";

vi.mock("./external-auth.js", () => ({
  listRuntimeExternalAuthProfiles: () => [],
  overlayExternalAuthProfiles: <T>(store: T) => store,
  shouldPersistExternalAuthProfile: () => true,
}));
