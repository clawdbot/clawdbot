import { describe, expect, it } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createGateway, createSessionsHarness, mountSidebar } from "../app-sidebar.ts";
import "../../components/app-sidebar.ts";

describe("AppSidebar session ownership", () => {
  it("uses the complete facet and requests unloaded creators from the Gateway", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const harness = createSessionsHarness("main", ["agent:main:main", "agent:main:ada"]);
    const result = harness.sessions.state.result;
    if (!result) {
      throw new Error("expected session list");
    }
    const ada = result.sessions.find((row) => row.key.endsWith(":ada"));
    if (!ada) {
      throw new Error("expected creator row");
    }
    ada.createdBy = { id: "profile-ada", label: "Ada" };
    result.creators = [
      { id: "profile-ada", label: "Ada" },
      { id: "profile-bob", label: "Bob" },
    ];

    const { sidebar } = await mountSidebar(gateway, harness.sessions);
    harness.publishList({ result, agentId: "main" });
    await sidebar.updateComplete;

    expect(sidebar.sessionsResult?.creators).toHaveLength(2);
    expect(sidebar.querySelector('[data-session-key="agent:main:ada"]')).not.toBeNull();
    expect(sidebar.querySelectorAll("openclaw-session-owner-chip")).toHaveLength(1);
    const select = sidebar.querySelector<HTMLSelectElement>(
      '.sidebar-session-creator-filter select[aria-label="Filter by creator"]',
    );
    select!.value = "profile-bob";
    select!.dispatchEvent(new Event("change", { bubbles: true }));
    await sidebar.updateComplete;
    expect(harness.setCreatorFilter).toHaveBeenCalledWith("profile-bob");

    result.creators = [{ id: "profile-bob", label: "Bob" }];
    harness.publishList({ result, agentId: "main" });
    await sidebar.updateComplete;
    await sidebar.updateComplete;
    expect(harness.setCreatorFilter).toHaveBeenLastCalledWith(null);
  });

  it("renders no ownership chrome when the listed sessions have fewer than two creators", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const harness = createSessionsHarness("main", [
      "agent:main:main",
      "agent:main:a",
      "agent:main:b",
    ]);
    const result = harness.sessions.state.result;
    if (!result) {
      throw new Error("expected session list");
    }
    for (const row of result.sessions) {
      row.createdBy = { id: "profile-ada", label: "Ada" };
    }
    const { sidebar } = await mountSidebar(gateway, harness.sessions);
    harness.publishList({ result, agentId: "main" });
    await sidebar.updateComplete;

    expect(sidebar.querySelector(".sidebar-session-creator-filter")).toBeNull();
    expect(sidebar.querySelector("openclaw-session-owner-chip")).toBeNull();
  });

  it("filters by creator and hides custom groups without matching sessions", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const harness = createSessionsHarness("main", [
      "agent:main:main",
      "agent:main:ada",
      "agent:main:bob",
    ]);
    const result = harness.sessions.state.result;
    if (!result) {
      throw new Error("expected session list");
    }
    const ada = result.sessions.find((row) => row.key.endsWith(":ada"));
    const bob = result.sessions.find((row) => row.key.endsWith(":bob"));
    if (!ada || !bob) {
      throw new Error("expected creator rows");
    }
    ada.createdBy = { id: "profile-ada", label: "Ada" };
    ada.category = "Research";
    bob.createdBy = { id: "profile-bob", label: "Bob" };
    bob.category = "Operations";
    harness.publish({ groups: ["Research", "Operations"] });
    const { sidebar } = await mountSidebar(gateway, harness.sessions);
    harness.publishList({ result, agentId: "main" });
    await sidebar.updateComplete;

    const select = sidebar.querySelector<HTMLSelectElement>(
      '.sidebar-session-creator-filter select[aria-label="Filter by creator"]',
    );
    expect(select).not.toBeNull();
    expect(sidebar.querySelectorAll("openclaw-session-owner-chip")).toHaveLength(2);

    select!.value = "profile-ada";
    select!.dispatchEvent(new Event("change", { bubbles: true }));
    await sidebar.updateComplete;

    expect(sidebar.querySelector('[data-session-key="agent:main:ada"]')).not.toBeNull();
    expect(sidebar.querySelector('[data-session-key="agent:main:bob"]')).toBeNull();
    expect(sidebar.querySelector('[data-session-section="category:Research"]')).not.toBeNull();
    expect(sidebar.querySelector('[data-session-section="category:Operations"]')).toBeNull();
  });

  it("filters catalog rows by authoritative creator ownership", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const backingSessionKey = "agent:main:claude-bound";
    const harness = createSessionsHarness("main", [
      "agent:main:main",
      "agent:main:ada",
      backingSessionKey,
    ]);
    const result = harness.sessions.state.result;
    if (!result) {
      throw new Error("expected session list");
    }
    const ada = result.sessions.find((row) => row.key.endsWith(":ada"));
    const adopted = result.sessions.find((row) => row.key === backingSessionKey);
    if (!ada || !adopted) {
      throw new Error("expected ownership rows");
    }
    ada.createdBy = { id: "profile-ada", label: "Ada" };
    adopted.createdBy = { id: "profile-bob", label: "Bob" };
    result.creators = [
      { id: "profile-ada", label: "Ada" },
      { id: "profile-bob", label: "Bob" },
    ];

    const { sidebar } = await mountSidebar(gateway, harness.sessions);
    sidebar.sessionCatalogs = [
      {
        id: "claude",
        label: "Claude Code",
        capabilities: { continueSession: true, archive: false },
        hosts: [
          {
            hostId: "gateway:local",
            label: "Local Claude",
            kind: "gateway",
            connected: true,
            sessions: [
              {
                threadId: "claude-thread",
                name: "Claude session",
                status: "stored",
                archived: false,
                sessionKey: backingSessionKey,
                createdBy: { id: "profile-bob", label: "Bob" },
                canContinue: true,
                canArchive: false,
              },
              {
                threadId: "external-thread",
                name: "External unowned session",
                status: "stored",
                archived: false,
                canContinue: true,
                canArchive: false,
              },
            ],
          },
        ],
      },
    ];
    harness.publishList({ result, agentId: "main" });
    await sidebar.updateComplete;

    expect(sidebar.querySelector(`[data-session-key="${backingSessionKey}"]`)).not.toBeNull();
    expect(sidebar.textContent).toContain("External unowned session");
    const select = sidebar.querySelector<HTMLSelectElement>(
      '.sidebar-session-creator-filter select[aria-label="Filter by creator"]',
    );
    select!.value = "profile-ada";
    select!.dispatchEvent(new Event("change", { bubbles: true }));
    await sidebar.updateComplete;

    expect(sidebar.querySelector(`[data-session-key="${backingSessionKey}"]`)).toBeNull();
    expect(sidebar.textContent).not.toContain("External unowned session");

    harness.publishList({
      result: { ...result, count: 1, sessions: [ada] },
      agentId: "main",
    });
    await sidebar.updateComplete;

    expect(sidebar.querySelector(`[data-session-key="${backingSessionKey}"]`)).toBeNull();
    expect(sidebar.textContent).not.toContain("External unowned session");
  });

  it("keeps catalog rows whose backing ownership is outside the loaded page", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const harness = createSessionsHarness("main", [
      "agent:main:main",
      "agent:main:ada",
      "agent:main:bob",
    ]);
    const result = harness.sessions.state.result;
    if (!result) {
      throw new Error("expected session list");
    }
    const ada = result.sessions.find((row) => row.key.endsWith(":ada"));
    const bob = result.sessions.find((row) => row.key.endsWith(":bob"));
    if (!ada || !bob) {
      throw new Error("expected creator rows");
    }
    ada.createdBy = { id: "profile-ada", label: "Ada" };
    bob.createdBy = { id: "profile-bob", label: "Bob" };
    result.creators = [
      { id: "profile-ada", label: "Ada" },
      { id: "profile-bob", label: "Bob" },
    ];

    const unloadedSessionKey = "agent:main:beyond-loaded-page";
    const { sidebar } = await mountSidebar(gateway, harness.sessions);
    sidebar.sessionCatalogs = [
      {
        id: "claude",
        label: "Claude Code",
        capabilities: { continueSession: true, archive: false },
        hosts: [
          {
            hostId: "gateway:local",
            label: "Local Claude",
            kind: "gateway",
            connected: true,
            sessions: [
              {
                threadId: "unloaded-thread",
                name: "Unloaded backing session",
                status: "stored",
                archived: false,
                sessionKey: unloadedSessionKey,
                createdBy: { id: "profile-ada", label: "Ada" },
                canContinue: true,
                canArchive: false,
              },
            ],
          },
        ],
      },
    ];
    harness.publishList({ result, agentId: "main" });
    await sidebar.updateComplete;

    const select = sidebar.querySelector<HTMLSelectElement>(
      '.sidebar-session-creator-filter select[aria-label="Filter by creator"]',
    );
    select!.value = "profile-ada";
    select!.dispatchEvent(new Event("change", { bubbles: true }));
    await sidebar.updateComplete;

    expect(sidebar.querySelector(`[data-session-key="${unloadedSessionKey}"]`)).not.toBeNull();
  });
});
