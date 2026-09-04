/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionsListResult } from "../../api/types.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import {
  createTestSessionCapability,
  sessionsResult,
} from "../../lib/sessions/session-capability.test-support.ts";
import {
  createContext,
  createGateway,
  createRenderedPage,
  createSessions,
} from "./sessions-page.test-support.ts";

vi.mock("../../components/confirm-dialog.ts", () => ({ showConfirmDialog: vi.fn() }));

afterEach(() => {
  document.body.replaceChildren();
  vi.mocked(showConfirmDialog).mockReset();
  vi.restoreAllMocks();
});

describe("sessions page archived deletion", () => {
  it("removes a confirmed selection while the delete RPC is pending and restores it on rejection", async () => {
    const target = {
      key: "agent:main:cloud",
      kind: "direct" as const,
      sessionId: "cloud-id",
      label: "Cloud thread",
      archived: true,
      updatedAt: 1,
    };
    const response = createDeferred<{ deleted: boolean }>();
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.delete") {
        return response.promise;
      }
      if (method === "sessions.list") {
        return sessionsResult([target], 1);
      }
      if (method === "sessions.subscribe") {
        return { subscribed: true };
      }
      return {};
    });
    const { gateway } = createGateway({ request } as unknown as GatewayBrowserClient);
    const sessions = createTestSessionCapability(gateway);
    const page = await createRenderedPage(
      createContext(gateway, sessions),
      sessionsResult([target], 1),
      "archived",
    );
    try {
      await sessions.refreshList({ agentId: "main", archivedFilter: "archived" });
      vi.mocked(showConfirmDialog).mockResolvedValue(true);
      const operation = page.deleteSessionFromMenu(target);
      await vi.waitFor(() =>
        expect(request).toHaveBeenCalledWith(
          "sessions.delete",
          expect.objectContaining({ key: target.key }),
          { timeoutMs: 10 * 60_000 },
        ),
      );
      expect(page.result?.sessions).toEqual([]);
      response.reject(new Error("cloud cleanup failed"));
      await operation;
      expect(page.result?.sessions.map(({ key }) => key)).toContain(target.key);
      expect(page.error).toContain("cloud cleanup failed");
    } finally {
      page.remove();
      sessions.dispose();
    }
  });

  it("re-enumerates all archived sessions before bulk deletion", async () => {
    // The rendered result holds one archived row; enumeration must find both.
    const archivedKeys = ["agent:main:old-1", "agent:main:old-2"];
    const sessions = createSessions({
      list: vi.fn(async () => ({
        count: 2,
        sessions: archivedKeys.map((key) => ({ key, archived: true })),
      })) as unknown as SessionCapability["list"],
      deleteMany: vi.fn(async () => ({
        deleted: archivedKeys,
        errors: [],
        preservedWorktrees: [],
      })),
    });
    const mutableGateway = createGateway({} as GatewayBrowserClient);
    mutableGateway.emit({
      hello: {
        auth: { role: "operator", scopes: ["operator.read", "operator.write"] },
        features: { methods: ["sessions.delete"] },
      } as ApplicationGatewaySnapshot["hello"],
    });
    const page = await createRenderedPage(
      createContext(mutableGateway.gateway, sessions),
      {
        count: 2,
        sessions: [
          { key: archivedKeys[0], archived: true },
          { key: "agent:main:active", archived: false },
        ],
      } as SessionsListResult,
      "archived",
    );
    vi.mocked(showConfirmDialog).mockResolvedValue(true);

    page.querySelector<HTMLButtonElement>(".settings-section__actions .danger")?.click();
    await vi.waitFor(() => expect(sessions.deleteMany).toHaveBeenCalledOnce());

    expect(sessions.list).toHaveBeenCalledWith(
      expect.objectContaining({ archivedFilter: "archived", limit: 1000 }),
    );
    expect(showConfirmDialog).toHaveBeenCalledWith({
      message:
        "Delete 2 archived sessions and their transcripts? Any attached workers will be stopped safely first.",
      confirmLabel: "Delete",
      danger: true,
    });
    expect(sessions.deleteMany).toHaveBeenCalledWith([
      {
        key: archivedKeys[0],
        agentId: undefined,
        deleteTranscript: true,
        archivedOnly: true,
      },
      {
        key: archivedKeys[1],
        agentId: undefined,
        deleteTranscript: true,
        archivedOnly: true,
      },
    ]);
  });

  it("does not let write-scoped operators delete an active session", async () => {
    const key = "agent:main:active";
    const sessions = createSessions();
    const mutableGateway = createGateway({} as GatewayBrowserClient);
    mutableGateway.emit({
      hello: {
        auth: { role: "operator", scopes: ["operator.read", "operator.write"] },
        features: { methods: ["sessions.delete"] },
      } as ApplicationGatewaySnapshot["hello"],
    });
    const page = await createRenderedPage(createContext(mutableGateway.gateway, sessions), {
      count: 1,
      sessions: [{ key, archived: false }],
    } as SessionsListResult);
    vi.mocked(showConfirmDialog).mockResolvedValue(true);

    await page.deleteSessionFromMenu({ key, archived: false } as SessionsListResult["sessions"][0]);

    expect(sessions.deleteMany).not.toHaveBeenCalled();
    expect(page.error).toBe("This action requires operator.admin access.");
  });

  it("aborts delete-all when an enumeration page fails", async () => {
    const sessions = createSessions({
      list: vi.fn(async () => null) as unknown as SessionCapability["list"],
      deleteMany: vi.fn(async () => ({ deleted: [], errors: [], preservedWorktrees: [] })),
    });
    sessions.state.error = "list failed";
    const { gateway } = createGateway({} as GatewayBrowserClient);
    const page = await createRenderedPage(
      createContext(gateway, sessions),
      {
        count: 1,
        sessions: [{ key: "agent:main:old-1", archived: true }],
      } as SessionsListResult,
      "archived",
    );
    vi.mocked(showConfirmDialog).mockResolvedValue(true);

    page.querySelector<HTMLButtonElement>(".settings-section__actions .danger")?.click();
    await vi.waitFor(() => expect(sessions.list).toHaveBeenCalledOnce());

    expect(showConfirmDialog).not.toHaveBeenCalled();
    expect(sessions.deleteMany).not.toHaveBeenCalled();
  });

  it("paginates the archived enumeration until the listing is exhausted", async () => {
    const pageOne = ["agent:main:old-1", "agent:main:old-2"];
    const pageTwo = ["agent:main:old-3"];
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        count: 3,
        sessions: pageOne.map((key) => ({ key, archived: true })),
        hasMore: true,
        nextOffset: 2,
      })
      .mockResolvedValueOnce({
        count: 3,
        sessions: pageTwo.map((key) => ({ key, archived: true })),
        hasMore: false,
        nextOffset: null,
      });
    const sessions = createSessions({
      list: list as unknown as SessionCapability["list"],
      deleteMany: vi.fn(async () => ({
        deleted: [...pageOne, ...pageTwo],
        errors: [],
        preservedWorktrees: [],
      })),
    });
    const { gateway } = createGateway({} as GatewayBrowserClient);
    const page = await createRenderedPage(
      createContext(gateway, sessions),
      {
        count: 1,
        sessions: [{ key: pageOne[0], archived: true }],
      } as SessionsListResult,
      "archived",
    );
    vi.mocked(showConfirmDialog).mockResolvedValue(true);

    page.querySelector<HTMLButtonElement>(".settings-section__actions .danger")?.click();
    await vi.waitFor(() => expect(sessions.deleteMany).toHaveBeenCalledOnce());

    expect(list).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenNthCalledWith(2, expect.objectContaining({ offset: 2 }));
    expect(showConfirmDialog).toHaveBeenCalledWith({
      message:
        "Delete 3 archived sessions and their transcripts? Any attached workers will be stopped safely first.",
      confirmLabel: "Delete",
      danger: true,
    });
    expect(sessions.deleteMany).toHaveBeenCalledWith(
      [...pageOne, ...pageTwo].map((key) => ({
        key,
        agentId: undefined,
        deleteTranscript: true,
        archivedOnly: true,
      })),
    );
  });

  it("recovers a moved archived session and never deletes a repeated row twice", async () => {
    const keys: [string, string, string] = [
      "agent:main:first",
      "agent:main:repeated",
      "agent:main:moved",
    ];
    const archived = (key: string) => ({ key, archived: true });
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        count: 2,
        totalCount: 3,
        sessions: [archived(keys[0]), archived(keys[1])],
        hasMore: true,
        nextOffset: 2,
      })
      .mockResolvedValueOnce({
        count: 1,
        totalCount: 3,
        sessions: [archived(keys[1])],
        hasMore: false,
        nextOffset: null,
      })
      .mockResolvedValueOnce({
        count: 3,
        totalCount: 3,
        sessions: keys.map(archived),
        hasMore: false,
        nextOffset: null,
      });
    const sessions = createSessions({
      list: list as unknown as SessionCapability["list"],
      deleteMany: vi.fn(async () => ({
        deleted: keys,
        errors: [],
        preservedWorktrees: [],
      })),
    });
    const { gateway } = createGateway({} as GatewayBrowserClient);
    const page = await createRenderedPage(
      createContext(gateway, sessions),
      { count: 1, sessions: [archived(keys[0])] } as SessionsListResult,
      "archived",
    );
    vi.mocked(showConfirmDialog).mockResolvedValue(true);

    page.querySelector<HTMLButtonElement>(".settings-section__actions .danger")?.click();
    await vi.waitFor(() => expect(sessions.deleteMany).toHaveBeenCalledOnce());

    expect(list).toHaveBeenCalledTimes(3);
    expect(showConfirmDialog).toHaveBeenCalledWith({
      message:
        "Delete 3 archived sessions and their transcripts? Any attached workers will be stopped safely first.",
      confirmLabel: "Delete",
      danger: true,
    });
    expect(sessions.deleteMany).toHaveBeenCalledWith(
      keys.map((key) => ({
        key,
        agentId: undefined,
        deleteTranscript: true,
        archivedOnly: true,
      })),
    );
  });

  it("refuses partial destructive deletion when the complete archived roster never arrives", async () => {
    const key = "agent:main:only-visible";
    const archived = { key, archived: true };
    const list = vi.fn(async (options: { offset?: number }) => ({
      count: 1,
      totalCount: 2,
      sessions: [archived],
      hasMore: !options.offset,
      nextOffset: options.offset ? null : 1,
    }));
    const sessions = createSessions({
      list: list as unknown as SessionCapability["list"],
      deleteMany: vi.fn(async () => ({ deleted: [key], errors: [], preservedWorktrees: [] })),
    });
    const { gateway } = createGateway({} as GatewayBrowserClient);
    const page = await createRenderedPage(
      createContext(gateway, sessions),
      { count: 1, sessions: [archived] } as SessionsListResult,
      "archived",
    );
    vi.mocked(showConfirmDialog).mockResolvedValue(true);

    await page.deleteAllArchived();

    expect(showConfirmDialog).not.toHaveBeenCalled();
    expect(sessions.deleteMany).not.toHaveBeenCalled();
    expect(page.error).toContain("archived session enumeration");
  });

  it("refuses partial destructive deletion when a later page omits the authoritative total", async () => {
    const key = "agent:main:only-visible";
    const archived = { key, archived: true };
    const list = vi.fn(async (options: { offset?: number }) => ({
      count: 1,
      ...(options.offset ? {} : { totalCount: 2 }),
      sessions: [archived],
      hasMore: !options.offset,
      nextOffset: options.offset ? null : 1,
    }));
    const sessions = createSessions({
      list: list as unknown as SessionCapability["list"],
      deleteMany: vi.fn(async () => ({ deleted: [key], errors: [], preservedWorktrees: [] })),
    });
    const { gateway } = createGateway({} as GatewayBrowserClient);
    const page = await createRenderedPage(
      createContext(gateway, sessions),
      { count: 1, sessions: [archived] } as SessionsListResult,
      "archived",
    );
    vi.mocked(showConfirmDialog).mockResolvedValue(true);

    await page.deleteAllArchived();

    expect(showConfirmDialog).not.toHaveBeenCalled();
    expect(sessions.deleteMany).not.toHaveBeenCalled();
    expect(page.error).toContain("archived session enumeration was incomplete");
  });

  it.each([
    ["all agents", null, undefined],
    ["the selected agent", "writer", "writer"],
  ] as const)(
    "enumerates all archived threads for %s instead of narrowing to a route deep link",
    async (_label, scopeId, expectedAgentId) => {
      const linked = { key: "agent:main:linked", archived: true };
      const other = { key: "agent:writer:other", archived: true };
      const list = vi.fn(async (options: { search?: string; agentId?: string }) => {
        const sessions =
          options.search === linked.key || options.agentId === "main" ? [linked] : [linked, other];
        return { count: sessions.length, totalCount: sessions.length, sessions };
      });
      const sessions = createSessions({
        list: list as unknown as SessionCapability["list"],
        deleteMany: vi.fn(async () => ({
          deleted: [linked.key, other.key],
          errors: [],
          preservedWorktrees: [],
        })),
      });
      const { gateway } = createGateway({} as GatewayBrowserClient);
      const context = createContext(gateway, sessions);
      context.agentSelection.state.scopeId = scopeId;
      const page = await createRenderedPage(
        context,
        { count: 1, sessions: [linked] } as SessionsListResult,
        "archived",
        linked.key,
      );
      vi.mocked(showConfirmDialog).mockResolvedValue(true);

      await page.deleteAllArchived();

      const options = list.mock.calls[0]?.[0];
      expect(options).not.toHaveProperty("search");
      if (expectedAgentId) {
        expect(options).toHaveProperty("agentId", expectedAgentId);
      } else {
        expect(options).not.toHaveProperty("agentId");
      }
      expect(showConfirmDialog).toHaveBeenCalledWith({
        message:
          "Delete 2 archived sessions and their transcripts? Any attached workers will be stopped safely first.",
        confirmLabel: "Delete",
        danger: true,
      });
      expect(sessions.deleteMany).toHaveBeenCalledWith(
        [linked.key, other.key].map((key) => ({
          key,
          agentId: undefined,
          deleteTranscript: true,
          archivedOnly: true,
        })),
      );
    },
  );
});
