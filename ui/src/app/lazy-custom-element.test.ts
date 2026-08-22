/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import { waitForFast } from "../test-helpers/wait-for.ts";
import {
  ensureCustomElementDefined,
  LazyCustomElementRequestController,
} from "./lazy-custom-element.ts";

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

describe("optional custom element requests", () => {
  function createRequestHarness() {
    const requestUpdate = vi.fn();
    const host = { requestUpdate, updateComplete: Promise.resolve(true) };
    const retryStale = vi.fn(async () => false);
    const requests = new LazyCustomElementRequestController(host, undefined, retryStale);
    return { requests, retryStale };
  }

  it("publishes loading and error before retrying the canonical load and replaying once", async () => {
    const firstError = new Error("chunk unavailable");
    const { requests } = createRequestHarness();
    const continuation = vi.fn();
    const tagName = uniqueTag();
    const element = {
      tagName,
      label: "test panel",
      loadModule: vi
        .fn<() => Promise<void>>()
        .mockRejectedValueOnce(firstError)
        .mockImplementationOnce(async () => {
          customElements.define(tagName, class extends HTMLElement {});
        }),
    };

    requests.request(element, continuation);

    expect(requests.visibleState).toMatchObject({ status: "loading", element });
    await waitForFast(() =>
      expect(requests.visibleState).toMatchObject({
        status: "error",
        element,
        error: firstError,
        stale: false,
      }),
    );
    expect(continuation).not.toHaveBeenCalled();

    requests.retry();

    expect(requests.visibleState).toMatchObject({ status: "loading", element });
    await waitForFast(() => expect(continuation).toHaveBeenCalledOnce());
    expect(element.loadModule).toHaveBeenCalledTimes(2);
    expect(requests.visibleState).toBeUndefined();
  });

  it("resumes an active request after a foreground request replaces its visible slot", async () => {
    let rejectActive: ((error: Error) => void) | undefined;
    let resolveForeground: (() => void) | undefined;
    const { requests } = createRequestHarness();
    const activeElement = {
      tagName: uniqueTag(),
      label: "active panel",
      loadModule: vi.fn(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectActive = reject;
          }),
      ),
    };
    const foregroundElement = {
      tagName: uniqueTag(),
      label: "command palette",
      loadModule: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveForeground = () => {
              customElements.define(foregroundElement.tagName, class extends HTMLElement {});
              resolve();
            };
          }),
      ),
    };

    requests.requestWhileActive(activeElement, true);
    await waitForFast(() => expect(activeElement.loadModule).toHaveBeenCalledOnce());
    requests.request(foregroundElement);
    await waitForFast(() => expect(foregroundElement.loadModule).toHaveBeenCalledOnce());
    resolveForeground?.();
    await waitForFast(() => expect(requests.visibleState?.element).toBe(activeElement));

    const error = new Error("active chunk unavailable");
    rejectActive?.(error);
    await waitForFast(() =>
      expect(requests.visibleState).toMatchObject({
        element: activeElement,
        error,
        status: "error",
      }),
    );
  });

  it("keeps an active request dismissed until its lifecycle restarts", async () => {
    const error = new Error("active chunk unavailable");
    const { requests } = createRequestHarness();
    const tagName = uniqueTag();
    const element = {
      tagName,
      label: "active panel",
      loadModule: vi
        .fn<() => Promise<void>>()
        .mockRejectedValueOnce(error)
        .mockImplementationOnce(async () => {
          customElements.define(tagName, class extends HTMLElement {});
        }),
    };

    requests.requestWhileActive(element, true);
    await waitForFast(() => expect(requests.visibleState?.status).toBe("error"));
    requests.close();
    requests.requestWhileActive(element, true);

    expect(requests.visibleState).toBeUndefined();
    expect(element.loadModule).toHaveBeenCalledOnce();

    requests.requestWhileActive(element, false);
    requests.requestWhileActive(element, true);
    await waitForFast(() => expect(element.loadModule).toHaveBeenCalledTimes(2));
  });

  it("delegates stale recovery before falling back to the same in-place load", async () => {
    const staleError = new Error("Failed to fetch dynamically imported module: panel-abc.js");
    const { requests, retryStale } = createRequestHarness();
    const continuation = vi.fn();
    const tagName = uniqueTag();
    const element = {
      tagName,
      label: "stale panel",
      loadModule: vi
        .fn<() => Promise<void>>()
        .mockRejectedValueOnce(staleError)
        .mockImplementationOnce(async () => {
          customElements.define(tagName, class extends HTMLElement {});
        }),
    };

    requests.request(element, continuation);
    await waitForFast(() => expect(requests.visibleState?.status).toBe("error"));
    expect(requests.visibleState).toMatchObject({ stale: true });

    requests.retry();

    await waitForFast(() => expect(continuation).toHaveBeenCalledOnce());
    expect(retryStale).toHaveBeenCalledOnce();
    expect(element.loadModule).toHaveBeenCalledTimes(2);
  });

  it("closes a loading request without replaying after its late definition", async () => {
    let resolveLoad: (() => void) | undefined;
    const { requests } = createRequestHarness();
    const continuation = vi.fn();
    const tagName = uniqueTag();
    const element = {
      tagName,
      label: "slow panel",
      loadModule: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveLoad = () => {
              customElements.define(tagName, class extends HTMLElement {});
              resolve();
            };
          }),
      ),
    };

    requests.request(element, continuation);
    expect(requests.visibleState?.status).toBe("loading");
    await waitForFast(() => expect(element.loadModule).toHaveBeenCalledOnce());

    requests.close();
    resolveLoad?.();

    await waitForFast(() => expect(customElements.get(element.tagName)).toBeDefined());
    expect(requests.visibleState).toBeUndefined();
    expect(continuation).not.toHaveBeenCalled();
  });

  it("keeps preload failures silent until an explicit request owns visibility", async () => {
    const error = new Error("chunk unavailable");
    const { requests } = createRequestHarness();
    const element = {
      tagName: uniqueTag(),
      label: "preloaded panel",
      loadModule: vi.fn(async () => {
        throw error;
      }),
    };

    requests.preload(element);
    requests.preload(element);

    await waitForFast(() => expect(element.loadModule).toHaveBeenCalledOnce());
    expect(requests.visibleState).toBeUndefined();

    requests.request(element);
    await waitForFast(() => expect(requests.visibleState?.status).toBe("error"));
    expect(element.loadModule).toHaveBeenCalledTimes(2);
  });
});
