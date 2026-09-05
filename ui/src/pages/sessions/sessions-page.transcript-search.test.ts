/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionsSearchResult } from "../../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionsListResult } from "../../api/types.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import type { SessionListOptions } from "../../lib/sessions/index.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import {
  createContext,
  createGateway,
  createManagedSessions,
  createRenderedPage,
  createSessions,
} from "./sessions-page.test-support.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("Sessions transcript search scope", () => {
  it("submits one trimmed bounded transcript search and adopts its status", async () => {
    const response = createDeferred<SessionsSearchResult>();
    const request = vi.fn(() => response.promise);
    const mutableGateway = createGateway({ request } as unknown as GatewayBrowserClient);
    mutableGateway.emit({
      hello: { features: { methods: ["sessions.search"] } } as ApplicationGatewaySnapshot["hello"],
    });
    const page = await createRenderedPage(
      createContext(mutableGateway.gateway, createSessions()),
      sessionsResult([{ key: "agent:main:launch", kind: "direct", updatedAt: 1 }], 1),
    );
    vi.mocked(page.context.sessions.list).mockResolvedValue(page.result);

    page.updateTranscriptSearchQuery("  launch code  ");
    const pending = page.runTranscriptSearch();
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    expect(request).toHaveBeenCalledWith("sessions.search", {
      agentId: "main",
      sessionKeys: ["agent:main:launch"],
      query: "launch code",
      limit: 25,
    });
    await page.updateComplete;
    expect(
      page.querySelector(".sessions-transcript-search__status")?.getAttribute("aria-busy"),
    ).toBe("true");

    const result: SessionsSearchResult = {
      results: [
        {
          sessionKey: "agent:main:launch",
          sessionId: "launch",
          messageId: "message-1",
          role: "user",
          timestamp: 42,
          snippet: "launch code",
          score: 1,
        },
      ],
      indexing: true,
      truncated: true,
    };
    response.resolve(result);
    await pending;
    await page.updateComplete;

    expect(page.transcriptSearchQuery).toBe("launch code");
    expect(page.querySelector(".sessions-transcript-search__snippet")?.textContent).toBe(
      "launch code",
    );
    expect(page.querySelector(".sessions-transcript-search__notice")?.textContent).toContain(
      t("sessionsView.transcriptSearchIndexing"),
    );
    expect(page.querySelector(".sessions-transcript-search__summary")?.textContent).toContain(
      t("sessionsView.transcriptSearchTruncated"),
    );
    expect(
      page.querySelector(".sessions-transcript-search__status")?.getAttribute("aria-busy"),
    ).toBe("false");
  });

  it("fans all-agent transcript search out by owning agent and merges ranked results", async () => {
    const request = vi.fn(async (_method: string, params: { agentId: string }) => ({
      results: [
        {
          sessionKey: `agent:${params.agentId}:one`,
          sessionId: `${params.agentId}-one`,
          messageId: `${params.agentId}-message`,
          role: "assistant" as const,
          timestamp: params.agentId === "writer" ? 2 : 1,
          snippet: params.agentId,
          score: params.agentId === "writer" ? 2 : 1,
        },
      ],
    }));
    const mutableGateway = createGateway({ request } as unknown as GatewayBrowserClient);
    mutableGateway.emit({
      hello: { features: { methods: ["sessions.search"] } } as ApplicationGatewaySnapshot["hello"],
    });
    const context = createContext(mutableGateway.gateway, createSessions());
    context.agentSelection.state.scopeId = null;
    const page = await createRenderedPage(
      context,
      sessionsResult(
        [
          { key: "agent:main:one", kind: "direct", updatedAt: 1 },
          { key: "agent:writer:one", kind: "direct", updatedAt: 1 },
        ],
        1,
      ),
    );
    vi.mocked(context.sessions.list).mockResolvedValue(page.result);

    page.updateTranscriptSearchQuery("needle");
    await page.runTranscriptSearch();
    await page.updateComplete;

    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledWith(
      "sessions.search",
      expect.objectContaining({ agentId: "main", sessionKeys: ["agent:main:one"] }),
    );
    expect(request).toHaveBeenCalledWith(
      "sessions.search",
      expect.objectContaining({ agentId: "writer", sessionKeys: ["agent:writer:one"] }),
    );
    expect(
      [...page.querySelectorAll(".sessions-transcript-search__key")].map(
        (element) => element.textContent,
      ),
    ).toEqual(["agent:writer:one", "agent:main:one"]);
  });

  it("does not request empty or unadvertised transcript searches", async () => {
    const request = vi.fn();
    const page = await createRenderedPage(
      createContext(
        createGateway({ request } as unknown as GatewayBrowserClient).gateway,
        createSessions(),
      ),
      sessionsResult([], 1),
    );

    page.updateTranscriptSearchQuery("   ");
    await page.runTranscriptSearch();
    page.updateTranscriptSearchQuery("not advertised");
    await page.runTranscriptSearch();
    await page.updateComplete;

    expect(request).not.toHaveBeenCalled();
    expect(page.querySelector(".sessions-transcript-search__status")?.textContent?.trim()).toBe("");
    expect(
      page.querySelector<HTMLButtonElement>('.sessions-transcript-search button[type="submit"]')
        ?.disabled,
    ).toBe(true);
  });

  it("drops a transcript result after the query changes while it is pending", async () => {
    const response = createDeferred<SessionsSearchResult>();
    const request = vi.fn(() => response.promise);
    const mutableGateway = createGateway({ request } as unknown as GatewayBrowserClient);
    mutableGateway.emit({
      hello: { features: { methods: ["sessions.search"] } } as ApplicationGatewaySnapshot["hello"],
    });
    const page = await createRenderedPage(
      createContext(mutableGateway.gateway, createSessions()),
      sessionsResult([{ key: "agent:main:stale", kind: "direct", updatedAt: 1 }], 1),
    );
    vi.mocked(page.context.sessions.list).mockResolvedValue(page.result);

    page.updateTranscriptSearchQuery("old query");
    const pending = page.runTranscriptSearch();
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    page.updateTranscriptSearchQuery("new query");
    response.resolve({
      results: [
        {
          sessionKey: "agent:main:stale",
          sessionId: "stale",
          messageId: "message-stale",
          role: "assistant",
          timestamp: 42,
          snippet: "old query",
          score: 1,
        },
      ],
    });
    await pending;
    await page.updateComplete;

    expect(page.transcriptSearchQuery).toBe("new query");
    expect(page.querySelector(".sessions-transcript-search__status")?.textContent?.trim()).toBe("");
  });

  it("drops transcript results and in-flight work when agent scope changes", async () => {
    const response = createDeferred<SessionsSearchResult>();
    const request = vi.fn(() => response.promise);
    const mutableGateway = createGateway({ request } as unknown as GatewayBrowserClient);
    mutableGateway.emit({
      hello: { features: { methods: ["sessions.search"] } } as ApplicationGatewaySnapshot["hello"],
    });
    const context = createContext(mutableGateway.gateway, createSessions());
    let notifyScopeChange: Parameters<ApplicationContext["agentSelection"]["subscribe"]>[0] = () =>
      undefined;
    context.agentSelection.subscribe = (listener) => {
      notifyScopeChange = listener;
      return () => undefined;
    };
    const page = await createRenderedPage(
      context,
      sessionsResult([{ key: "agent:main:stale", kind: "direct", updatedAt: 1 }], 1),
    );
    vi.mocked(context.sessions.list).mockResolvedValue(page.result);

    page.updateTranscriptSearchQuery("needle");
    const pending = page.runTranscriptSearch();
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    context.agentSelection.state.scopeId = null;
    notifyScopeChange(context.agentSelection.state);
    await page.updateComplete;

    expect(page.transcriptSearchQuery).toBe("needle");
    expect(page.querySelector(".sessions-transcript-search__result")).toBeNull();

    response.resolve({
      results: [
        {
          sessionKey: "agent:main:stale",
          sessionId: "stale",
          messageId: "message-stale",
          role: "assistant",
          timestamp: 42,
          snippet: "needle",
          score: 1,
        },
      ],
    });
    await pending;
    await page.updateComplete;
    expect(page.querySelector(".sessions-transcript-search__status")?.textContent?.trim()).toBe("");
  });

  it.each([
    { action: "active", offsets: [0, 200, 400], query: "needle" },
    { action: "same", offsets: [0, 200, 400], query: "needle" },
    { action: "clear", offsets: [0], query: null },
    { action: "detach", offsets: [0], query: null },
    { action: "filter", offsets: [0], query: null },
    { action: "replace", offsets: [0, 0, 200, 400], query: "replacement needle" },
  ])(
    "limits pending roster work to the current query after $action",
    async ({ action, offsets, query }) => {
      const firstPage = createDeferred<SessionsListResult>();
      const rows = Array.from({ length: 401 }, (_, index) => ({
        key: `agent:main:session-${index}`,
        kind: "direct" as const,
        updatedAt: 1,
      }));
      const rosterPage = (offset = 0): SessionsListResult => ({
        ts: 1,
        path: "",
        defaults: { modelProvider: null, model: null, contextTokens: null },
        count: rows.slice(offset, offset + 200).length,
        sessions: rows.slice(offset, offset + 200),
        totalCount: rows.length,
        offset,
        hasMore: offset + 200 < rows.length,
        nextOffset: offset + 200 < rows.length ? offset + 200 : undefined,
      });
      const list = vi
        .fn(async (options?: SessionListOptions) => rosterPage(options?.offset))
        .mockReturnValueOnce(firstPage.promise);
      const request = vi.fn(async (_method: string, _params: unknown) => ({ results: [] }));
      const mutableGateway = createGateway({ request } as unknown as GatewayBrowserClient);
      mutableGateway.emit({
        hello: {
          features: { methods: ["sessions.search"] },
        } as ApplicationGatewaySnapshot["hello"],
      });
      const managed = createManagedSessions({ list });
      const page = await createRenderedPage(
        createContext(mutableGateway.gateway, managed.sessions),
        rosterPage(),
      );
      page.updateTranscriptSearchQuery("needle");
      const pending = page.runTranscriptSearch();
      await vi.waitFor(() => expect(list).toHaveBeenCalledOnce());
      await page.updateComplete;

      if (action === "clear") {
        page
          .querySelector<HTMLButtonElement>('.sessions-transcript-search button[type="button"]')!
          .click();
      } else if (action === "detach") {
        page.remove();
      } else if (action === "filter") {
        page.routeData = { expandedSessionKey: null, statusFilter: "archived" };
      } else if (action === "replace") {
        page.updateTranscriptSearchQuery("replacement needle");
        await page.runTranscriptSearch();
      } else if (action === "same") {
        page.updateTranscriptSearchQuery("needle");
      }
      await page.updateComplete;
      firstPage.resolve(rosterPage());
      await pending;
      await page.updateComplete;

      expect(list.mock.calls.map(([options]) => options?.offset)).toEqual(offsets);
      expect(request.mock.calls.map(([, params]) => params)).toEqual(
        query ? Array.from({ length: 3 }, () => expect.objectContaining({ query })) : [],
      );
      expect(page.querySelector(".sessions-transcript-search__empty") !== null).toBe(
        query !== null,
      );
      expect(
        page.querySelector(".sessions-transcript-search__status")?.getAttribute("aria-busy"),
      ).toBe("false");
    },
  );

  it("renders a roster failure and retries the same submitted query", async () => {
    const listed = sessionsResult([{ key: "agent:main:retry", kind: "direct", updatedAt: 1 }], 1);
    const list = vi.fn(async () => listed).mockRejectedValueOnce(new Error("roster unavailable"));
    const request = vi.fn(async () => ({ results: [] }));
    const mutableGateway = createGateway({ request } as unknown as GatewayBrowserClient);
    mutableGateway.emit({
      hello: { features: { methods: ["sessions.search"] } } as ApplicationGatewaySnapshot["hello"],
    });
    const managed = createManagedSessions({ list });
    const page = await createRenderedPage(
      createContext(mutableGateway.gateway, managed.sessions),
      listed,
    );
    page.updateTranscriptSearchQuery("needle");
    await page.runTranscriptSearch();
    await page.updateComplete;
    expect(page.querySelector(".sessions-transcript-search__notice")?.textContent).toContain(
      "roster unavailable",
    );
    expect(request).not.toHaveBeenCalled();

    page.querySelector<HTMLButtonElement>(".sessions-transcript-search__notice button")!.click();
    await vi.waitFor(() =>
      expect(page.querySelector(".sessions-transcript-search__empty")).not.toBeNull(),
    );
    expect(list).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledExactlyOnceWith("sessions.search", {
      agentId: "main",
      sessionKeys: ["agent:main:retry"],
      query: "needle",
      limit: 25,
    });
    expect(page.querySelector(".sessions-transcript-search__notice")).toBeNull();
  });

  it("does not reuse old roster keys while a changed filter is loading", async () => {
    const request = vi.fn(async () => ({ results: [] }));
    const mutableGateway = createGateway({ request } as unknown as GatewayBrowserClient);
    mutableGateway.emit({
      hello: { features: { methods: ["sessions.search"] } } as ApplicationGatewaySnapshot["hello"],
    });
    const listed = {
      count: 1,
      sessions: [{ key: "agent:main:new-scope", kind: "direct" }],
    } as SessionsListResult;
    const managed = createManagedSessions({ list: vi.fn(async () => listed) });
    const page = await createRenderedPage(createContext(mutableGateway.gateway, managed.sessions), {
      count: 1,
      sessions: [{ key: "agent:main:old-scope", kind: "direct" }],
    } as SessionsListResult);
    const unknown = page.querySelector<HTMLInputElement>('input[name="includeUnknown"]');
    expect(unknown).toBeDefined();
    unknown!.checked = true;
    unknown!.dispatchEvent(new Event("change", { bubbles: true }));
    await page.updateComplete;
    page.updateTranscriptSearchQuery("needle");
    await page.runTranscriptSearch();

    expect(managed.sessions.list).toHaveBeenCalledWith(
      expect.objectContaining({ includeUnknown: true }),
    );
    expect(request).toHaveBeenCalledWith(
      "sessions.search",
      expect.objectContaining({
        sessionKeys: ["agent:main:new-scope"],
      }),
    );
  });

  it("does not narrow or retire transcript search when the metadata query changes", async () => {
    const request = vi.fn(async () => ({ results: [] }));
    const mutableGateway = createGateway({ request } as unknown as GatewayBrowserClient);
    mutableGateway.emit({
      hello: { features: { methods: ["sessions.search"] } } as ApplicationGatewaySnapshot["hello"],
    });
    const listed = {
      count: 1,
      sessions: [{ key: "agent:main:content-only", kind: "direct" }],
    } as SessionsListResult;
    const managed = createManagedSessions({ list: vi.fn(async () => listed) });
    const page = await createRenderedPage(
      createContext(mutableGateway.gateway, managed.sessions),
      listed,
    );
    page.updateTranscriptSearchQuery("needle");
    await page.runTranscriptSearch();
    await page.updateComplete;
    expect(page.querySelector(".sessions-transcript-search__empty")).not.toBeNull();
    const completedRequests = request.mock.calls.length;
    const input = page.querySelector<HTMLInputElement>(".sessions-toolbar__search input")!;
    input.value = "metadata-only";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await page.updateComplete;
    expect(page.querySelector(".sessions-transcript-search__empty")).not.toBeNull();
    expect(request).toHaveBeenCalledTimes(completedRequests);
    await page.runTranscriptSearch();
    for (const [options] of vi.mocked(managed.sessions.list).mock.calls) {
      expect(options?.search).toBeUndefined();
    }
    expect(request).toHaveBeenCalledWith(
      "sessions.search",
      expect.objectContaining({ sessionKeys: ["agent:main:content-only"] }),
    );
  });

  it.each(["completed", "pending"])(
    "retires %s active-session matches when the route changes to archived sessions",
    async (completion) => {
      let resolveSearch!: (value: SessionsSearchResult) => void;
      const response = new Promise<SessionsSearchResult>((resolve) => {
        resolveSearch = resolve;
      });
      const request = vi.fn(() => response);
      const mutableGateway = createGateway({ request } as unknown as GatewayBrowserClient);
      mutableGateway.emit({
        hello: {
          features: { methods: ["sessions.search"] },
        } as ApplicationGatewaySnapshot["hello"],
      });
      const context = createContext(mutableGateway.gateway, createSessions());
      const page = await createRenderedPage(context, {
        count: 1,
        sessions: [{ key: "agent:main:active", label: "Active task", archived: false }],
      } as SessionsListResult);
      vi.mocked(context.sessions.list).mockResolvedValue(page.result);
      page.updateTranscriptSearchQuery("release notes");
      const pending = page.runTranscriptSearch();
      await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
      const result: SessionsSearchResult = {
        results: [
          {
            sessionKey: "agent:main:active",
            sessionId: "active",
            messageId: "message-active",
            role: "assistant",
            timestamp: 42,
            snippet: "release notes from the active task",
            score: 1,
          },
        ],
      };
      if (completion === "completed") {
        resolveSearch(result);
        await pending;
        await page.updateComplete;
        expect(page.textContent).toContain("release notes from the active task");
      }

      page.routeData = {
        expandedSessionKey: null,
        statusFilter: "archived",
      };
      await page.updateComplete;
      if (completion === "pending") {
        resolveSearch(result);
        await pending;
        await page.updateComplete;
      }

      expect(page.statusFilter).toBe("archived");
      expect(page.textContent).not.toContain("release notes from the active task");
      expect(page.transcriptSearchQuery).toBe("release notes");
      await vi.waitFor(() =>
        expect(page.querySelector(".sessions-transcript-search__status")?.textContent?.trim()).toBe(
          "",
        ),
      );
    },
  );
});
