import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveSlackEnterpriseUserTeamId } from "./enterprise-user-route.js";
import { registerSlackInstallationState } from "./installation-identity-state.js";

const { createClient, usersInfo, teamsList } = vi.hoisted(() => ({
  createClient: vi.fn(),
  usersInfo: vi.fn(),
  teamsList: vi.fn(),
}));

vi.mock("./client.js", () => ({ createSlackLookupClient: createClient }));

const cfg: OpenClawConfig = {
  channels: { slack: { botToken: "sending-fixture", userToken: "read-only-fixture" } },
};
const userId = "U12345678";
let installation: ReturnType<typeof registerSlackInstallationState> | undefined;

beforeEach(() => {
  createClient.mockReset().mockReturnValue({
    users: { info: usersInfo },
    auth: { teams: { list: teamsList } },
  });
  usersInfo.mockReset().mockResolvedValue({
    ok: true,
    user: { id: userId, enterprise_user: { teams: ["T22222222", "T11111111"] } },
  });
  teamsList.mockReset().mockResolvedValue({
    ok: true,
    teams: [{ id: "T22222222" }, { id: "T11111111" }],
  });
});

afterEach(() => {
  installation?.release();
  installation = undefined;
});

describe("resolveSlackEnterpriseUserTeamId", () => {
  it.each(["workspace", "degraded", undefined] as const)(
    "does not discover workspaces for %s installation identity",
    async (kind) => {
      if (kind) {
        installation = registerSlackInstallationState("default", kind);
      }
      expect(await resolveSlackEnterpriseUserTeamId({ cfg, userId })).toBeUndefined();
      expect(createClient).not.toHaveBeenCalled();
    },
  );

  it("selects one stable shared workspace using the sending credential across all pages", async () => {
    installation = registerSlackInstallationState("default", "enterprise");
    teamsList
      .mockResolvedValueOnce({
        ok: true,
        teams: [{ id: "T33333333" }, { id: "T22222222" }],
        response_metadata: { next_cursor: "second-page" },
      })
      .mockResolvedValueOnce({ ok: true, teams: [{ id: "T11111111" }] });

    expect(await resolveSlackEnterpriseUserTeamId({ cfg, userId })).toBe("T11111111");
    expect(createClient).toHaveBeenCalledExactlyOnceWith("sending-fixture");
    expect(usersInfo).toHaveBeenCalledExactlyOnceWith({ user: userId });
    expect(teamsList.mock.calls).toEqual([
      [{ limit: 1000, cursor: undefined }],
      [{ limit: 1000, cursor: "second-page" }],
    ]);
  });

  it("accepts the recipient's Enterprise user identity", async () => {
    installation = registerSlackInstallationState("default", "enterprise");
    usersInfo.mockResolvedValue({
      ok: true,
      user: {
        id: "U87654321",
        enterprise_user: { id: userId, teams: ["T22222222"] },
      },
    });
    expect(await resolveSlackEnterpriseUserTeamId({ cfg, userId })).toBe("T22222222");
  });

  it.each([{ id: userId, enterprise_user: { teams: ["T44444444"] } }, { id: userId }])(
    "rejects recipients without verified shared membership: %j",
    async (user) => {
      installation = registerSlackInstallationState("default", "enterprise");
      usersInfo.mockResolvedValue({ ok: true, user });
      await expect(resolveSlackEnterpriseUserTeamId({ cfg, userId })).rejects.toThrow(
        "recipient shares no verified installed workspace",
      );
    },
  );

  it.each([
    { ok: false },
    { ok: true, user: { id: "U87654321", enterprise_user: { teams: ["T11111111"] } } },
    { ok: true, user: { id: userId, deleted: true } },
  ])("rejects unverified recipients before listing workspaces: %j", async (response) => {
    installation = registerSlackInstallationState("default", "enterprise");
    usersInfo.mockResolvedValue(response);
    await expect(resolveSlackEnterpriseUserTeamId({ cfg, userId })).rejects.toThrow(
      "could not verify Slack recipient",
    );
    expect(teamsList).not.toHaveBeenCalled();
  });

  it("propagates lookup failure without choosing an unverified workspace or retrying", async () => {
    installation = registerSlackInstallationState("default", "enterprise");
    teamsList.mockRejectedValue(new Error("ratelimited"));
    await expect(resolveSlackEnterpriseUserTeamId({ cfg, userId })).rejects.toThrow("ratelimited");
    expect(teamsList).toHaveBeenCalledOnce();
  });
});
