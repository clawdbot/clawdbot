import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the runtime before importing buildUserAgent
const mockRuntime = {
  version: "2026.3.19",
};

vi.mock("./runtime.js", () => ({
  getMSTeamsRuntime: vi.fn(() => mockRuntime),
}));

import { fetchGraphJson } from "./graph.js";
import { getMSTeamsRuntime } from "./runtime.js";
import { buildUserAgent, ensureUserAgentHeader, resetUserAgentCache } from "./user-agent.js";

function readFirstFetchInit(mockFetch: { mock: { calls: unknown[][] } }): {
  headers: Record<string, string>;
} {
  const [call] = mockFetch.mock.calls;
  if (!call) {
    throw new Error("Expected Graph fetch call");
  }
  const [, init] = call;
  if (
    !init ||
    typeof init !== "object" ||
    !("headers" in init) ||
    typeof init.headers !== "object" ||
    init.headers === null
  ) {
    throw new Error("Expected Graph fetch init headers");
  }
  return init as { headers: Record<string, string> };
}

describe("buildUserAgent", () => {
  beforeEach(() => {
    resetUserAgentCache();
    vi.mocked(getMSTeamsRuntime).mockReturnValue(mockRuntime as never);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns teams.ts[apps]/<sdk> OpenClaw/<version> format", () => {
    const ua = buildUserAgent();
    expect(ua).toMatch(/^teams\.ts\[apps\]\/.+ OpenClaw\/2026\.3\.19$/);
  });

  it("reflects the runtime version", () => {
    vi.mocked(getMSTeamsRuntime).mockReturnValue({ version: "1.2.3" } as never);
    const ua = buildUserAgent();
    expect(ua).toMatch(/OpenClaw\/1\.2\.3$/);
  });

  it("returns OpenClaw/unknown when runtime is not initialized", () => {
    vi.mocked(getMSTeamsRuntime).mockImplementation(() => {
      throw new Error("MSTeams runtime not initialized");
    });
    const ua = buildUserAgent();
    expect(ua).toMatch(/OpenClaw\/unknown$/);
    // SDK version should still be present
    expect(ua).toMatch(/^teams\.ts\[apps\]\//);
  });

  it("sends the generated User-Agent in Graph requests by default", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ value: [] }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await fetchGraphJson({ token: "test-token", path: "/groups" });

    expect(mockFetch).toHaveBeenCalledOnce();
    const init = readFirstFetchInit(mockFetch);
    expect(init.headers["User-Agent"]).toMatch(/^teams\.ts\[apps\]\/.+ OpenClaw\/2026\.3\.19$/);
    expect(init.headers).toHaveProperty("Authorization", "Bearer test-token");
  });

  it("lets caller headers override the default Graph User-Agent", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ value: [] }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await fetchGraphJson({
      token: "test-token",
      path: "/groups",
      headers: { "User-Agent": "custom-agent/1.0" },
    });

    const init = readFirstFetchInit(mockFetch);
    expect(init.headers["User-Agent"]).toBe("custom-agent/1.0");
  });

  it("adds the generated User-Agent to Headers instances without overwriting callers", () => {
    const generated = ensureUserAgentHeader();
    expect(generated.get("User-Agent")).toMatch(/^teams\.ts\[apps\]\/.+ OpenClaw\/2026\.3\.19$/);

    const custom = ensureUserAgentHeader({ "User-Agent": "custom-agent/2.0" });
    expect(custom.get("User-Agent")).toBe("custom-agent/2.0");
  });
});
