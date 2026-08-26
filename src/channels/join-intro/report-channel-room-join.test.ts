import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  countPluginStateLiveEntries,
  resetPluginStateStoreForTests,
} from "../../plugin-state/plugin-state-store.js";
import { buildChannelJoinIntroPrompt } from "./join-intro-prompt.js";
import { reportChannelRoomJoin } from "./report-channel-room-join.js";

const { runCronIsolatedAgentTurn } = vi.hoisted(() => ({
  runCronIsolatedAgentTurn: vi.fn(),
}));

vi.mock("../../cron/isolated-agent.js", () => ({ runCronIsolatedAgentTurn }));

let stateDir: string;

function createJoinParams(conversationId: string, cfg: OpenClawConfig = {}) {
  return {
    cfg,
    channel: "slack",
    conversationId,
    deliverTo: `channel:${conversationId}`,
    roomAllowed: true,
    route: { agentId: "main", sessionKey: `agent:main:slack:channel:${conversationId}` },
    resolveRoomContext: vi.fn(async () => ({ title: "#deploys", purpose: "Release coordination" })),
  } satisfies Parameters<typeof reportChannelRoomJoin>[0];
}

beforeAll(async () => {
  resetPluginStateStoreForTests();
  stateDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-join-intro-")));
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
});

afterAll(async () => {
  resetPluginStateStoreForTests();
  vi.unstubAllEnvs();
  await fs.rm(stateDir, { recursive: true, force: true });
});

beforeEach(() => {
  runCronIsolatedAgentTurn.mockReset();
  runCronIsolatedAgentTurn.mockResolvedValue({ status: "ok", delivered: true });
});

describe("reportChannelRoomJoin", () => {
  it("honors channel disablement before resolving room context or starting an agent turn", async () => {
    const params = createJoinParams("disabled", {
      channels: { slack: { joinIntro: false } },
    });

    await expect(reportChannelRoomJoin(params)).resolves.toEqual({
      kind: "skipped",
      reason: "disabled",
    });
    expect(params.resolveRoomContext).not.toHaveBeenCalled();
    expect(runCronIsolatedAgentTurn).not.toHaveBeenCalled();
  });

  it("lets the account-specific enablement override its channel default", async () => {
    const params = {
      ...createJoinParams("account-enabled", {
        channels: {
          slack: { joinIntro: false, accounts: { WORK: { joinIntro: true } } },
        },
      }),
      accountId: "work",
    };

    await expect(reportChannelRoomJoin(params)).resolves.toEqual({ kind: "posted" });
    expect(runCronIsolatedAgentTurn).toHaveBeenCalledOnce();
    expect(runCronIsolatedAgentTurn.mock.calls[0]?.[0].job.delivery).toEqual({
      mode: "announce",
      channel: "slack",
      to: "channel:account-enabled",
      accountId: "work",
    });
  });

  it("rejects denied rooms before consulting room context or sender-independent delivery", async () => {
    const params = { ...createJoinParams("denied"), roomAllowed: false };

    await expect(reportChannelRoomJoin(params)).resolves.toEqual({
      kind: "skipped",
      reason: "room-not-allowed",
    });
    expect(params.resolveRoomContext).not.toHaveBeenCalled();
    expect(runCronIsolatedAgentTurn).not.toHaveBeenCalled();
  });

  it("persists a successful introduction and sends nothing when the same room join replays", async () => {
    const params = createJoinParams("replayed");
    const rowsBefore = countPluginStateLiveEntries("slack");

    await expect(reportChannelRoomJoin(params)).resolves.toEqual({ kind: "posted" });
    await expect(reportChannelRoomJoin(params)).resolves.toEqual({
      kind: "skipped",
      reason: "already-introduced",
    });

    expect(countPluginStateLiveEntries("slack")).toBe(rowsBefore + 1);
    expect(params.resolveRoomContext).toHaveBeenCalledExactlyOnceWith({ messageLimit: 30 });
    expect(runCronIsolatedAgentTurn).toHaveBeenCalledOnce();
  });

  it("scopes room dedupe to the owning account", async () => {
    const params = createJoinParams("shared-room");

    await expect(reportChannelRoomJoin({ ...params, accountId: "first" })).resolves.toEqual({
      kind: "posted",
    });
    await expect(reportChannelRoomJoin({ ...params, accountId: "second" })).resolves.toEqual({
      kind: "posted",
    });

    expect(runCronIsolatedAgentTurn).toHaveBeenCalledTimes(2);
  });

  it("reports an unavailable room snapshot and leaves its claim available for a later join", async () => {
    const params = {
      ...createJoinParams("missing-context"),
      resolveRoomContext: vi.fn(async () => null),
    };

    await expect(reportChannelRoomJoin(params)).resolves.toEqual({
      kind: "skipped",
      reason: "no-context",
    });
    await expect(
      reportChannelRoomJoin({
        ...params,
        resolveRoomContext: async () => ({ title: "#new-room" }),
      }),
    ).resolves.toEqual({ kind: "posted" });
    expect(runCronIsolatedAgentTurn).toHaveBeenCalledOnce();
  });

  it("fails a successful agent turn that did not visibly deliver, then permits a real retry", async () => {
    const params = createJoinParams("undelivered");
    runCronIsolatedAgentTurn
      .mockResolvedValueOnce({ status: "ok", delivered: false })
      .mockResolvedValueOnce({ status: "ok", delivered: true });

    await expect(reportChannelRoomJoin(params)).resolves.toEqual({
      kind: "failed",
      reason: "introduction was not delivered",
    });
    await expect(reportChannelRoomJoin(params)).resolves.toEqual({ kind: "posted" });
  });

  it("returns the isolated turn's explicit failure as a logged closed failure outcome", async () => {
    runCronIsolatedAgentTurn.mockResolvedValueOnce({
      status: "error",
      error: "provider unavailable",
    });

    await expect(reportChannelRoomJoin(createJoinParams("agent-failed"))).resolves.toEqual({
      kind: "failed",
      reason: "provider unavailable",
    });
  });

  it("runs one bounded isolated turn with explicit delivery and the requested conversation route", async () => {
    const params = { ...createJoinParams("isolated"), accountId: "work", threadId: "1717" };
    const message = buildChannelJoinIntroPrompt({
      context: { title: "#deploys", purpose: "Release coordination" },
    });

    await expect(reportChannelRoomJoin(params)).resolves.toEqual({ kind: "posted" });
    expect(runCronIsolatedAgentTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: params.cfg,
        message,
        sessionKey: params.route.sessionKey,
        agentId: "main",
        job: expect.objectContaining({
          sessionTarget: "isolated",
          wakeMode: "now",
          payload: expect.objectContaining({ kind: "agentTurn", message, timeoutSeconds: 60 }),
          delivery: {
            mode: "announce",
            channel: "slack",
            to: "channel:isolated",
            threadId: "1717",
            accountId: "work",
          },
        }),
      }),
    );
  });
});
