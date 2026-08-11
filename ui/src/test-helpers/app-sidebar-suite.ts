import { beforeEach, vi } from "vitest";
import { confirmDangerous } from "../components/confirm-dialog.ts";
import { setupSidebarTest } from "./app-sidebar.ts";

// The sidebar session mutations confirm in-page through confirmDangerous.
// Group-delete cases drive the real dialog DOM, while session delete/stop
// cases override it per call; default to the real implementation so both
// shapes keep working in this shared suite.
vi.mock("../components/confirm-dialog.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../components/confirm-dialog.ts")>();
  return { ...actual, confirmDangerous: vi.fn(actual.confirmDangerous) };
});

beforeEach(() => {
  vi.mocked(confirmDangerous).mockClear();
});

setupSidebarTest();
