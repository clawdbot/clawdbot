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
  // The dialog itself is covered by input-dialog.test.ts; here it only stands
  // in for the operator submitting a name.
  vi.mocked(showInputDialog).mockImplementation(async (options) => {
    await options.submit?.("Client work");
    return "Client work";
  });
  return { mutableGateway, page, sessions };
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

  it("skips the assignment when its catalog write outlived the connection", async () => {
    let landCatalogWrite!: () => void;
    const pending = new Promise<SessionGroupMutationResult>((resolve) => {
      landCatalogWrite = () => resolve("completed");
    });
    const { mutableGateway, page, sessions } = await mountGroupsPage(() => pending);

    const created = page.requestNewCategory(SESSION_KEY);
    await vi.waitFor(() => expect(sessions.groupsPut).toHaveBeenCalledOnce());

    // Replacement connection: the catalog entry belongs to the old one, so the
    // row must not be filed into a group this connection never confirmed.
    mutableGateway.emit({ client: {} as GatewayBrowserClient });
    landCatalogWrite();
    await created;

    expect(sessions.patch).not.toHaveBeenCalled();
  });

  it("skips the assignment when the row disappeared during the catalog write", async () => {
    let landCatalogWrite!: () => void;
    const pending = new Promise<SessionGroupMutationResult>((resolve) => {
      landCatalogWrite = () => resolve("completed");
    });
    const { page, sessions } = await mountGroupsPage(() => pending);

    const created = page.requestNewCategory(SESSION_KEY);
    await vi.waitFor(() => expect(sessions.groupsPut).toHaveBeenCalledOnce());

    // The session was deleted while the catalog write was in flight; patching
    // its key now would recreate the entry the operator just removed.
    page.result = { count: 0, sessions: [] } as unknown as SessionsListResult;
    landCatalogWrite();
    await created;

    expect(sessions.patch).not.toHaveBeenCalled();
  });

  it("skips the assignment when the catalog itself reports the write stale", async () => {
    // The capability retires the write on its own connection epoch, which the
    // page's scope predicate cannot observe; the assignment must still stop.
    const { page, sessions } = await mountGroupsPage(async () => "stale");

    await page.requestNewCategory(SESSION_KEY);

    expect(sessions.groupsPut).toHaveBeenCalledOnce();
    expect(sessions.patch).not.toHaveBeenCalled();
  });
});
