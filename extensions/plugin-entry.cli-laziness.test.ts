import { expect, it, vi } from "vitest";

vi.mock("./memory-wiki/src/cli.js", () => {
  throw new Error("memory-wiki CLI eagerly imported");
});
vi.mock("./policy/src/cli.js", () => {
  throw new Error("policy CLI eagerly imported");
});
vi.mock("./qa-lab/src/cli.js", () => {
  throw new Error("qa-lab CLI eagerly imported");
});
vi.mock("./voice-call/src/cli.js", () => {
  throw new Error("voice-call CLI eagerly imported");
});

it.each([
  { id: "memory-wiki", load: () => import("./memory-wiki/index.js") },
  { id: "policy", load: () => import("./policy/index.js") },
  { id: "qa-lab", load: () => import("./qa-lab/index.js") },
  { id: "voice-call", load: () => import("./voice-call/index.js") },
])("imports $id without evaluating its CLI", async ({ id, load }) => {
  expect((await load()).default.id).toBe(id);
});
