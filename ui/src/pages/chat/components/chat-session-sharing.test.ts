import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderChatSessionSharing } from "./chat-session-sharing.ts";

let container: HTMLDivElement | undefined;

afterEach(() => {
  container?.remove();
  container = undefined;
});

function mount(template: ReturnType<typeof renderChatSessionSharing>) {
  container = document.createElement("div");
  document.body.append(container);
  render(template, container);
  return container;
}

describe("chat session sharing menu", () => {
  it("shows the owner picker with policy-gated modes and known identities", () => {
    const onVisibilityChange = vi.fn();
    const onMemberChange = vi.fn();
    const navigate = vi.fn();
    const root = mount(
      renderChatSessionSharing({
        session: {
          key: "agent:main:main",
          kind: "direct",
          updatedAt: 1,
          visibility: "read-only",
          sharingRole: "owner",
        },
        state: {
          loading: false,
          result: {
            sessionKey: "agent:main:main",
            owner: {
              type: "human",
              id: "owner",
              identity: { type: "profile", id: "owner" },
              label: "Owner",
            },
            members: [],
            identities: [
              { type: "human", id: "owner", label: "Owner" },
              { type: "human", id: "alice", label: "Alice" },
            ],
            role: "owner",
            allowedVisibilities: ["shared", "read-only"],
          },
        },
        ownerViewing: false,
        personActivity: { basePath: "", navigate },
        onOpen: vi.fn(),
        onVisibilityChange,
        onMemberChange,
      }),
    );
    const dropdown = root.querySelector("wa-dropdown");
    expect(dropdown).not.toBeNull();
    expect(root.textContent).toContain("Shared");
    expect(root.textContent).toContain("Read-only");
    expect(root.textContent).not.toContain("Suggest");
    expect(root.textContent).toContain("Alice");
    expect(root.querySelector('wa-dropdown-item[value="member:owner"]')).toBeNull();
    expect(root.querySelector(".chat-pane__sharing-owner-title")?.textContent?.trim()).toBe(
      "Owner",
    );
    expect(root.querySelector(".chat-pane__sharing-owner")?.textContent?.trim()).toBe("Owner");
    expect(
      root.querySelector(".chat-pane__sharing-owner openclaw-session-owner-chip"),
    ).not.toBeNull();
    const ownerLink = root.querySelector<HTMLAnchorElement>(
      ".chat-pane__sharing-owner a.person-activity-link",
    );
    expect(ownerLink?.getAttribute("href")).toBe("/activity/owner");
    expect(root.querySelector(".session-menu__separator")).toBeNull();

    ownerLink?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(navigate).toHaveBeenCalledWith("owner", "Owner");

    dropdown?.dispatchEvent(
      new CustomEvent("wa-select", {
        detail: { item: { value: "visibility:shared" } },
      }),
    );
    dropdown?.dispatchEvent(
      new CustomEvent("wa-select", {
        detail: { item: { value: "member:alice" } },
      }),
    );
    expect(onVisibilityChange).toHaveBeenCalledWith("shared");
    expect(onMemberChange).toHaveBeenCalledWith("alice", true);
  });

  it("renders standard radio options with visibility icons and one selected checkmark", () => {
    const root = mount(
      renderChatSessionSharing({
        session: {
          key: "agent:main:main",
          kind: "direct",
          updatedAt: 1,
          visibility: "read-only",
          sharingRole: "owner",
        },
        state: {
          loading: false,
          result: {
            sessionKey: "agent:main:main",
            members: [],
            identities: [],
            role: "owner",
            allowedVisibilities: ["shared", "read-only", "suggest", "draft"],
          },
        },
        onOpen: vi.fn(),
        onVisibilityChange: vi.fn(),
        onMemberChange: vi.fn(),
      }),
    );

    const items = [...root.querySelectorAll<HTMLElement>(".chat-pane__sharing-visibility-item")];
    expect(items).toHaveLength(4);
    expect(items.every((item) => item.querySelector('[slot="icon"]') !== null)).toBe(true);
    const draftIcon = root.querySelector('[value="visibility:draft"] [slot="icon"]');
    expect(draftIcon?.querySelector("svg")).not.toBeNull();
    expect(draftIcon?.textContent?.trim()).toBe("");
    expect(items.map((item) => item.getAttribute("role"))).toEqual(
      items.map(() => "menuitemradio"),
    );
    expect(items.map((item) => item.getAttribute("aria-checked"))).toEqual([
      "false",
      "true",
      "false",
      "false",
    ]);
    const selected = root.querySelector<HTMLElement>(
      'wa-dropdown-item[value="visibility:read-only"]',
    );
    expect(selected?.hasAttribute("disabled")).toBe(false);
    expect(selected?.querySelector(".session-menu__check svg")).not.toBeNull();
    expect(
      root.querySelectorAll(".chat-pane__sharing-visibility-item .session-menu__check"),
    ).toHaveLength(1);
  });

  it("renders member presentation from identity.type, not from ID spelling", () => {
    const root = mount(
      renderChatSessionSharing({
        session: {
          key: "agent:main:main",
          kind: "direct",
          updatedAt: 1,
          visibility: "shared",
          sharingRole: "owner",
        },
        state: {
          loading: false,
          result: {
            sessionKey: "agent:main:main",
            members: [],
            identities: [
              { type: "human", id: "profile-vyctor", label: "Vyctor Brzezowski" },
              // Human identity IDs are opaque (e.g. an inbound SenderId) and
              // can contain "channel:" as a substring; the recorded type,
              // not the ID string, must drive presentation.
              { type: "human", id: "channel:chn_design", label: "Design" },
              { type: "agent", id: "discord:channel:operations", label: "Operations" },
              { type: "system", id: "channel:audit", label: "Audit" },
            ],
            role: "owner",
            allowedVisibilities: ["shared"],
          },
        },
        onOpen: vi.fn(),
        onVisibilityChange: vi.fn(),
        onMemberChange: vi.fn(),
      }),
    );

    const humans = [
      root.querySelector('wa-dropdown-item[value="member:profile-vyctor"]'),
      root.querySelector('wa-dropdown-item[value="member:channel:chn_design"]'),
    ];
    const nonHumans = [
      root.querySelector('wa-dropdown-item[value="member:discord:channel:operations"]'),
      root.querySelector('wa-dropdown-item[value="member:channel:audit"]'),
    ];

    for (const human of humans) {
      expect(human?.querySelector("openclaw-session-owner-chip")).not.toBeNull();
    }
    for (const nonHuman of nonHumans) {
      expect(nonHuman?.querySelector("openclaw-session-owner-chip")).toBeNull();
      expect(nonHuman?.querySelector(".chat-pane__sharing-member-icon svg")).not.toBeNull();
    }
  });

  it("shows shape-matched member skeletons while identities load", () => {
    const root = mount(
      renderChatSessionSharing({
        session: {
          key: "agent:main:main",
          kind: "direct",
          updatedAt: 1,
          visibility: "shared",
          sharingRole: "owner",
        },
        state: { loading: true },
        allowedVisibilities: ["shared", "read-only"],
        onOpen: vi.fn(),
        onVisibilityChange: vi.fn(),
        onMemberChange: vi.fn(),
      }),
    );

    const loading = root.querySelector(".chat-pane__sharing-members-loading");
    expect(loading?.getAttribute("role")).toBe("status");
    expect(loading?.getAttribute("aria-busy")).toBe("true");
    expect(loading?.textContent?.trim()).toBe("");
    expect(root.querySelectorAll(".chat-pane__sharing-member-skeleton")).toHaveLength(3);
    expect(root.querySelectorAll(".chat-pane__sharing-member-skeleton .skeleton")).toHaveLength(6);
  });

  it("keeps the linked owner beside the draft marker for a non-manager", () => {
    const root = mount(
      renderChatSessionSharing({
        session: {
          key: "agent:main:main",
          kind: "direct",
          updatedAt: 1,
          visibility: "draft",
          sharingRole: "member",
          owner: {
            actor: {
              type: "human",
              id: "owner",
              identity: { type: "profile", id: "owner" },
              label: "Owner",
            },
          },
        },
        state: undefined,
        ownerViewing: false,
        personActivity: { basePath: "", navigate: vi.fn() },
        showOwner: true,
        onOpen: vi.fn(),
        onVisibilityChange: vi.fn(),
        onMemberChange: vi.fn(),
      }),
    );
    expect(root.querySelector("wa-dropdown")).toBeNull();
    const indicator = root.querySelector(".chat-pane__draft-indicator");
    expect(indicator?.querySelector("svg")).not.toBeNull();
    expect(indicator?.textContent?.trim()).toBe("");
    expect(
      root
        .querySelector("a.person-activity-avatar-link:has(openclaw-session-owner-chip)")
        ?.getAttribute("href"),
    ).toBe("/activity/owner");
  });

  it("publishes a manageable draft through the shared visibility callback", () => {
    const onVisibilityChange = vi.fn();
    const root = mount(
      renderChatSessionSharing({
        session: {
          key: "agent:main:draft",
          kind: "direct",
          updatedAt: 1,
          visibility: "draft",
          sharingRole: "owner",
        },
        state: {
          loading: false,
          result: {
            sessionKey: "agent:main:draft",
            members: [],
            identities: [],
            role: "owner",
            allowedVisibilities: ["shared", "draft"],
          },
        },
        onOpen: vi.fn(),
        onVisibilityChange,
        onMemberChange: vi.fn(),
      }),
    );

    const publish = root.querySelector<HTMLElement>(".chat-pane__publish-draft");
    expect(publish?.textContent).toContain("Publish draft");
    root.querySelector("wa-dropdown")?.dispatchEvent(
      new CustomEvent("wa-select", {
        detail: { item: { value: publish?.getAttribute("value") } },
      }),
    );
    expect(onVisibilityChange).toHaveBeenCalledWith("shared");
    expect(root.querySelectorAll('wa-dropdown-item[value="visibility:shared"]')).toHaveLength(1);
  });

  it("keeps read-only owner controls visible but refuses disabled synthetic actions", () => {
    const onOpen = vi.fn();
    const onVisibilityChange = vi.fn();
    const onMemberChange = vi.fn();
    const root = mount(
      renderChatSessionSharing({
        session: {
          key: "agent:main:main",
          kind: "direct",
          updatedAt: 1,
          visibility: "shared",
          sharingRole: "owner",
        },
        state: {
          loading: false,
          result: {
            sessionKey: "agent:main:main",
            members: [{ identityId: "alice", addedBy: "owner", addedAt: 1 }],
            identities: [
              {
                type: "human",
                id: "alice",
                label: "Alice with a very long selected member display name",
              },
              {
                type: "human",
                id: "bob",
                label: "Bob with a very long available member display name",
              },
            ],
            role: "owner",
            allowedVisibilities: ["shared", "read-only"],
          },
        },
        visibilityDisabledReason: "Requires write",
        memberAddDisabledReason: "Requires write",
        memberRemoveDisabledReason: "Requires write",
        onOpen,
        onVisibilityChange,
        onMemberChange,
      }),
    );
    const dropdown = root.querySelector("wa-dropdown");
    expect(dropdown).not.toBeNull();
    expect(
      root.querySelector<HTMLElement>('wa-dropdown-item[value="visibility:read-only"]')?.title,
    ).toBe("Requires write");
    expect(
      root.querySelector('wa-dropdown-item[value="member:alice"]')?.hasAttribute("disabled"),
    ).toBe(true);
    expect(
      root.querySelector('wa-dropdown-item[value="member:bob"]')?.hasAttribute("disabled"),
    ).toBe(true);
    for (const identityId of ["alice", "bob"]) {
      const item = root.querySelector<HTMLElement>(
        `wa-dropdown-item[value="member:${identityId}"]`,
      );
      expect(item?.title).toBe("Requires write");
      expect(item?.querySelector(".chat-pane__sharing-member-label")?.hasAttribute("title")).toBe(
        false,
      );
    }

    dropdown?.dispatchEvent(new CustomEvent("wa-show"));
    dropdown?.dispatchEvent(
      new CustomEvent("wa-select", {
        detail: { item: { value: "visibility:read-only" } },
      }),
    );
    dropdown?.dispatchEvent(
      new CustomEvent("wa-select", {
        detail: { item: { value: "member:alice" } },
      }),
    );
    dropdown?.dispatchEvent(
      new CustomEvent("wa-select", {
        detail: { item: { value: "member:bob" } },
      }),
    );

    expect(onOpen).toHaveBeenCalledOnce();
    expect(onVisibilityChange).not.toHaveBeenCalled();
    expect(onMemberChange).not.toHaveBeenCalled();
  });

  it("disables opening when sharing reads are unavailable", () => {
    const onOpen = vi.fn();
    const root = mount(
      renderChatSessionSharing({
        session: {
          key: "agent:main:main",
          kind: "direct",
          updatedAt: 1,
          visibility: "shared",
          sharingRole: "owner",
        },
        state: undefined,
        openDisabledReason: "Connect to the Gateway",
        onOpen,
        onVisibilityChange: vi.fn(),
        onMemberChange: vi.fn(),
      }),
    );

    expect(root.querySelector<HTMLButtonElement>(".chat-pane__sharing-trigger")?.disabled).toBe(
      true,
    );
    root.querySelector("wa-dropdown")?.dispatchEvent(new CustomEvent("wa-show"));
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("keeps visibility controls usable without member-list support", () => {
    const onOpen = vi.fn();
    const onVisibilityChange = vi.fn();
    const root = mount(
      renderChatSessionSharing({
        session: {
          key: "agent:main:main",
          kind: "direct",
          updatedAt: 1,
          visibility: "shared",
          sharingRole: "owner",
        },
        state: undefined,
        allowedVisibilities: ["shared", "read-only"],
        membersAvailable: false,
        onOpen,
        onVisibilityChange,
        onMemberChange: vi.fn(),
      }),
    );

    expect(root.querySelector<HTMLButtonElement>(".chat-pane__sharing-trigger")?.disabled).toBe(
      false,
    );
    expect(root.querySelector('wa-dropdown-item[value="visibility:read-only"]')).not.toBeNull();
    expect(root.textContent).not.toContain("People");

    const dropdown = root.querySelector("wa-dropdown");
    dropdown?.dispatchEvent(new CustomEvent("wa-show"));
    dropdown?.dispatchEvent(
      new CustomEvent("wa-select", {
        detail: { item: { value: "visibility:read-only" } },
      }),
    );

    expect(onOpen).toHaveBeenCalledOnce();
    expect(onVisibilityChange).toHaveBeenCalledWith("read-only");
  });

  it.each([
    { name: "visibility-only", membersAvailable: false },
    { name: "member-enabled", membersAvailable: true },
  ])("shows rejected sharing changes for $name Gateways", ({ membersAvailable }) => {
    const root = mount(
      renderChatSessionSharing({
        session: {
          key: "agent:main:main",
          kind: "direct",
          updatedAt: 1,
          visibility: "shared",
          sharingRole: "owner",
        },
        state: { loading: false, error: "Visibility update rejected" },
        allowedVisibilities: ["shared", "read-only"],
        membersAvailable,
        onOpen: vi.fn(),
        onVisibilityChange: vi.fn(),
        onMemberChange: vi.fn(),
      }),
    );

    const error = root.querySelector(".chat-pane__sharing-status--error");
    expect(error?.textContent).toContain("Visibility update rejected");
    expect(error?.getAttribute("role")).toBe("alert");
    expect(root.querySelectorAll(".chat-pane__sharing-title")).toHaveLength(
      membersAvailable ? 2 : 1,
    );
  });
});
