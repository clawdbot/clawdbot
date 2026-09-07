import { beforeEach, describe, expect, it, vi } from "vitest";

const clientFetchMocks = vi.hoisted(() => ({
  fetchBrowserJson: vi.fn(async (..._args: unknown[]) => ({ ok: true })),
}));

vi.mock("./client-fetch.js", () => clientFetchMocks);

import { browserArmDialog, browserArmFileChooser } from "./client-actions-core.js";

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

describe("browser hook client actions", () => {
  beforeEach(() => vi.clearAllMocks());

  it("adds transport slack to an atomic file chooser upload", async () => {
    await browserArmFileChooser(undefined, {
      paths: ["/tmp/openclaw/uploads/report.pdf"],
      ref: "e12",
      targetId: "tab-1",
      timeoutMs: 30_000,
      profile: "openclaw",
    });

    const call = lastFetchCall();
    expect(call.url).toBe("/hooks/file-chooser?profile=openclaw");
    expect(call.options.timeoutMs).toBe(35_000);
    expect(JSON.parse(call.options.body ?? "{}")).toEqual({
      paths: ["/tmp/openclaw/uploads/report.pdf"],
      ref: "e12",
      targetId: "tab-1",
      timeoutMs: 30_000,
    });
  });

  it("preserves paths-only arming with the advertised 120 second default", async () => {
    await browserArmFileChooser(undefined, {
      paths: ["/tmp/openclaw/uploads/report.pdf"],
    });

    const call = lastFetchCall();
    expect(call.url).toBe("/hooks/file-chooser");
    expect(call.options.timeoutMs).toBe(125_000);
    expect(JSON.parse(call.options.body ?? "{}")).toEqual({
      paths: ["/tmp/openclaw/uploads/report.pdf"],
    });
  });

  it("keeps dialog hook requests alive past their operation timeout", async () => {
    await browserArmDialog(undefined, { accept: true, timeoutMs: 45_000 });

    const call = lastFetchCall();
    expect(call.url).toBe("/hooks/dialog");
    expect(call.options.timeoutMs).toBe(50_000);
    expect(JSON.parse(call.options.body ?? "{}")).toEqual({
      accept: true,
      timeoutMs: 45_000,
    });
  });
});
