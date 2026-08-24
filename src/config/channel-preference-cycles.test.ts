/** Covers the shared `preferOver` cycle detection both displacement sites rely on. */
import { describe, expect, it } from "vitest";
import { collectPreferenceCycleComponents } from "./channel-preference-cycles.js";

function edgesFrom(edges: Record<string, readonly string[]>) {
  return (nodeId: string): readonly string[] => edges[nodeId] ?? [];
}

describe("collectPreferenceCycleComponents", () => {
  it("groups a reciprocal pair into one component", () => {
    const components = collectPreferenceCycleComponents(
      ["a", "b"],
      edgesFrom({ a: ["b"], b: ["a"] }),
    );

    expect(components).toEqual([["a", "b"]]);
  });

  // The 2-member reciprocal check holds in neither direction on a longer ring, so a site that
  // only recognizes mutual pairs displaces every member. These two rings pin the length-3 and
  // length-4 cases the shared detection exists for.
  it("groups a three-member ring into one component", () => {
    const components = collectPreferenceCycleComponents(
      ["a", "b", "c"],
      edgesFrom({ a: ["b"], b: ["c"], c: ["a"] }),
    );

    expect(components).toEqual([["a", "b", "c"]]);
  });

  it("groups a four-member ring into one component", () => {
    const components = collectPreferenceCycleComponents(
      ["a", "b", "c", "d"],
      edgesFrom({ a: ["b"], b: ["c"], c: ["d"], d: ["a"] }),
    );

    expect(components).toEqual([["a", "b", "c", "d"]]);
  });

  it("finds nothing in a displacement chain", () => {
    const components = collectPreferenceCycleComponents(
      ["a", "b", "c"],
      edgesFrom({ a: ["b"], b: ["c"] }),
    );

    expect(components).toEqual([]);
  });

  it("merges two rings sharing a member into one component", () => {
    const components = collectPreferenceCycleComponents(
      ["a", "b", "c"],
      edgesFrom({ a: ["b"], b: ["a", "c"], c: ["b"] }),
    );

    expect(components).toEqual([["a", "b", "c"]]);
  });

  it("ignores a self-edge", () => {
    const components = collectPreferenceCycleComponents(["a", "b"], edgesFrom({ a: ["a"] }));

    expect(components).toEqual([]);
  });

  it("ignores an edge pointing outside the node set", () => {
    const components = collectPreferenceCycleComponents(
      ["a", "b"],
      edgesFrom({ a: ["ghost"], ghost: ["a"] }),
    );

    expect(components).toEqual([]);
  });

  // d displaces a and nobody displaces d, so d sits outside the ring: it must not inherit the
  // ring's stand-off just for touching it.
  it("keeps a member pointing into a ring out of the component", () => {
    const components = collectPreferenceCycleComponents(
      ["a", "b", "c", "d"],
      edgesFrom({ a: ["b"], b: ["c"], c: ["a"], d: ["a"] }),
    );

    expect(components).toEqual([["a", "b", "c"]]);
  });

  it("tolerates duplicate nodes and duplicate edges", () => {
    const components = collectPreferenceCycleComponents(
      ["a", "b", "a", "b"],
      edgesFrom({ a: ["b", "b"], b: ["a", "a"] }),
    );

    expect(components).toEqual([["a", "b"]]);
  });

  it("orders components and members by first occurrence in the input", () => {
    const nodes = ["c", "z", "y", "a", "b"];
    const edges = edgesFrom({ a: ["b"], b: ["c"], c: ["a"], y: ["z"], z: ["y"] });

    const first = collectPreferenceCycleComponents(nodes, edges);
    const second = collectPreferenceCycleComponents(nodes, edges);

    expect(first).toEqual([
      ["c", "a", "b"],
      ["z", "y"],
    ]);
    expect(second).toEqual(first);
  });
});
