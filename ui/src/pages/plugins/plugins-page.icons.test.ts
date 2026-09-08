/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import type { PluginListResult } from "../../lib/plugins/index.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  createClient,
  createContext,
  createGateway,
  createPlugin,
  createPluginsRouteData,
  createPluginsRouteLocation,
  createResult,
  mountPage,
  resetPluginsPageTestState,
} from "./plugins-page.test-support.ts";

describe("PluginsPage icon routing", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  afterEach(resetPluginsPageTestState);

  it("fetches proxied icons with auth fallback and revokes their blob URLs", async () => {
    const createObjectURL = vi.fn(() => "blob:firecrawl-icon");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal(
      "URL",
      class extends URL {
        static override createObjectURL = createObjectURL;
        static override revokeObjectURL = revokeObjectURL;
      },
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(
        new Response(
          new Blob(
            [
              new Uint8Array([
                0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0x49, 0x48, 0x44, 0x52,
                0, 0, 0, 2, 0, 0, 0, 1,
              ]),
            ],
            { type: "image/png" },
          ),
          {
            status: 200,
            headers: { "content-type": "image/png" },
          },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const { client } = createClient(async () => createResult());
    const harness = createGateway(client);
    harness.gateway.connection.gatewayUrl = window.location.origin.replace(/^http/u, "ws");
    harness.gateway.connection.token = "first";
    harness.gateway.connection.password = "second";
    const result = createResult(
      createPlugin({ id: "remote-icon", name: "FireCrawl", hasIcon: true }),
    );

    const { page } = await mountPage(
      createContext(harness.gateway),
      createPluginsRouteData(harness.gateway, result),
    );

    await waitForFast(() => {
      expect(
        page.querySelector('[data-plugin-id="remote-icon"] img.plugins-icon')?.getAttribute("src"),
      ).toBe("blob:firecrawl-icon");
    });
    expect(
      fetchMock.mock.calls.map(([, init]) => new Headers(init?.headers).get("Authorization")),
    ).toEqual(["Bearer first", "Bearer second"]);
    page.applyMutationResult({
      ok: true,
      plugin: createPlugin({ id: "other-plugin", name: "Other Plugin" }),
      restartRequired: false,
    });
    expect(revokeObjectURL).not.toHaveBeenCalled();

    page.remove();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:firecrawl-icon");
  });

  it("uses bundled art for scoped first-party catalog ids", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    const { client } = createClient(async () => createResult());
    const harness = createGateway(client);
    harness.gateway.connection.gatewayUrl = window.location.origin.replace(/^http/u, "ws");
    const catalogPlugin = (
      id: string,
      name: string,
      origin: "official" | "registry" = "official",
    ) =>
      createPlugin({
        id,
        name,
        origin,
        hasIcon: true,
        installed: false,
        enabled: false,
        state: "not-installed",
      });
    const result = {
      plugins: [
        catalogPlugin("@openclaw/brave-plugin", "Brave Search"),
        catalogPlugin("@openclaw/deepseek-provider", "DeepSeek"),
        catalogPlugin("@openclaw/discord", "Discord"),
        catalogPlugin("@vendor/brave-plugin", "Vendor Brave", "registry"),
      ],
      diagnostics: [],
      mutationAllowed: true,
    } satisfies PluginListResult;

    const { page } = await mountPage(
      createContext(harness.gateway),
      createPluginsRouteData(
        harness.gateway,
        result,
        createPluginsRouteLocation("/settings/plugins/discover"),
      ),
    );

    await waitForFast(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/__openclaw__/plugin-icon/%40vendor%2Fbrave-plugin",
    ]);
    expect(
      page.querySelector('[data-plugin-id="@openclaw/brave-plugin"] img')?.getAttribute("src"),
    ).toBe("/plugin-art/brave.webp");
    expect(
      page.querySelector('[data-plugin-id="@openclaw/deepseek-provider"] img')?.getAttribute("src"),
    ).toBe("/plugin-art/deepseek.webp");
    expect(
      page.querySelector('[data-plugin-id="@openclaw/discord"] img')?.getAttribute("src"),
    ).toBe("/plugin-art/discord.webp");
  });

  it("keeps the monogram fallback when a proxied SVG exceeds the safe icon subset", async () => {
    const createObjectURL = vi.fn();
    vi.stubGlobal(
      "URL",
      class extends URL {
        static override createObjectURL = createObjectURL;
        static override revokeObjectURL = vi.fn();
      },
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          new Blob(
            [
              `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><filter id="work"><feTurbulence /></filter><path filter="url(#work)" d="M0 0h24v24H0z"/></svg>`,
            ],
            { type: "image/svg+xml" },
          ),
          { status: 200, headers: { "content-type": "image/svg+xml" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const { client } = createClient(async () => createResult());
    const harness = createGateway(client);
    harness.gateway.connection.gatewayUrl = window.location.origin.replace(/^http/u, "ws");
    const result = createResult(
      createPlugin({ id: "unsafe-icon", name: "Unsafe Icon", hasIcon: true }),
    );

    const { page } = await mountPage(
      createContext(harness.gateway),
      createPluginsRouteData(harness.gateway, result),
    );

    await waitForFast(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(
      page.querySelector('[data-plugin-id="unsafe-icon"] .plugins-tile--fallback')?.textContent,
    ).toContain("UI");
  });
});
