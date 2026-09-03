/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionsListResult } from "../../api/types.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import { showInputDialog } from "../../components/input-dialog.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import type { SessionGroupMutationResult } from "../../lib/sessions/session-capability.ts";
import {
  createContext,
  createGateway,
  createRenderedPage,
  createSessions,
} from "./sessions-page.test-support.ts";

vi.mock("../../components/input-dialog.ts", () => ({ showInputDialog: vi.fn() }));

const SESSION_KEY = "agent:main:move-me";
const SESSION_ID = "original-session";

afterEach(() => {
  document.body.replaceChildren();
  vi.mocked(showInputDialog).mockReset();
  vi.restoreAllMocks();
});

async function mountGroupsPage(groupsPut: () => Promise<SessionGroupMutationResult>) {
  const sessions = createSessions({
    groupsPut: vi.fn(groupsPut),
    patch: vi.fn(async () => ({ key: SESSION_KEY })),
  } as unknown as Partial<SessionCapability>);
  const mutableGateway = createGateway({} as GatewayBrowserClient);
  mutableGateway.emit({
    hello: {
      auth: { role: "operator", scopes: ["operator.read", "operator.write"] },
      features: { methods: ["sessions.groups.put", "sessions.patch"] },
    } as ApplicationGatewaySnapshot["hello"],
  });
  const page = await createRenderedPage(createContext(mutableGateway.gateway, sessions), {
    count: 1,
    sessions: [{ key: SESSION_KEY, sessionId: SESSION_ID, archived: false }],
  } as SessionsListResult);
  // The dialog itself is covered by input-dialog.test.ts; here it only stands in
  // for the operator submitting a name. A recorded message is what keeps the real
  // dialog open, so the outcome of each submit is captured rather than dropped.
  const submitMessages: Array<string | null | undefined> = [];
  vi.mocked(showInputDialog).mockImplementation(async (options) => {
    submitMessages.push(await options.submit?.("Client work"));
    return "Client work";
  });
  return { mutableGateway, page, sessions, submitMessages };
}

