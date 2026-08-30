import { expect, it, vi } from "vitest";

vi.mock("./memory-wiki/src/cli.js", () => {
  throw new Error("memory-wiki CLI loaded during plugin entry import");
});
vi.mock("./policy/src/cli.js", () => {
  throw new Error("policy CLI loaded during plugin entry import");
});
vi.mock("./qa-lab/src/cli.js", () => {
  throw new Error("qa-lab CLI loaded during plugin entry import");
});
vi.mock("./voice-call/src/cli.js", () => {
  throw new Error("voice-call CLI loaded during plugin entry import");
});

const cases = [
  { id: "memory-wiki", load: () => import("./memory-wiki/index.js") },
  { id: "policy", load: () => import("./policy/index.js") },
  { id: "qa-lab", load: () => import("./qa-lab/index.js") },
  { id: "voice-call", load: () => import("./voice-call/index.js") },
] as const;

it.each(cases)("keeps the $id CLI cold while importing its plugin entry", async ({ id, load }) => {
  const { default: plugin } = await load();

  expect(plugin.id).toBe(id);
});
