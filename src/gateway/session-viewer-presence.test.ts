import { describe, expect, it, vi } from "vitest";
import { createSessionViewerPresenceDeclarations } from "./session-viewer-presence.js";

describe("session viewer presence declarations", () => {
  it("replaces rather than accumulates connection session keys", () => {
    const onReplace = vi.fn();
    const declarations = createSessionViewerPresenceDeclarations({ onReplace });

    expect(declarations.replace("conn-a", [" beta ", "alpha", "beta"])).toEqual(["alpha", "beta"]);
    expect(declarations.replace("conn-a", ["gamma"])).toEqual(["gamma"]);
    expect(onReplace.mock.calls).toEqual([
      ["conn-a", ["alpha", "beta"]],
      ["conn-a", ["gamma"]],
    ]);
  });

  it("publishes an empty declaration and forgets state on disconnect", () => {
    const onReplace = vi.fn();
    const declarations = createSessionViewerPresenceDeclarations({ onReplace });

    declarations.replace("conn-a", ["alpha"]);
    declarations.replace("conn-a", []);
    declarations.replace("conn-a", ["beta"]);
    declarations.unsubscribe("conn-a");
    declarations.replace("conn-a", ["beta"]);

    expect(onReplace.mock.calls).toEqual([
      ["conn-a", ["alpha"]],
      ["conn-a", []],
      ["conn-a", ["beta"]],
      ["conn-a", ["beta"]],
    ]);
  });

  it("does not republish an unchanged set", () => {
    const onReplace = vi.fn();
    const declarations = createSessionViewerPresenceDeclarations({ onReplace });

    declarations.replace("conn-a", ["beta", "alpha"]);
    declarations.replace("conn-a", ["alpha", "beta"]);

    expect(onReplace).toHaveBeenCalledOnce();
  });
});
