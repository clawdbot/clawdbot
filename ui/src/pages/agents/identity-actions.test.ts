import { describe, expect, it, vi } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
import { resetIdentityDraft, saveIdentityDraft, selectIdentityAvatar } from "./identity-actions.ts";

const mocks = vi.hoisted(() => ({ fileToAvatarDataUrl: vi.fn() }));
vi.mock("./avatar-image.ts", () => ({ fileToAvatarDataUrl: mocks.fileToAvatarDataUrl }));

function host(): Parameters<typeof resetIdentityDraft>[0] {
  return {
    identityDraft: { name: null, emoji: null, avatar: null },
    identitySaving: false,
    identityError: null,
  };
}

describe("agent identity actions", () => {
  it("keeps unsupported blank edits visible without sending an update", async () => {
    const state = host();
    state.identityDraft.name = "  ";
    const request = vi.fn();

    await saveIdentityDraft({
      host: state,
      client: { request } as never,
      agentId: "main",
      agents: {} as ApplicationContext["agents"],
      agentIdentity: {} as ApplicationContext["agentIdentity"],
      isCurrent: () => true,
      onSaved: vi.fn(),
    });

    expect(request).not.toHaveBeenCalled();
    expect(state.identityDraft.name).toBe("  ");
  });

  it("drops an avatar decode that completes after the selected agent resets", async () => {
    let resolveAvatar!: (value: string | null) => void;
    mocks.fileToAvatarDataUrl.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveAvatar = resolve;
      }),
    );
    const state = host();

    selectIdentityAvatar(state, {} as File);
    resetIdentityDraft(state);
    resolveAvatar("data:image/png;base64,stale");
    await Promise.resolve();

    expect(state.identityDraft.avatar).toBeNull();
  });
});
