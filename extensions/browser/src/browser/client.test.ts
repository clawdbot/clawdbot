import { afterEach, describe, expect, it, vi } from "vitest";
import {
  browserAct,
  browserArmDialog,
  browserArmFileChooser,
  browserConsoleMessages,
  browserNavigate,
  browserPdfSave,
  browserScreenshotAction,
} from "./client-actions.js";
import {
  browserDoctor,
  browserOpenTab,
  browserSnapshot,
  browserStatus,
  browserTabs,
} from "./client.js";

describe("browser client", () => {
  function requireSnapshotCall(calls: string[]): string {
    const call = calls.find((url) => url.includes("/snapshot?"));
    if (!call) {
      throw new Error("expected browser snapshot request");
    }
    return call;
  }

  function stubSnapshotFetch(calls: string[]) {
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
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("wraps connection failures with a sandbox hint", async () => {
    const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1"), {
      code: "ECONNREFUSED",
    });
    const fetchFailed = Object.assign(new TypeError("fetch failed"), {
      cause: refused,
    });

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(fetchFailed));

    await expect(browserStatus("http://127.0.0.1:18791")).rejects.toThrow(/sandboxed session/i);
  });

  it("adds useful cancellation messaging for abort-like failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("aborted")));
    await expect(browserStatus("http://127.0.0.1:18791")).rejects.toThrow(/cancelled/i);
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
    ).rejects.toThrow(/conflict/i);
  });

  it("adds labels + efficient mode query params to snapshots", async () => {
    const calls: string[] = [];
    stubSnapshotFetch(calls);

    const snapshot = await browserSnapshot("http://127.0.0.1:18791", {
      format: "ai",
      labels: true,
      mode: "efficient",
    });

    expect(snapshot.ok).toBe(true);
    expect(snapshot.format).toBe("ai");

    const parsed = new URL(requireSnapshotCall(calls));
    expect(parsed.searchParams.get("labels")).toBe("1");
    expect(parsed.searchParams.get("mode")).toBe("efficient");
  });

  it("adds refs=aria to snapshots when requested", async () => {
    const calls: string[] = [];
    stubSnapshotFetch(calls);

    await browserSnapshot("http://127.0.0.1:18791", {
      format: "ai",
      refs: "aria",
    });

    const parsed = new URL(requireSnapshotCall(calls));
    expect(parsed.searchParams.get("refs")).toBe("aria");
  });

  it("omits format when the caller wants server-side snapshot capability defaults", async () => {
    const calls: string[] = [];
    stubSnapshotFetch(calls);

    await browserSnapshot("http://127.0.0.1:18791", {
      profile: "chrome",
    });

    const parsed = new URL(requireSnapshotCall(calls));
    expect(parsed.searchParams.get("format")).toBeNull();
    expect(parsed.searchParams.get("profile")).toBe("chrome");
  });

  it("uses the expected endpoints + methods for common calls", async () => {
    const calls: Array<{ url: string; init?: RequestInit & { timeoutMs?: number } }> = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit & { timeoutMs?: number }) => {
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
              results: [{ ok: true }],
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
        if (url.includes("/doctor")) {
          return {
            ok: true,
            json: async () => ({
              ok: true,
              profile: "openclaw",
              transport: "cdp",
              checks: [],
              status: {
                enabled: true,
                running: true,
                cdpPort: 18792,
              },
            }),
          } as unknown as Response;
        }
        return {
          ok: true,
          json: async () => ({
            enabled: true,
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

    const statusResult = await browserStatus("http://127.0.0.1:18791");
    expect(statusResult.running).toBe(true);
    expect(statusResult.cdpPort).toBe(18792);

    const doctorResult = await browserDoctor("http://127.0.0.1:18791");
    expect(doctorResult.ok).toBe(true);
    expect(doctorResult.profile).toBe("openclaw");

    const deepDoctorResult = await browserDoctor("http://127.0.0.1:18791", {
      profile: "openclaw",
      deep: true,
    });
    expect(deepDoctorResult.ok).toBe(true);
    expect(deepDoctorResult.profile).toBe("openclaw");

    await expect(browserTabs("http://127.0.0.1:18791")).resolves.toHaveLength(1);
    const openedTab = await browserOpenTab("http://127.0.0.1:18791", "https://example.com");
    expect(openedTab.targetId).toBe("t2");

    const snapshot = await browserSnapshot("http://127.0.0.1:18791", {
      format: "aria",
      limit: 1,
    });
    expect(snapshot.ok).toBe(true);
    expect(snapshot.format).toBe("aria");

    const navigation = await browserNavigate("http://127.0.0.1:18791", {
      url: "https://example.com",
    });
    expect(navigation.ok).toBe(true);
    expect(navigation.targetId).toBe("t1");

    const act = await browserAct("http://127.0.0.1:18791", { kind: "click", ref: "1" });
    expect(act.ok).toBe(true);
    expect(act.targetId).toBe("t1");
    expect(act.results).toEqual([{ ok: true }]);

    const fileChooser = await browserArmFileChooser("http://127.0.0.1:18791", {
      paths: ["/tmp/a.txt"],
    });
    expect(fileChooser.ok).toBe(true);

    const dialog = await browserArmDialog("http://127.0.0.1:18791", { accept: true });
    expect(dialog.ok).toBe(true);

    const consoleMessages = await browserConsoleMessages("http://127.0.0.1:18791", {
      level: "error",
    });
    expect(consoleMessages.ok).toBe(true);
    expect(consoleMessages.targetId).toBe("t1");

    const pdf = await browserPdfSave("http://127.0.0.1:18791");
    expect(pdf.ok).toBe(true);
    expect(pdf.path).toBe("/tmp/a.pdf");

    const screenshotResult = await browserScreenshotAction("http://127.0.0.1:18791", {
      fullPage: true,
      timeoutMs: 12_345,
    });
    expect(screenshotResult.ok).toBe(true);
    expect(screenshotResult.path).toBe("/tmp/a.png");

    const defaultScreenshotResult = await browserScreenshotAction("http://127.0.0.1:18791", {
      targetId: "t-default",
    });
    expect(defaultScreenshotResult.ok).toBe(true);
    expect(defaultScreenshotResult.path).toBe("/tmp/a.png");

    const urls = calls.map((call) => call.url);
    expect(urls.some((url) => url.endsWith("/tabs"))).toBe(true);
    expect(urls.some((url) => url.endsWith("/doctor"))).toBe(true);
    expect(urls.some((url) => url.endsWith("/doctor?profile=openclaw&deep=true"))).toBe(true);
    const status = calls.find((c) => c.url.endsWith("/"));
    expect(status?.init?.timeoutMs).toBe(7_500);
    const doctor = calls.find((c) => c.url.endsWith("/doctor"));
    expect(doctor?.init?.timeoutMs).toBe(7_500);
    const deepDoctor = calls.find((c) => c.url.endsWith("/doctor?profile=openclaw&deep=true"));
    expect(deepDoctor?.init?.timeoutMs).toBe(10_000);
    const open = calls.find((c) => c.url.endsWith("/tabs/open"));
    expect(open?.init?.method).toBe("POST");

    const screenshotCalls = calls.filter((c) => c.url.endsWith("/screenshot"));
    const screenshot = screenshotCalls[0];
    expect(screenshot?.init?.method).toBe("POST");
    expect(screenshot?.init?.timeoutMs).toBe(12_345);
    const screenshotBody = JSON.parse(
      typeof screenshot?.init?.body === "string" ? screenshot.init.body : "{}",
    ) as { fullPage?: unknown; timeoutMs?: unknown };
    expect(screenshotBody.fullPage).toBe(true);
    expect(screenshotBody.timeoutMs).toBe(12_345);
    const defaultScreenshot = screenshotCalls[1];
    expect(defaultScreenshot?.init?.timeoutMs).toBe(20_000);
    const defaultScreenshotBody = JSON.parse(
      typeof defaultScreenshot?.init?.body === "string" ? defaultScreenshot.init.body : "{}",
    ) as { targetId?: unknown; timeoutMs?: unknown };
    expect(defaultScreenshotBody.targetId).toBe("t-default");
    expect(defaultScreenshotBody.timeoutMs).toBe(20_000);
  });

  it("gives browser act requests enough client timeout for long waits", async () => {
    const calls: Array<{ url: string; init?: RequestInit & { timeoutMs?: number } }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit & { timeoutMs?: number }) => {
        calls.push({ url, init });
        return {
          ok: true,
          json: async () => ({ ok: true, targetId: "t1" }),
        } as unknown as Response;
      }),
    );

    await browserAct("http://127.0.0.1:18791", { kind: "click", ref: "1" });
    await browserAct("http://127.0.0.1:18791", {
      kind: "wait",
      timeMs: 70_000,
    });
    await browserAct("http://127.0.0.1:18791", {
      kind: "wait",
      timeoutMs: 45_000,
    });

    expect(calls.map((call) => call.init?.timeoutMs)).toEqual([60_000, 75_000, 50_000]);
  });
});
