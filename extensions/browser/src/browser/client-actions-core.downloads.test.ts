import { beforeEach, describe, expect, it, vi } from "vitest";

const clientFetchMocks = vi.hoisted(() => ({
  fetchBrowserJson: vi.fn(async (..._args: unknown[]) => ({
    ok: true,
    targetId: "tab-1",
    download: {
      path: "/tmp/openclaw/downloads/report.pdf",
      suggestedFilename: "report.pdf",
      url: "https://example.com/report.pdf",
    },
  })),
}));

vi.mock("./client-fetch.js", () => clientFetchMocks);

import { browserDownload, browserWaitForDownload } from "./client-actions-core.js";

function lastFetchCall(): { url: string; options: { body?: string; timeoutMs?: number } } {
  const call = clientFetchMocks.fetchBrowserJson.mock.calls.at(-1);
  if (!call) {
    throw new Error("fetchBrowserJson was not called");
  }
  return {
    url: String(call[0]),
    options: call[1] as { body?: string; timeoutMs?: number },
  };
}

describe("browser download client actions", () => {
  beforeEach(() => vi.clearAllMocks());

  it("preserves the 120 second default download wait", async () => {
    await browserDownload(undefined, { ref: "e12", path: "report.pdf" });

    const call = lastFetchCall();
    expect(call.url).toBe("/download");
    expect(call.options.timeoutMs).toBe(125_000);
    expect(JSON.parse(call.options.body ?? "{}")).toEqual({
      ref: "e12",
      path: "report.pdf",
    });
  });

  it("adds transport slack to an explicit wait and preserves profile routing", async () => {
    await browserWaitForDownload(undefined, {
      path: "export.csv",
      targetId: "tab-1",
      timeoutMs: 30_000,
      profile: "openclaw",
    });

    const call = lastFetchCall();
    expect(call.url).toBe("/wait/download?profile=openclaw");
    expect(call.options.timeoutMs).toBe(35_000);
    expect(JSON.parse(call.options.body ?? "{}")).toEqual({
      targetId: "tab-1",
      path: "export.csv",
      timeoutMs: 30_000,
    });
  });
});