describe("sessions page new group", () => {
  it("writes the group catalog before assigning the session", async () => {
    const { page, sessions } = await mountGroupsPage(async () => "completed");

    await page.requestNewCategory(SESSION_KEY);

    expect(sessions.groupsPut).toHaveBeenCalledWith(["Client work"]);
    expect(sessions.patch).toHaveBeenCalledOnce();
    expect(vi.mocked(sessions.patch).mock.invocationCallOrder[0]).toBeGreaterThan(
      vi.mocked(sessions.groupsPut).mock.invocationCallOrder[0]!,
    );
    expect(sessions.patch).toHaveBeenCalledWith(
      SESSION_KEY,
      { category: "Client work" },
      { agentId: undefined, expectedSessionId: SESSION_ID },
    );
  });

  it("closes the dialog when the operator navigates away from the page", async () => {
    const { page, sessions } = await mountGroupsPage(async () => "completed");
    let dialogSignal: AbortSignal | undefined;
    vi.mocked(showInputDialog).mockImplementation(async (options) => {
      dialogSignal = options.signal;
      // Sit open the way a dialog waiting on the operator does.
      await new Promise<void>((resolve) => {
        options.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return null;
    });

    const opened = page.requestNewCategory(SESSION_KEY);
    await vi.waitFor(() => expect(dialogSignal).toBeDefined());
    expect(dialogSignal?.aborted).toBe(false);

    // The dialog mounts on document.body, so detaching the page has to close it
    // rather than leave it over wherever the operator landed.
    page.remove();
    await opened;

    expect(dialogSignal?.aborted).toBe(true);
    expect(sessions.groupsPut).not.toHaveBeenCalled();
  });

  it("keeps the live dialog abortable when a second open overlaps it", async () => {
    const { page, sessions } = await mountGroupsPage(async () => "completed");
    const signals: Array<AbortSignal | undefined> = [];
    vi.mocked(showInputDialog).mockImplementation(async (options) => {
      signals.push(options.signal);
      await new Promise<void>((resolve) => {
        options.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return null;
    });

    const first = page.requestNewCategory(SESSION_KEY);
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    // A reentrant open must not install a controller of its own: clearing it on
    // the way out would strand the dialog that is actually on screen.
    const second = page.requestNewCategory(SESSION_KEY);
    await vi.waitFor(() => expect(signals).toHaveLength(2));

    page.remove();
    await Promise.all([first, second]);

    expect(signals[0]?.aborted).toBe(true);
    expect(sessions.groupsPut).not.toHaveBeenCalled();
  });

  it("skips the assignment when its catalog write outlived the connection", async () => {
    let landCatalogWrite!: () => void;
    const pending = new Promise<SessionGroupMutationResult>((resolve) => {
      landCatalogWrite = () => resolve("completed");
    });
    const { mutableGateway, page, sessions, submitMessages } = await mountGroupsPage(() => pending);

    const created = page.requestNewCategory(SESSION_KEY);
    await vi.waitFor(() => expect(sessions.groupsPut).toHaveBeenCalledOnce());

    // Replacement connection: the catalog entry belongs to the old one, so the
    // row must not be filed into a group this connection never confirmed.
    mutableGateway.emit({ client: {} as GatewayBrowserClient });
    landCatalogWrite();
    await created;

    expect(sessions.patch).not.toHaveBeenCalled();
    // Nothing landed, so the attempt has to stay on screen and retryable rather
    // than closing on an outcome the operator never got.
    expect(submitMessages).toEqual([
      "Gateway connection replaced before the group was saved. Try again.",
    ]);
  });

  it("lets the operator resubmit the kept name on the replacement connection", async () => {
    let landCatalogWrite!: () => void;
    const pending = new Promise<SessionGroupMutationResult>((resolve) => {
      landCatalogWrite = () => resolve("completed");
    });
    let firstWrite = true;
    const { mutableGateway, page, sessions, submitMessages } = await mountGroupsPage(() => {
      if (firstWrite) {
        firstWrite = false;
        return pending;
      }
      return Promise.resolve("completed");
    });

    const created = page.requestNewCategory(SESSION_KEY);
    await vi.waitFor(() => expect(sessions.groupsPut).toHaveBeenCalledOnce());
    mutableGateway.emit({ client: {} as GatewayBrowserClient });
    landCatalogWrite();
    await created;
    expect(sessions.patch).not.toHaveBeenCalled();

    // The replacement connection reloads the list before the operator retries.
    page.result = {
      count: 1,
      sessions: [{ key: SESSION_KEY, sessionId: SESSION_ID, archived: false }],
    } as SessionsListResult;
    await page.requestNewCategory(SESSION_KEY);

    expect(submitMessages[1]).toBeNull();
    expect(sessions.patch).toHaveBeenCalledOnce();
    expect(sessions.patch).toHaveBeenCalledWith(
      SESSION_KEY,
      { category: "Client work" },
      expect.anything(),
    );
  });

  it.each([
    { change: "paged out", currentId: SESSION_ID, visible: false },
    { change: "reset with the same identity", currentId: SESSION_ID, visible: true },
    { change: "deleted", currentId: undefined, visible: false },
    { change: "replaced", currentId: "replacement-session", visible: true },
  ])(
    "lets the Gateway decide a move when the row was $change mid-write",
    async ({ currentId, visible }) => {
      let landCatalogWrite!: () => void;
      const pending = new Promise<SessionGroupMutationResult>((resolve) => {
        landCatalogWrite = () => resolve("completed");
      });
      const { page, sessions, submitMessages } = await mountGroupsPage(() => pending);
      const failure = `Session ${SESSION_KEY} changed before patch. Retry.`;
      let moved = false;
      vi.mocked(sessions.patch).mockImplementation(async (_key, _patch, options) => {
        if (options?.expectedSessionId && options.expectedSessionId !== currentId) {
          throw new Error(failure);
        }
        moved = true;
        return { key: SESSION_KEY } as Awaited<ReturnType<SessionCapability["patch"]>>;
      });

      const created = page.requestNewCategory(SESSION_KEY);
      await vi.waitFor(() => expect(sessions.groupsPut).toHaveBeenCalledOnce());

      page.result = {
        count: visible ? 1 : 0,
        sessions: visible ? [{ key: SESSION_KEY, sessionId: currentId, label: "Updated row" }] : [],
      } as SessionsListResult;
      landCatalogWrite();
      await created;

      expect(sessions.patch).toHaveBeenCalledWith(
        SESSION_KEY,
        { category: "Client work" },
        { agentId: undefined, expectedSessionId: SESSION_ID },
      );
      expect(moved).toBe(currentId === SESSION_ID);
      expect(submitMessages).toEqual([currentId === SESSION_ID ? null : failure]);
    },
  );

  it("captures the selected identity before the dialog's lazy load", async () => {
    const { page, sessions } = await mountGroupsPage(async () => "completed");
    const pending = page.requestNewCategory(SESSION_KEY);
    page.result = {
      count: 1,
      sessions: [{ key: SESSION_KEY, sessionId: "replacement-session" }],
    } as SessionsListResult;
    await pending;
    expect(sessions.patch).toHaveBeenCalledWith(
      SESSION_KEY,
      { category: "Client work" },
      { agentId: undefined, expectedSessionId: SESSION_ID },
    );
  });

  it("creates an empty group without a selected row", async () => {
    const { page, sessions, submitMessages } = await mountGroupsPage(async () => "completed");
    await page.requestNewCategory();
    expect(sessions.groupsPut).toHaveBeenCalledWith(["Client work"]);
    expect(sessions.patch).not.toHaveBeenCalled();
    expect(submitMessages).toEqual([null]);
  });

  it("does not assign when creating the catalog entry fails", async () => {
    const { page, sessions, submitMessages } = await mountGroupsPage(async () => {
      throw new Error("Group name rejected");
    });
    await page.requestNewCategory(SESSION_KEY);
    expect(sessions.patch).not.toHaveBeenCalled();
    expect(submitMessages).toEqual(["Group name rejected"]);
  });

  it("asks for a refresh instead of starting an unbound move", async () => {
    const { page, sessions } = await mountGroupsPage(async () => "completed");
    page.result = { count: 1, sessions: [{ key: SESSION_KEY }] } as SessionsListResult;
    await page.requestNewCategory(SESSION_KEY);
    expect(showInputDialog).not.toHaveBeenCalled();
    expect(sessions.groupsPut).not.toHaveBeenCalled();
    expect(sessions.patch).not.toHaveBeenCalled();
    expect(page.error).toBe("Refresh");
  });

  it("skips the assignment when the catalog itself reports the write stale", async () => {
    // The capability retires the write on its own connection epoch, which the
    // page's scope predicate cannot observe; the assignment must still stop.
    const { page, sessions, submitMessages } = await mountGroupsPage(async () => "stale");

    await page.requestNewCategory(SESSION_KEY);

    expect(sessions.groupsPut).toHaveBeenCalledOnce();
    expect(sessions.patch).not.toHaveBeenCalled();
    expect(submitMessages).toEqual([
      "Gateway connection replaced before the group was saved. Try again.",
    ]);
  });
});
