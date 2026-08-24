/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./ip-location.ts";

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as Response;
}

// The element resolves through its own fetch, so wait for the asserted text
// rather than a fixed number of update cycles.
async function settleUntil(
  element: HTMLElement & { updateComplete?: Promise<unknown> },
  predicate: () => boolean,
) {
  await vi.waitFor(async () => {
    await element.updateComplete;
    expect(predicate()).toBe(true);
  });
}

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("openclaw-ip-location", () => {
  it("renders the city with its attribution link", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          found: true,
          city: "Vienna",
          region: "Vienna",
          attribution: { text: "IP Geolocation by DB-IP", url: "https://db-ip.com" },
        }),
      ),
    );
    const element = document.createElement("openclaw-ip-location");
    element.ip = "203.0.113.20";
    document.body.append(element);

    await settleUntil(element, () => (element.textContent ?? "").includes("Vienna, Vienna"));

    expect(element.querySelector("a")?.getAttribute("href")).toBe("https://db-ip.com");
  });

  it("renders nothing when the address cannot be placed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ found: false })),
    );
    const element = document.createElement("openclaw-ip-location");
    element.ip = "203.0.113.21";
    document.body.append(element);

    await settleUntil(
      element,
      () => (fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length > 0,
    );
    await element.updateComplete;
    expect(element.textContent?.trim()).toBe("");
  });

  it("does not request anything without an address", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const element = document.createElement("openclaw-ip-location");
    document.body.append(element);

    await element.updateComplete;
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
