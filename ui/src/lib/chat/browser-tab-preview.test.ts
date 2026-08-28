import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { latestBrowserTabCards, loadBrowserTabThumbnail } from "./browser-tab-preview.ts";
import { extractToolCardsCached } from "./tool-cards.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function browserResult(callId: string, targetId = "tab-1") {
  return {
    role: "toolResult",
    toolCallId: callId,
    toolName: "browser",
    content: "ok",
    details: { browserTab: { targetId } },
  };
}

function screenshotClient() {
  const request = vi.fn().mockResolvedValue({ path: "/tmp/shot.png", targetId: "tab-1" });
  const client = { request } as unknown as GatewayBrowserClient;
  const fetchMock = vi.fn<typeof fetch>().mockImplementation(
    async () =>
      ({
        ok: true,
        blob: async () => new Blob(["shot"], { type: "image/png" }),
      }) as Response,
  );
  vi.stubGlobal("fetch", fetchMock);
  return {
    client,
    request,
    fetchMock,
    targetId: "tab-1",
    resourceBasePath: "/gateway",
    authToken: null,
  };
}

describe("browser tab previews", () => {
  it("keeps anonymous result revisions stable across rendering prefixes but distinct across results", () => {
    const message = {
      role: "toolResult",
      toolName: "browser",
      details: { browserTab: { targetId: "tab-1" } },
    };
    const initial = latestBrowserTabCards([message], []).get("tab-1");
    expect(initial).toBeTruthy();
    expect(extractToolCardsCached(message, "visible-row")[0]?.previewRevision).toBe(initial);
    expect(latestBrowserTabCards([message, { ...message }], []).get("tab-1")).not.toBe(initial);
  });

  it("does not repeat captures when image retention evicts an old tab", async () => {
    const params = screenshotClient();
    for (let index = 0; index < 33; index++) {
      await loadBrowserTabThumbnail({ ...params, targetId: `tab-${index}`, revision: "one" });
    }
    expect(
      await loadBrowserTabThumbnail({ ...params, targetId: "tab-0", revision: "one" }),
    ).toBeUndefined();
    expect(params.request).toHaveBeenCalledTimes(33);
  });

  it("selects only the latest successful completed result, before filtering rows", () => {
    const older = browserResult("old");
    const latest = browserResult("new");
    const other = browserResult("other", "tab-2");
    const failed = { ...browserResult("failed"), isError: true };
    const running = {
      role: "assistant",
      __openclawToolStreamLive: true,
      content: [
        { type: "toolcall", id: "running", name: "browser", arguments: {} },
        { type: "toolresult", id: "running", name: "browser", details: older.details },
      ],
    };
    expect([...latestBrowserTabCards([null, older, latest, other], [failed, running])]).toEqual([
      ["tab-1", "new"],
      ["tab-2", "other"],
    ]);
    expect([...latestBrowserTabCards([older], [latest])]).toEqual([["tab-1", "new"]]);
    expect([...latestBrowserTabCards([older, latest], [])]).toEqual([["tab-1", "new"]]);
  });

  it("shares captures, serializes new revisions, and reads bytes only over HTTP", async () => {
    const params = screenshotClient();
    const deferred = createDeferred<{ path: string }>();
    params.request.mockReturnValueOnce(deferred.promise);
    const first = loadBrowserTabThumbnail({ ...params, revision: "one" });
    expect(loadBrowserTabThumbnail({ ...params, revision: "one" })).toBe(first);
    await Promise.resolve();
    const second = loadBrowserTabThumbnail({ ...params, revision: "two" });
    expect(params.request).toHaveBeenCalledTimes(1);
    deferred.resolve({ path: "/tmp/first.png" });
    expect(await first).toBe("data:image/png;base64,c2hvdA==");
    expect(await second).toBe("data:image/png;base64,c2hvdA==");
    await loadBrowserTabThumbnail({ ...params, revision: "one" });
    await loadBrowserTabThumbnail({ ...params, revision: "two" });
    expect(params.request.mock.calls).toEqual([
      [
        "browser.request",
        { method: "POST", path: "/screenshot", body: { targetId: "tab-1", type: "png" } },
      ],
      [
        "browser.request",
        { method: "POST", path: "/screenshot", body: { targetId: "tab-1", type: "png" } },
      ],
    ]);
    expect(params.fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/gateway/__openclaw__/assistant-media?source=%2Ftmp%2Ffirst.png",
      "/gateway/__openclaw__/assistant-media?source=%2Ftmp%2Fshot.png",
    ]);
  });

  it.each(["capture", "fetch"])("caches a %s failure until a new revision", async (failure) => {
    const params = screenshotClient();
    if (failure === "capture") {
      params.request.mockRejectedValueOnce(new Error("closed"));
    } else {
      params.fetchMock.mockRejectedValueOnce(new Error("offline"));
    }
    const first = loadBrowserTabThumbnail({ ...params, revision: "one" });
    expect(await first).toBeUndefined();
    expect(await loadBrowserTabThumbnail({ ...params, revision: "one" })).toBeUndefined();
    expect(params.request).toHaveBeenCalledTimes(1);
    expect(await loadBrowserTabThumbnail({ ...params, revision: "two" })).toBe(
      "data:image/png;base64,c2hvdA==",
    );
    expect(params.request).toHaveBeenCalledTimes(2);
  });

  it("never reuses a shot from another Gateway client", async () => {
    const params = screenshotClient();
    await loadBrowserTabThumbnail({ ...params, revision: "one" });
    const next = screenshotClient();
    await loadBrowserTabThumbnail({ ...next, revision: "one" });
    expect(next.request).toHaveBeenCalledTimes(1);
  });
});
