// Zalouser plugin module implements accounts mocks behavior.
import { vi } from "vitest";
import { createDefaultResolvedZalouserAccount } from "./test-helpers.js";

vi.mock("./accounts.js", () => {
  return {
    listZalouserAccountIds: () => ["default"],
    resolveDefaultZalouserAccountId: () => "default",
    resolveZalouserAccountSync: () => createDefaultResolvedZalouserAccount(),
    checkZcaAuthenticated: async () => false,
  };
});
