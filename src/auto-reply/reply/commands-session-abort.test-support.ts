import { vi } from "vitest";

vi.mock("./queue.js", () => ({
  clearSessionQueues: vi.fn(() => ({ followupCleared: 0, laneCleared: 0, keys: [] })),
}));
