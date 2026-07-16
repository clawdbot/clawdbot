import { vi } from "vitest";

// Unit tests: avoid importing the real chokidar implementation (native fsevents, etc.).
vi.mock("chokidar", () => ({
  default: {
    watch: () => ({ on: () => {}, close: async () => {} }),
  },
  watch: () => ({ on: () => {}, close: async () => {} }),
}));

vi.mock("./sqlite-vec.js", () => ({
  loadSqliteVecExtension: async () => ({ ok: false, error: "sqlite-vec disabled in tests" }),
}));
