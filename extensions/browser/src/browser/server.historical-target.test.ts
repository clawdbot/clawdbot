import { describe, expect, it, vi } from "vitest";
import {
  getBrowserControlServerBaseUrl,
  getCdpMocks,
  installBrowserControlServerHooks,
  makeResponse,
  setBrowserControlServerReachable,
  startBrowserControlServerFromConfig,
} from "./server.control-server.test-harness.js";
import { getBrowserTestFetch } from "./test-support/fetch.js";

const { launchOpenClawChrome, stopOpenClawChrome } = await import("./chrome.js");

describe("browser control server historical targets", () => {
  installBrowserControlServerHooks();

  async function request(path: string, body?: unknown) {
    return await getBrowserTestFetch()(
      `${getBrowserControlServerBaseUrl()}${path}`,
      body === undefined
        ? undefined
        : {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
    );
  }

  it("does not start a stopped browser for a historical screenshot", async () => {
    await startBrowserControlServerFromConfig();
    vi.mocked(launchOpenClawChrome).mockClear();

    const response = await request("/screenshot", { targetId: "closed-historical-tab" });

    expect(launchOpenClawChrome).not.toHaveBeenCalled();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("not running") });
    expect(await (await request("/tabs")).json()).toMatchObject({ running: false, tabs: [] });
  });

  it.each([false, true])(
    "does not create a tab or stop a running browser for a missing target (empty: %s)",
    async (empty) => {
      await startBrowserControlServerFromConfig();
      setBrowserControlServerReachable(true);
      vi.mocked(launchOpenClawChrome).mockClear();
      vi.mocked(stopOpenClawChrome).mockClear();
      const fetchCdp = globalThis.fetch;
      const tabRequests: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          const url = input instanceof Request ? input.url : input.toString();
          tabRequests.push(url);
          return empty && url.includes("/json/list")
            ? makeResponse([])
            : await fetchCdp(input, init);
        }),
      );

      const response = await request("/screenshot", { targetId: "closed-historical-tab" });

      expect(getCdpMocks().createTargetViaCdp).not.toHaveBeenCalled();
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: expect.stringContaining("not found") });
      expect(launchOpenClawChrome).not.toHaveBeenCalled();
      expect(stopOpenClawChrome).not.toHaveBeenCalled();
      expect(tabRequests.some((url) => url.includes("/json/new"))).toBe(false);
      expect(await (await request("/tabs")).json()).toMatchObject({
        running: true,
        tabs: empty
          ? []
          : expect.arrayContaining([expect.objectContaining({ targetId: "abcd1234" })]),
      });
    },
  );

  it.each(["abcd1234", "t1", "abcd"])("still resolves a live target %s", async (targetId) => {
    await startBrowserControlServerFromConfig();
    setBrowserControlServerReachable(true);

    const response = await request(`/snapshot?targetId=${targetId}&format=ai`);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ targetId: "abcd1234" });
  });

  it.each([
    { path: "/start", body: {} },
    { path: "/tabs/open", body: { url: "about:blank" } },
    { path: "/snapshot?format=ai", body: undefined },
  ])("preserves intentional startup through $path", async ({ path, body }) => {
    await startBrowserControlServerFromConfig();
    vi.mocked(launchOpenClawChrome).mockClear();
    getCdpMocks().createTargetViaCdp.mockResolvedValue({
      targetId: "abcd1234",
      finalUrl: "https://example.com",
    });

    const response = await request(path, body);

    expect(response.status).toBe(200);
    expect(launchOpenClawChrome).toHaveBeenCalledOnce();
  });
});
