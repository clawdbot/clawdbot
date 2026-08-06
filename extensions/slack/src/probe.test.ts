// Slack tests cover probe plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { probeSlack } from "./probe.js";

const authTestMock = vi.hoisted(() => vi.fn());
const createSlackReadClientMock = vi.hoisted(() => vi.fn());

vi.mock("./client.js", () => ({
  createSlackReadClient: createSlackReadClientMock,
}));

describe("probeSlack", () => {
  beforeEach(() => {
    authTestMock.mockReset();
    createSlackReadClientMock.mockReset();

    createSlackReadClientMock.mockReturnValue({
      auth: {
        test: authTestMock,
      },
    });
  });

  it("maps Slack auth metadata on success", async () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(100).mockReturnValueOnce(145);
    authTestMock.mockResolvedValue({
      ok: true,
      user_id: "U123",
      bot_id: "B123",
      user: "openclaw-bot",
      team_id: "T123",
      team: "OpenClaw",
    });

    await expect(probeSlack("xoxb-test", 2500)).resolves.toEqual({
      ok: true,
      status: 200,
      elapsedMs: 45,
      bot: { id: "U123", name: "openclaw-bot" },
      team: { id: "T123", name: "OpenClaw" },
    });
    expect(createSlackReadClientMock).toHaveBeenCalledWith("xoxb-test", {
      rejectRateLimitedCalls: true,
      retryConfig: { retries: 0 },
      timeout: 2500,
    });
  });

  it("warns when auth.test looks like a user token in the bot token slot", async () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(100).mockReturnValueOnce(145);
    authTestMock.mockResolvedValue({
      ok: true,
      user_id: "UUSER",
      user: "human-installer",
      team_id: "T123",
      team: "OpenClaw",
    });

    await expect(probeSlack("xoxp-user-token", 2500, { accountId: "work" })).resolves.toMatchObject(
      {
        ok: true,
        warning:
          'Slack auth.test identified account "work" as user UUSER without bot_id. channels.slack.accounts.work.botToken appears to contain a user token; replace it with a Bot User OAuth Token. Until replaced, explicit bot-mention detection is disabled and required-mention channels fail closed.',
      },
    );
  });

  it("maps a human auth.test identity for user identity", async () => {
    authTestMock.mockResolvedValue({
      ok: true,
      user_id: "UUSER",
      user: "test-human",
      team_id: "T123",
      team: "OpenClaw",
    });

    await expect(probeSlack("test-user-token", 2500, { identity: "user" })).resolves.toMatchObject({
      ok: true,
      user: { id: "UUSER", name: "test-human" },
      team: { id: "T123", name: "OpenClaw" },
    });
  });

  it("rejects a bot token in the user identity slot", async () => {
    authTestMock.mockResolvedValue({
      ok: true,
      user_id: "UBOT",
      bot_id: "BBOT",
      user: "test-bot",
    });

    await expect(probeSlack("test-user-token", 2500, { identity: "user" })).resolves.toMatchObject({
      ok: false,
      error: "Slack auth.test identified a bot token; user identity requires a user OAuth token",
    });
  });

  it("rejects user identity auth.test responses without a human user_id", async () => {
    authTestMock.mockResolvedValue({ ok: true, user: "test-human" });

    await expect(probeSlack("test-user-token", 2500, { identity: "user" })).resolves.toMatchObject({
      ok: false,
      error: "Slack auth.test returned no human user_id for user identity",
    });
  });

  it("keeps optional auth metadata fields undefined when Slack omits them", async () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(200).mockReturnValueOnce(235);
    authTestMock.mockResolvedValue({ ok: true });

    const result = await probeSlack("xoxb-test");

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.elapsedMs).toBe(35);
    expect(result.bot).toStrictEqual({ id: undefined, name: undefined });
    expect(result.team).toStrictEqual({ id: undefined, name: undefined });
    expect(createSlackReadClientMock).toHaveBeenCalledWith("xoxb-test", {
      rejectRateLimitedCalls: true,
      retryConfig: { retries: 0 },
      timeout: 2500,
    });
  });

  it("passes a custom probe deadline to Slack's abortable read transport", async () => {
    authTestMock.mockResolvedValue({ ok: true });

    await expect(probeSlack("xoxb-test", 175)).resolves.toMatchObject({ ok: true });

    expect(createSlackReadClientMock).toHaveBeenCalledWith("xoxb-test", {
      rejectRateLimitedCalls: true,
      retryConfig: { retries: 0 },
      timeout: 175,
    });
  });

  it("keeps the normal health result when the Slack read transport aborts", async () => {
    authTestMock.mockRejectedValue(
      Object.assign(new Error("The operation was aborted due to timeout"), {
        name: "TimeoutError",
      }),
    );

    await expect(probeSlack("xoxb-test", 175)).resolves.toMatchObject({
      ok: false,
      status: null,
      error: expect.any(String),
    });
  });
});
