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
    sessions: [{ key: SESSION_KEY, archived: false }],
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
      sessions: [{ key: SESSION_KEY, archived: false }],
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

  it("reports the skipped move when the row left the list during the catalog write", async () => {
    let landCatalogWrite!: () => void;
    const pending = new Promise<SessionGroupMutationResult>((resolve) => {
      landCatalogWrite = () => resolve("completed");
    });
    const { page, sessions, submitMessages } = await mountGroupsPage(() => pending);

    const created = page.requestNewCategory(SESSION_KEY);
    await vi.waitFor(() => expect(sessions.groupsPut).toHaveBeenCalledOnce());

    // The row left this bounded list while the catalog write was in flight;
    // patching its key now could recreate an entry the operator removed.
    page.result = { count: 0, sessions: [] } as unknown as SessionsListResult;
    landCatalogWrite();
    await created;

    expect(sessions.patch).not.toHaveBeenCalled();
    // The group landed and the move did not. Retrying would only re-create the
    // group, so the dialog closes — but the partial outcome has to stay visible
    // on the page rather than reading as a clean success.
    expect(submitMessages).toEqual([null]);
    expect(page.error).toBe(
      "Group created, but the move was skipped because the list changed. Move from the row menu.",
    );
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
