// Browser contract test: agent-facing tab references must resolve to the
// same raw CDP targetId across every operation that accepts a tab handle.
// snapshot/act/navigate/screenshot/pdf routes all enter through
// ensureTabAvailable, so covering listTabs + ensureTabAvailable + focusTab +
// closeTab fixes the cross-operation handle-resolution contract in one place.
// If a future change lets one operation bypass the shared resolver in
// server-context.selection.ts / server-context.tab-ops.ts, this table catches
// the drift before agents see silent mis-targeting.
import { afterEach, describe, expect, it, vi } from "vitest";
import { withBrowserFetchPreconnect } from "../../test-fetch.js";
import "../test-support/browser-security.mock.js";
import "./server-context.chrome-test-harness.js";
import { BrowserTargetAmbiguousError } from "./errors.js";
import {
  createTestBrowserRouteContext,
  makeState,
  originalFetch,
} from "./server-context.remote-tab-ops.harness.js";

afterEach(async () => {
  const { closePlaywrightBrowserConnection } = await import("./pw-session.js");
  await closePlaywrightBrowserConnection().catch(() => {});
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

type JsonListEntry = {
  id: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
  type: string;
};

// Fixture mirrors target-id.test.ts so the resolver-level priority and the
// operation-level parity share one canonical example.
//   tab A: raw "ABCDEF123456", label "docs", tabId "t1"
//   tab B: raw "ABC999",        label "app",  tabId "t2"
// "ABCDEF" is a unique prefix of A; "ABC" is an ambiguous prefix of both.
const FIXTURE_TABS: JsonListEntry[] = [
  {
    id: "ABCDEF123456",
    title: "Docs",
    url: "https://docs.example.com",
    webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/ABCDEF123456",
    type: "page",
  },
  {
    id: "ABC999",
    title: "App",
    url: "https://app.example.com",
    webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/ABC999",
    type: "page",
  },
];

function createParityFetchMock(): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: unknown) => {
    const value = String(url);
    if (value.includes("/json/list")) {
      return { ok: true, json: async () => FIXTURE_TABS } as unknown as Response;
    }
    if (value.includes("/json/activate/") || value.includes("/json/close/")) {
      return { ok: true } as unknown as Response;
    }
    throw new Error(`unexpected fetch: ${value}`);
  });
}

function setupProfile() {
  const fetchMock = createParityFetchMock();
  global.fetch = withBrowserFetchPreconnect(fetchMock);
  const state = makeState("openclaw");
  const ctx = createTestBrowserRouteContext({ getState: () => state });
  return { fetchMock, openclaw: ctx.forProfile("openclaw") };
}

// Labels are agent-assigned via labelTab, not returned by /json/list, so seed
// them once per profile before asserting label-based resolution.
async function setupProfileWithLabels() {
  const ctx = setupProfile();
  await ctx.openclaw.labelTab("ABCDEF123456", "docs");
  await ctx.openclaw.labelTab("ABC999", "app");
  return ctx;
}

function backendTargetIds(
  fetchMock: ReturnType<typeof vi.fn>,
  endpoint: "/json/activate/" | "/json/close/",
): string[] {
  return fetchMock.mock.calls
    .map(([url]) => String(url))
    .filter((url) => url.includes(endpoint))
    .map((url) => url.slice(url.lastIndexOf(endpoint) + endpoint.length));
}

describe("tab reference parity contract", () => {
  it("listTabs attaches tabId, label, and suggestedTargetId for every fixture tab", async () => {
    const { openclaw } = await setupProfileWithLabels();
    const tabs = await openclaw.listTabs();
    expect(tabs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          targetId: "ABCDEF123456",
          tabId: "t1",
          label: "docs",
          suggestedTargetId: "docs",
        }),
        expect.objectContaining({
          targetId: "ABC999",
          tabId: "t2",
          label: "app",
          suggestedTargetId: "app",
        }),
      ]),
    );
  });

  // Cross-operation parity: every agent-facing handle resolves to the same raw
  // targetId across labelTab, ensureTabAvailable (snapshot/act/navigate route
  // entry), focusTab, and closeTab. Each operation gets an isolated profile so
  // sticky lastTargetId state cannot mask a divergence.
  const resolveCases: Array<{ name: string; input: string; expected: string }> = [
    { name: "tabId t1", input: "t1", expected: "ABCDEF123456" },
    { name: "tabId t2", input: "t2", expected: "ABC999" },
    { name: "label docs", input: "docs", expected: "ABCDEF123456" },
    { name: "label app", input: "app", expected: "ABC999" },
    { name: "raw targetId A", input: "ABCDEF123456", expected: "ABCDEF123456" },
    { name: "raw targetId B", input: "ABC999", expected: "ABC999" },
    { name: "unique raw prefix ABCDEF", input: "ABCDEF", expected: "ABCDEF123456" },
  ];

  for (const { name, input, expected } of resolveCases) {
    it(`resolves "${name}" to ${expected} across label/ensure/focus/close`, async () => {
      const labelCtx = await setupProfileWithLabels();
      const labeled = await labelCtx.openclaw.labelTab(input, "parity");
      expect(labeled.targetId).toBe(expected);

      const ensureCtx = await setupProfileWithLabels();
      const ensured = await ensureCtx.openclaw.ensureTabAvailable(input);
      expect(ensured.targetId).toBe(expected);

      const focusCtx = await setupProfileWithLabels();
      await focusCtx.openclaw.focusTab(input);
      expect(backendTargetIds(focusCtx.fetchMock, "/json/activate/")).toContain(expected);

      const closeCtx = await setupProfileWithLabels();
      await closeCtx.openclaw.closeTab(input);
      expect(backendTargetIds(closeCtx.fetchMock, "/json/close/")).toContain(expected);
    });
  }

  it("rejects an ambiguous raw prefix consistently across label/ensure/focus/close", async () => {
    const labelCtx = await setupProfileWithLabels();
    await expect(labelCtx.openclaw.labelTab("ABC", "parity")).rejects.toBeInstanceOf(
      BrowserTargetAmbiguousError,
    );
    const ensureCtx = await setupProfileWithLabels();
    await expect(ensureCtx.openclaw.ensureTabAvailable("ABC")).rejects.toBeInstanceOf(
      BrowserTargetAmbiguousError,
    );
    const focusCtx = await setupProfileWithLabels();
    await expect(focusCtx.openclaw.focusTab("ABC")).rejects.toBeInstanceOf(
      BrowserTargetAmbiguousError,
    );
    const closeCtx = await setupProfileWithLabels();
    await expect(closeCtx.openclaw.closeTab("ABC")).rejects.toBeInstanceOf(
      BrowserTargetAmbiguousError,
    );
  });
});
