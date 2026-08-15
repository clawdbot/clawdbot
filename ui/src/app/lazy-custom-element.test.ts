/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import { ensureCustomElementDefined } from "./lazy-custom-element.ts";

let tagSequence = 0;

function uniqueTag(): string {
  tagSequence += 1;
  return `openclaw-lazy-test-${tagSequence}`;
}

describe("ensureCustomElementDefined", () => {
  it("deduplicates concurrent module loads", async () => {
    const tagName = uniqueTag();
    const loadModule = vi.fn(async () => {
      customElements.define(tagName, class extends HTMLElement {});
    });

    await Promise.all([
      ensureCustomElementDefined(tagName, loadModule),
      ensureCustomElementDefined(tagName, loadModule),
    ]);

    expect(loadModule).toHaveBeenCalledOnce();
    expect(customElements.get(tagName)).toBeDefined();
  });

  it("allows a failed module load to be retried", async () => {
    const tagName = uniqueTag();
    const firstError = new Error("chunk unavailable");
    const loadModule = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(firstError)
      .mockImplementationOnce(async () => {
        customElements.define(tagName, class extends HTMLElement {});
      });

    await expect(ensureCustomElementDefined(tagName, loadModule)).rejects.toBe(firstError);
    await expect(ensureCustomElementDefined(tagName, loadModule)).resolves.toBeUndefined();

    expect(loadModule).toHaveBeenCalledTimes(2);
  });

  it("rejects modules that do not register their declared element", async () => {
    const tagName = uniqueTag();

    await expect(ensureCustomElementDefined(tagName, async () => undefined)).rejects.toThrow(
      `Custom element module did not define ${tagName}`,
    );
  });
});
