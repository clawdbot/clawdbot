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
            owner: { type: "human", id: "owner", label: "Owner" },
            members: [],
            identities: [
              { type: "human", id: "owner", label: "Owner" },
              { type: "human", id: "alice", label: "Alice" },
            ],
            role: "owner",
            allowedVisibilities: ["shared", "read-only"],
          },
        },
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
    expect(root.querySelector(".session-menu__separator")).toBeNull();

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

  it("distinguishes people from channel-backed members", () => {
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
              { type: "human", id: "channel:chn_design", label: "Design" },
              { type: "human", id: "discord:channel:operations", label: "Operations" },
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

    const human = root.querySelector('wa-dropdown-item[value="member:profile-vyctor"]');
    const channels = [
      root.querySelector('wa-dropdown-item[value="member:channel:chn_design"]'),
      root.querySelector('wa-dropdown-item[value="member:discord:channel:operations"]'),
    ];

    expect(human?.querySelector("openclaw-session-owner-chip")).not.toBeNull();
    for (const channel of channels) {
      expect(channel?.querySelector("openclaw-session-owner-chip")).toBeNull();
      expect(channel?.querySelector(".chat-pane__sharing-channel-icon svg")).not.toBeNull();
    }
  });

  it("shows only the draft marker to a non-manager", () => {
    const root = mount(
      renderChatSessionSharing({
        session: {
          key: "agent:main:main",
          kind: "direct",
          updatedAt: 1,
          visibility: "draft",
          sharingRole: "member",
        },
        state: undefined,
        onOpen: vi.fn(),
        onVisibilityChange: vi.fn(),
        onMemberChange: vi.fn(),
      }),
    );
    expect(root.querySelector("wa-dropdown")).toBeNull();
    expect(root.querySelector(".chat-pane__draft-indicator")?.textContent).toContain("👻");
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

    expect(root.querySelector(".chat-pane__sharing-status--error")?.textContent).toContain(
      "Visibility update rejected",
    );
    expect(root.querySelectorAll(".chat-pane__sharing-title")).toHaveLength(
      membersAvailable ? 2 : 1,
    );
  });
});
