/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionsListResult } from "../../api/types.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import { showPromptDialog } from "../../components/prompt-dialog.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import {
  createContext,
  createGateway,
  createRenderedPage,
  createSessions,
} from "./sessions-page.test-support.ts";

vi.mock("../../components/prompt-dialog.ts", () => ({ showPromptDialog: vi.fn() }));

const SESSION_KEY = "agent:main:move-me";

afterEach(() => {
  document.body.replaceChildren();
  vi.mocked(showPromptDialog).mockReset();
  vi.restoreAllMocks();
});

async function mountGroupsPage(groupsPut: () => Promise<unknown>) {
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
  // The dialog itself is covered by prompt-dialog.test.ts; here it only stands
  // in for the operator submitting a name.
  vi.mocked(showPromptDialog).mockImplementation(async (options) => {
    await options.submit("Client work");
  });
  return { mutableGateway, page, sessions };
}

describe("sessions page new group", () => {
  it("writes the group catalog before assigning the session", async () => {
    const { page, sessions } = await mountGroupsPage(async () => undefined);

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
    const pending = new Promise<undefined>((resolve) => {
      landCatalogWrite = () => resolve(undefined);
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
});
