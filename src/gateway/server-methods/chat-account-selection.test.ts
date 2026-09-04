import { describe, expect, it, vi } from "vitest";

const profileDisplay = vi.hoisted(() => ({ displayName: "" }));

vi.mock("../../state/user-model-accounts.js", () => ({
  readUserModelAccountSummary: () => undefined,
}));

vi.mock("../../state/user-profiles.js", () => ({
  getUserProfileDisplay: () => ({ displayName: profileDisplay.displayName }),
  resolveUserProfileId: (profileId: string) => profileId,
}));

const { resolveChatAccountSelection } = await import("./chat-account-selection.js");

describe("resolveChatAccountSelection", () => {
  it("keeps shared credential labels valid at the UTF-16 limit", () => {
    const prefix = "x".repeat(255);
    const selection = resolveChatAccountSelection({
      authStore: {
        version: 1,
        profiles: {
          shared: {
            type: "token",
            provider: "example",
            token: "fixture-token",
            displayName: `${prefix}🤖`,
          },
        },
      },
      sessionEntry: { authProfileOverride: "shared" },
    });

    expect(selection.label).toBe(prefix);
  });

  it("keeps personal owner labels valid at the UTF-16 limit", () => {
    const prefix = "x".repeat(255);
    profileDisplay.displayName = `${prefix}🤖`;
    const selection = resolveChatAccountSelection({
      authStore: { version: 1, profiles: {} },
      sessionEntry: {
        authProfileOverride:
          "personal:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222",
      },
    });

    expect(selection.label).toBe(prefix);
  });

  it("repairs a historically malformed personal owner label", () => {
    const prefix = "x".repeat(255);
    profileDisplay.displayName = `${prefix}\ud83e`;
    const selection = resolveChatAccountSelection({
      authStore: { version: 1, profiles: {} },
      sessionEntry: {
        authProfileOverride:
          "personal:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222",
      },
    });

    expect(selection.label).toBe(`${prefix}\ufffd`);
  });
});
