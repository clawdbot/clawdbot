/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionsSearchResult } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionsListResult } from "../../api/types.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
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
        gateway: context.gateway,
        gatewaySnapshot: context.gateway.snapshot,
        sessions: context.sessions,
        result: {
          count: 1,
          sessions: [{ key: "agent:main:archived", label: "Archived task", archived: true }],
        } as SessionsListResult,
        loading: false,
        error: null,
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
      expect(page.transcriptSearch).toEqual({ status: "idle" });
    },
  );
});
