import { afterEach, describe, expect, it, vi } from "vitest";

import { browserOpenTab, browserSnapshot, browserStatus, browserTabs } from "./client.js";
import {
  browserAct,
  browserArmDialog,
  browserArmFileChooser,
  browserConsoleMessages,
  browserNavigate,
  browserPdfSave,
  browserScreenshotAction,
} from "./client-actions.js";

describe("browser client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("wraps connection failures with a gateway hint", async () => {
    const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1"), {
      code: "ECONNREFUSED",
    });
    const fetchFailed = Object.assign(new TypeError("fetch failed"), {
      cause: refused,
    });

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(fetchFailed));

    await expect(browserStatus("http://127.0.0.1:18791")).rejects.toThrow(/Start .*gateway/i);
  });

  it("adds useful timeout messaging for abort-like failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("aborted")));
    await expect(browserStatus("http://127.0.0.1:18791")).rejects.toThrow(/timed out/i);
  });

  it("adds Authorization when CLAWDBOT_BROWSER_CONTROL_TOKEN is set", async () => {
    const prev = process.env.CLAWDBOT_BROWSER_CONTROL_TOKEN;
    process.env.CLAWDBOT_BROWSER_CONTROL_TOKEN = "t1";

    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return {
          ok: true,
          json: async () => ({
            enabled: true,
            controlUrl: "http://127.0.0.1:18791",
            running: false,
            pid: null,
            cdpPort: 18792,
            chosenBrowser: null,
            userDataDir: null,
            color: "#FF0000",
            headless: true,
            attachOnly: false,
          }),
        } as unknown as Response;
      }),
    );

    await browserStatus("http://127.0.0.1:18791");
    const init = calls[0]?.init;
    const auth = new Headers(init?.headers ?? {}).get("Authorization");
    expect(auth).toBe("Bearer t1");

    process.env.CLAWDBOT_BROWSER_CONTROL_TOKEN = prev;
  });

  it("surfaces non-2xx responses with body text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        text: async () => "conflict",
      } as unknown as Response),
    );

    await expect(
      browserSnapshot("http://127.0.0.1:18791", { format: "aria", limit: 1 }),
    ).rejects.toThrow(/409: conflict/i);
  });

  it("adds labels + efficient mode query params to snapshots", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return {
          ok: true,
          json: async () => ({
            ok: true,
            format: "ai",
            targetId: "t1",
            url: "https://x",
            snapshot: "ok",
          }),
        } as unknown as Response;
      }),
    );

    await expect(
      browserSnapshot("http://127.0.0.1:18791", {
        format: "ai",
        labels: true,
        mode: "efficient",
      }),
    ).resolves.toMatchObject({ ok: true, format: "ai" });

    const snapshotCall = calls.find((url) => url.includes("/snapshot?"));
    expect(snapshotCall).toBeTruthy();
    const parsed = new URL(snapshotCall as string);
    expect(parsed.searchParams.get("labels")).toBe("1");
    expect(parsed.searchParams.get("mode")).toBe("efficient");
  });

  it("adds refs=aria to snapshots when requested", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return {
          ok: true,
          json: async () => ({
            ok: true,
            format: "ai",
            targetId: "t1",
            url: "https://x",
            snapshot: "ok",
          }),
        } as unknown as Response;
      }),
    );

    await browserSnapshot("http://127.0.0.1:18791", {
      format: "ai",
      refs: "aria",
    });

    const snapshotCall = calls.find((url) => url.includes("/snapshot?"));
    expect(snapshotCall).toBeTruthy();
    const parsed = new URL(snapshotCall as string);
    expect(parsed.searchParams.get("refs")).toBe("aria");
  });

  it("uses the expected endpoints + methods for common calls", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        if (url.endsWith("/tabs") && (!init || init.method === undefined)) {
          return {
            ok: true,
            json: async () => ({
              running: true,
              tabs: [{ targetId: "t1", title: "T", url: "https://x" }],
            }),
          } as unknown as Response;
        }
        if (url.endsWith("/tabs/open")) {
          return {
            ok: true,
            json: async () => ({
              targetId: "t2",
              title: "N",
              url: "https://y",
            }),
          } as unknown as Response;
        }
        if (url.endsWith("/navigate")) {
          return {
            ok: true,
            json: async () => ({
              ok: true,
              targetId: "t1",
              url: "https://y",
            }),
          } as unknown as Response;
        }
        if (url.endsWith("/act")) {
          return {
            ok: true,
            json: async () => ({
              ok: true,
              targetId: "t1",
              url: "https://x",
              result: 1,
            }),
          } as unknown as Response;
        }
        if (url.endsWith("/hooks/file-chooser")) {
          return {
            ok: true,
            json: async () => ({ ok: true }),
          } as unknown as Response;
        }
        if (url.endsWith("/hooks/dialog")) {
          return {
            ok: true,
            json: async () => ({ ok: true }),
          } as unknown as Response;
        }
        if (url.includes("/console?")) {
          return {
            ok: true,
            json: async () => ({
              ok: true,
              targetId: "t1",
              messages: [],
            }),
          } as unknown as Response;
        }
        if (url.endsWith("/pdf")) {
          return {
            ok: true,
            json: async () => ({
              ok: true,
              path: "/tmp/a.pdf",
              targetId: "t1",
              url: "https://x",
            }),
          } as unknown as Response;
        }
        if (url.endsWith("/screenshot")) {
          return {
            ok: true,
            json: async () => ({
              ok: true,
              path: "/tmp/a.png",
              targetId: "t1",
              url: "https://x",
            }),
          } as unknown as Response;
        }
        if (url.includes("/snapshot?")) {
          return {
            ok: true,
            json: async () => ({
              ok: true,
              format: "aria",
              targetId: "t1",
              url: "https://x",
              nodes: [],
            }),
          } as unknown as Response;
        }
        return {
          ok: true,
          json: async () => ({
            enabled: true,
            controlUrl: "http://127.0.0.1:18791",
            running: true,
            pid: 1,
            cdpPort: 18792,
            cdpUrl: "http://127.0.0.1:18792",
            chosenBrowser: "chrome",
            userDataDir: "/tmp",
            color: "#FF4500",
            headless: false,
            noSandbox: false,
            executablePath: null,
            attachOnly: false,
          }),
        } as unknown as Response;
      }),
    );

    await expect(browserStatus("http://127.0.0.1:18791")).resolves.toMatchObject({
      running: true,
      cdpPort: 18792,
    });

    await expect(browserTabs("http://127.0.0.1:18791")).resolves.toHaveLength(1);
    await expect(
      browserOpenTab("http://127.0.0.1:18791", "https://example.com"),
    ).resolves.toMatchObject({ targetId: "t2" });

    await expect(
      browserSnapshot("http://127.0.0.1:18791", { format: "aria", limit: 1 }),
    ).resolves.toMatchObject({ ok: true, format: "aria" });

    await expect(
      browserNavigate("http://127.0.0.1:18791", { url: "https://example.com" }),
    ).resolves.toMatchObject({ ok: true, targetId: "t1" });
    await expect(
      browserAct("http://127.0.0.1:18791", { kind: "click", ref: "1" }),
    ).resolves.toMatchObject({ ok: true, targetId: "t1" });
    await expect(
      browserArmFileChooser("http://127.0.0.1:18791", {
        paths: ["/tmp/a.txt"],
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      browserArmDialog("http://127.0.0.1:18791", { accept: true }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      browserConsoleMessages("http://127.0.0.1:18791", { level: "error" }),
    ).resolves.toMatchObject({ ok: true, targetId: "t1" });
    await expect(browserPdfSave("http://127.0.0.1:18791")).resolves.toMatchObject({
      ok: true,
      path: "/tmp/a.pdf",
    });
    await expect(
      browserScreenshotAction("http://127.0.0.1:18791", { fullPage: true }),
    ).resolves.toMatchObject({ ok: true, path: "/tmp/a.png" });

    expect(calls.some((c) => c.url.endsWith("/tabs"))).toBe(true);
    const open = calls.find((c) => c.url.endsWith("/tabs/open"));
    expect(open?.init?.method).toBe("POST");

    const screenshot = calls.find((c) => c.url.endsWith("/screenshot"));
    expect(screenshot?.init?.method).toBe("POST");
  });
});
