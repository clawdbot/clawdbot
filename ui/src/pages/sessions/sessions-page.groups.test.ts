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
const SESSION_ID = "session-move-me";

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
      { category: "Client work", expectedSessionId: SESSION_ID },
      expect.anything(),
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
      { category: "Client work", expectedSessionId: SESSION_ID },
      expect.anything(),
    );
  });

  it("carries the captured session identity into the delayed assignment", async () => {
    let landCatalogWrite!: () => void;
    const pending = new Promise<SessionGroupMutationResult>((resolve) => {
      landCatalogWrite = () => resolve("completed");
    });
    const { page, sessions, submitMessages } = await mountGroupsPage(() => pending);

    const created = page.requestNewCategory(SESSION_KEY);
    await vi.waitFor(() => expect(sessions.groupsPut).toHaveBeenCalledOnce());

    // An ordinary refresh pages the row out of this filtered view while the
    // catalog write is in flight. The session still exists, so the assignment
    // must still go out — carrying the identity captured when the dialog opened,
    // which is what lets the Gateway refuse a genuinely replaced target.
    page.result = { count: 0, sessions: [] } as unknown as SessionsListResult;
    landCatalogWrite();
    await created;

    expect(sessions.patch).toHaveBeenCalledWith(
      SESSION_KEY,
      { category: "Client work", expectedSessionId: SESSION_ID },
      expect.anything(),
    );
    expect(submitMessages).toEqual([null]);
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
