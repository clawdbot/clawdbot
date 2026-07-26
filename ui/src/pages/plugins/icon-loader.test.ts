/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchCatalogIconBlobUrl, fetchPluginIconBlobUrl } from "./icon-loader.ts";

const auth = {
  settings: { token: "test-token" },
};

function imageResponse(): Response {
  return new Response(new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" }), {
    status: 200,
    headers: { "content-type": "image/png" },
  });
}

describe("catalog icon loader", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("loads plugin and wire-provided catalog icons through same-origin proxy routes", async () => {
    const NativeUrl = URL;
    const createObjectURL = vi
      .fn()
      .mockReturnValueOnce("blob:plugin-icon")
      .mockReturnValueOnce("blob:catalog-icon");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal(
      "URL",
      class extends NativeUrl {
        static override createObjectURL = createObjectURL;
        static override revokeObjectURL = revokeObjectURL;
      },
    );
    const fetchMock = vi.fn().mockImplementation(async () => imageResponse());
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const common = {
      auth,
      basePath: "/openclaw",
      gatewayUrl: window.location.origin.replace(/^http/u, "ws"),
      signal: new AbortController().signal,
    };

    await expect(fetchPluginIconBlobUrl({ ...common, pluginId: "firecrawl" })).resolves.toBe(
      "blob:plugin-icon",
    );
    const iconUrl = "https://cdn.example.test/provider.svg";
    await expect(fetchCatalogIconBlobUrl({ ...common, iconUrl })).resolves.toBe(
      "blob:catalog-icon",
    );

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/openclaw/__openclaw__/plugin-icon/firecrawl",
      `/openclaw/__openclaw__/catalog-icon/${encodeURIComponent(iconUrl)}`,
    ]);
    expect(
      fetchMock.mock.calls.map(([, init]) => new Headers(init?.headers).get("Authorization")),
    ).toEqual(["Bearer test-token", "Bearer test-token"]);
    expect(fetchMock.mock.calls.some(([url]) => url === iconUrl)).toBe(false);
  });

  it("refuses proxy loading when the configured gateway is cross-origin", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    await expect(
      fetchCatalogIconBlobUrl({
        auth,
        basePath: "",
        gatewayUrl: "wss://remote.example.test",
        iconUrl: "https://cdn.example.test/provider.svg",
        signal: new AbortController().signal,
      }),
    ).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
