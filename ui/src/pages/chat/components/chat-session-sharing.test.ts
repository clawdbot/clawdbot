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
});
