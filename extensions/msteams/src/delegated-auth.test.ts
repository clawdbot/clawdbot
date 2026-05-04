import { describe, expect, it, vi } from "vitest";
import { createMSTeamsDelegatedAuthContext } from "./delegated-auth.js";
import type { MSTeamsTurnContext } from "./sdk-types.js";

function createContext(signin: NonNullable<MSTeamsTurnContext["signin"]>): MSTeamsTurnContext {
  return {
    activity: {
      type: "message",
      channelId: "msteams",
      from: { id: "29:user", aadObjectId: "aad-user" },
      conversation: { id: "conversation-1", tenantId: "tenant-1" },
    },
    signin,
    sendActivity: vi.fn(),
    sendActivities: vi.fn(),
    updateActivity: vi.fn(),
    deleteActivity: vi.fn(),
  };
}

describe("msteams delegated auth context", () => {
  it("resolves and caches the SDK-owned user token for the turn", async () => {
    const signin = vi.fn(async () => "delegated-token");
    const auth = createMSTeamsDelegatedAuthContext({
      context: createContext(signin),
      connectionName: "GraphConnection",
    });

    await expect(
      auth?.getDelegatedAccessToken({
        provider: "msteams",
        connectionName: "GraphConnection",
      }),
    ).resolves.toEqual({
      ok: true,
      token: "delegated-token",
      tenantId: "tenant-1",
      userId: "aad-user",
    });
    await auth?.getDelegatedAccessToken({ provider: "msteams" });

    expect(signin).toHaveBeenCalledTimes(1);
    expect(signin).toHaveBeenCalledWith({
      connectionName: "GraphConnection",
      oauthCardText:
        "Sign in to allow OpenClaw to use your Microsoft Teams delegated access for this tool.",
      signInButtonText: "Sign in",
    });
  });

  it("reports missing consent after the SDK sends its OAuth card", async () => {
    const signin = vi.fn(async () => undefined);
    const auth = createMSTeamsDelegatedAuthContext({
      context: createContext(signin),
      connectionName: "GraphConnection",
    });

    await expect(auth?.getDelegatedAccessToken({ provider: "msteams" })).resolves.toEqual({
      ok: false,
      reason: "missing_consent",
    });
    await auth?.getDelegatedAccessToken({ provider: "msteams" });

    expect(signin).toHaveBeenCalledTimes(1);
  });

  it("rejects other providers and OAuth connections without invoking the SDK", async () => {
    const signin = vi.fn(async () => "delegated-token");
    const auth = createMSTeamsDelegatedAuthContext({
      context: createContext(signin),
      connectionName: "GraphConnection",
    });

    await expect(auth?.getDelegatedAccessToken({ provider: "slack" })).resolves.toEqual({
      ok: false,
      reason: "not_configured",
    });
    await expect(
      auth?.getDelegatedAccessToken({
        provider: "msteams",
        connectionName: "OtherConnection",
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "not_configured",
    });
    expect(signin).not.toHaveBeenCalled();
  });

  it("maps SDK sign-in failures to unavailable", async () => {
    const onDebug = vi.fn();
    const auth = createMSTeamsDelegatedAuthContext({
      context: createContext(
        vi.fn(async () => {
          throw new Error("Bot Framework unavailable");
        }),
      ),
      connectionName: "GraphConnection",
      onDebug,
    });

    await expect(auth?.getDelegatedAccessToken({ provider: "msteams" })).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect(onDebug).toHaveBeenCalledWith("msteams delegated auth signin failed", {
      error: "Bot Framework unavailable",
    });
  });

  it("stays absent when SSO or the SDK sign-in seam is unavailable", () => {
    const context = createContext(vi.fn());

    expect(createMSTeamsDelegatedAuthContext({ context, connectionName: " " })).toBeUndefined();
    expect(
      createMSTeamsDelegatedAuthContext({
        context: { ...context, signin: undefined },
        connectionName: "GraphConnection",
      }),
    ).toBeUndefined();
  });
});
