/* @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginDiscoveryEntry } from "../../lib/plugins/index.ts";

const fetchIcon = vi.hoisted(() => vi.fn());

vi.mock("./icon-loader.ts", () => ({
  fetchCatalogIconBlobUrl: (...args: unknown[]) => fetchIcon(...args),
}));

const { CatalogIconController } = await import("./catalog-icon-controller.ts");

const entry = {
  id: "ch_dGVzdA",
  catalog: {
    name: "Test",
    official: false,
    categories: ["tools"],
    imageUrl: "https://cdn.example.com/test.png",
  },
  local: {
    present: false,
    installed: false,
    enabled: false,
    state: "not-installed",
    action: "install",
  },
} satisfies PluginDiscoveryEntry;

describe("CatalogIconController", () => {
  beforeEach(() => fetchIcon.mockReset());

  it("publishes proxied catalog icons and revokes them when the entry leaves", async () => {
    fetchIcon.mockResolvedValue("blob:test-icon");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const published: Array<Record<string, string>> = [];
    const controller = new CatalogIconController({
      getFetchContext: () => ({
        gatewayUrl: "ws://localhost",
        resourceBasePath: "",
        auth: {},
      }),
      isConnected: () => true,
      onUrlsChange: (urls) => published.push(urls),
    });

    controller.sync([entry]);
    await vi.waitFor(() =>
      expect(published.at(-1)).toEqual({
        "https://cdn.example.com/test.png": "blob:test-icon",
      }),
    );

    controller.sync([]);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:test-icon");
    expect(published.at(-1)).toEqual({});
  });

  it("does not retain an aborted request as a permanent miss", async () => {
    let rejectFirst: ((error: Error) => void) | undefined;
    fetchIcon
      .mockImplementationOnce(
        () =>
          new Promise<string>((_resolve, reject) => {
            rejectFirst = reject;
          }),
      )
      .mockResolvedValueOnce("blob:retried-icon");
    const published: Array<Record<string, string>> = [];
    const controller = new CatalogIconController({
      getFetchContext: () => ({
        gatewayUrl: "ws://localhost",
        resourceBasePath: "",
        auth: {},
      }),
      isConnected: () => true,
      onUrlsChange: (urls) => published.push(urls),
    });

    controller.sync([entry]);
    await vi.waitFor(() => expect(fetchIcon).toHaveBeenCalledTimes(1));
    controller.reset();
    rejectFirst?.(new Error("aborted"));
    await vi.waitFor(() => expect(fetchIcon).toHaveBeenCalledTimes(1));

    controller.sync([entry]);
    await vi.waitFor(() =>
      expect(published.at(-1)).toEqual({
        "https://cdn.example.com/test.png": "blob:retried-icon",
      }),
    );
  });
});
