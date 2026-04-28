import { vi } from "vitest";

vi.mock("../../config/config.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js");
  return {
    ...actual,
    getRuntimeConfig: () => ({}),
  };
});

export function installSubagentsCommandCoreMocks() {}
