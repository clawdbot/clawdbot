/* @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import {
  dropRepoOwnedCustomElements,
  isRepoOwnedDefineStack,
  jsdomCustomElementDefinitions,
  trackCustomElementRegistry,
} from "./jsdom-custom-elements.ts";

describe("jsdom custom element tracking", () => {
  it("reaches the live jsdom definition list", () => {
    // Contract with jsdom internals: losing this silently restores the stale-class
    // flake, because the shared runner would stop dropping repo-owned tags.
    const definitions = jsdomCustomElementDefinitions(customElements);
    expect(Array.isArray(definitions)).toBe(true);
    customElements.define("openclaw-jsdom-contract-probe", class extends HTMLElement {});
    expect(definitions?.some((entry) => entry.name === "openclaw-jsdom-contract-probe")).toBe(true);
  });

  it("drops repo-owned tags and keeps dependency-owned ones", () => {
    const tracking = trackCustomElementRegistry(customElements);
    if (!tracking) {
      throw new Error("expected a jsdom registry");
    }
    customElements.define("openclaw-repo-owned-probe", class extends HTMLElement {});
    // Dependency packages are externalized and register once per worker, so their
    // definitions must survive a reset that the module graph cannot replay.
    tracking.definitions.push({ name: "wa-dependency-probe" });

    dropRepoOwnedCustomElements(tracking);

    expect(customElements.get("openclaw-repo-owned-probe")).toBeUndefined();
    expect(tracking.definitions.some((entry) => entry.name === "wa-dependency-probe")).toBe(true);
    // A repo module re-evaluated by the next file must be able to register again.
    expect(() =>
      customElements.define("openclaw-repo-owned-probe", class extends HTMLElement {}),
    ).not.toThrow();
  });

  it("attributes a define call to the module that made it", () => {
    const stack = (caller: string) =>
      `Error\n    at define (/repo/test/jsdom-custom-elements.ts:58:9)\n${caller}`;

    expect(isRepoOwnedDefineStack(stack("    at /repo/ui/src/components/tooltip.ts:576:18"))).toBe(
      true,
    );
    expect(
      isRepoOwnedDefineStack(
        stack(
          "    at file:///repo/node_modules/@lit/reactive-element/decorators/custom-element.js:27:24",
        ),
      ),
    ).toBe(false);
    expect(isRepoOwnedDefineStack(undefined)).toBe(false);
  });
});
