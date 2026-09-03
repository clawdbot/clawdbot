import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import type { TranscriptSourceProvider } from "../../transcripts/provider-types.js";
import { TranscriptsStore, transcriptSessionSelector } from "../../transcripts/store.js";
import { summarizeTranscripts } from "../../transcripts/summary.js";
import {
  createToolSearchCatalogRef,
  registerHeadlessToolSearchCatalog,
} from "../tool-search-catalog.js";
import { resolveToolSearchConfig } from "../tool-search-config.js";
import { ToolSearchRuntime } from "../tool-search-runtime.js";
import { activeSessions } from "./transcripts-tool-runtime.js";
import { createTranscriptsTool } from "./transcripts-tool.js";

const { getProvider } = vi.hoisted(() => ({ getProvider: vi.fn() }));
vi.mock("../../transcripts/provider-registry.js", () => ({
  getTranscriptSourceProvider: getProvider,
  listTranscriptSourceProviders: () => [],
}));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let stateDir: string;
let store: TranscriptsStore;
const session = {
  sessionId: "meeting",
  title: "Weekly review",
  startedAt: "2026-08-02T14:00:00.000Z",
  source: { providerId: "voice", guildId: "team" },
  metadata: { agentId: "capture-agent" },
};
function tool(channel = false) {
  return createTranscriptsTool({
    stateDir,
    agentId: "reader-agent",
    caller: channel
      ? { kind: "channel", channel: "discord", senderId: "reader", groupSpace: "team", roleIds: [] }
      : { kind: "operator", source: "local" },
  });
}
function run(params: Record<string, unknown>, channel = false) {
  return tool(channel).execute("read", params);
}
function readThroughCatalog(params: Record<string, unknown>) {
  const catalogRef = createToolSearchCatalogRef();
  registerHeadlessToolSearchCatalog({ catalogRef, tools: [tool()] });
  const runtime = new ToolSearchRuntime({ catalogRef }, resolveToolSearchConfig(), {
    validateInput: true,
  });
  return runtime.callValue("transcripts", params);
}

beforeEach(async () => {
  stateDir = tempDirs.make("transcripts-read-");
  store = new TranscriptsStore(path.join(stateDir, "transcripts"), {
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
  });
  getProvider.mockReset();
  await store.writeSession(session);
});
afterEach(() => {
  vi.restoreAllMocks();
  activeSessions.clear();
  closeOpenClawStateDatabaseForTest();
});

describe("transcripts read actions", () => {
  it.each([false, true])(
    "refuses notes rewritten after authorization (active: %s)",
    async (active) => {
      getProvider.mockReturnValue({
        id: "voice",
        accessControl: {
          channelId: "discord",
          authorize: async ({ source }: { source: { guildId?: string } }) =>
            source.guildId === "team" ? { ok: true } : { ok: false, error: "denied" },
        },
      });
      if (active) {
        activeSessions.set(session.sessionId, { session, providerId: "voice", phase: "active" });
      }
      await store.writeSummary(
        summarizeTranscripts({ session, utterances: [{ text: "Authorized notes" }] }),
        session,
      );
      const params = { action: "show", selector: transcriptSessionSelector(session) };
      expect((await run(params, true)).details).toMatchObject({
        text: expect.stringContaining("Authorized notes"),
      });

      const readSummary = store.readSummary.bind(store);
      vi.spyOn(TranscriptsStore.prototype, "readSummary").mockImplementationOnce(async (row) => {
        await store.writeSession({
          ...session,
          source: { providerId: "voice", guildId: "other" },
        });
        await store.writeSummary(
          summarizeTranscripts({ session, utterances: [{ text: "Other guild notes" }] }),
          session,
        );
        return readSummary(row);
      });
      const shown = await run(params, true);
      expect(shown.details).toMatchObject({ sessionId: "meeting", skipped: true });
      expect(JSON.stringify(shown)).not.toContain("Other guild notes");
    },
  );

  it("reads across agent ownership without widening mutation authority", async () => {
    await store.appendUtteranceForSession(session, {
      text: "Ship the design",
      speaker: { label: "Ada" },
    });
    await store.writeSummary(
      summarizeTranscripts({ session, utterances: [{ text: "Ship the design" }] }),
      session,
    );
    const listed = await run({ action: "list" });
    expect(listed.details).toMatchObject({
      sessions: [{ sessionId: "meeting", participants: ["Ada"], utteranceCount: 1 }],
    });
    expect(listed.details).not.toHaveProperty("sessions.0.overview");
    const shown = await run({ action: "show", selector: transcriptSessionSelector(session) });
    expect(shown.content).toEqual([
      { type: "text", text: expect.stringContaining("Ship the design") },
    ]);
    await expect(
      readThroughCatalog({ action: "show", selector: transcriptSessionSelector(session) }),
    ).resolves.toMatchObject({ text: expect.stringContaining("Ship the design") });
    await expect(
      run({ action: "stop", selector: transcriptSessionSelector(session) }),
    ).rejects.toThrow("not found");
  });

  it("passes read actions to provider policy and hides unauthorized meetings", async () => {
    const authorize = vi.fn<NonNullable<TranscriptSourceProvider["accessControl"]>["authorize"]>(
      async ({ source, caller }) =>
        caller.kind === "channel" && source.guildId === caller.groupSpace
          ? { ok: true, value: undefined }
          : { ok: false, error: "denied" },
    );
    getProvider.mockReturnValue({
      id: "voice",
      name: "Voice",
      accessControl: { channelId: "discord", authorize },
    });
    await store.writeSession({
      ...session,
      sessionId: "hidden",
      source: { providerId: "voice", guildId: "other" },
    });
    expect((await run({ action: "list", limit: 1 }, true)).details).toMatchObject({
      sessions: [{ sessionId: "meeting" }],
    });
    await run({ action: "show", selector: transcriptSessionSelector(session) }, true);
    expect(authorize.mock.calls.map(([arg]) => arg.action)).toContain("show");
    await expect(run({ action: "show", sessionId: "hidden" }, true)).rejects.toThrow("not found");
    getProvider.mockReturnValue({ id: "voice", name: "Uncontrolled provider" });
    expect((await run({ action: "list" }, true)).details).toEqual({ sessions: [] });
  });

  it("authorizes durable notes rather than a live capture's retained source", async () => {
    const authorize = vi.fn<NonNullable<TranscriptSourceProvider["accessControl"]>["authorize"]>(
      async ({ source }) =>
        source.guildId === "team" ? { ok: true, value: undefined } : { ok: false, error: "denied" },
    );
    getProvider.mockReturnValue({
      id: "voice",
      name: "Voice",
      accessControl: {
        channelId: "discord",
        authorize,
      },
    });
    activeSessions.set(session.sessionId, { session, providerId: "voice", phase: "active" });
    await store.writeSession({ ...session, source: { providerId: "voice", guildId: "other" } });
    await store.writeSummary(
      summarizeTranscripts({ session, utterances: [{ text: "Other guild notes" }] }),
      session,
    );
    await expect(
      run({ action: "show", selector: transcriptSessionSelector(session) }, true),
    ).rejects.toThrow("not found");
    expect(authorize).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: "show",
        source: { providerId: "voice", guildId: "other" },
      }),
    );
    authorize.mockResolvedValue({ ok: true, value: undefined });
    const shown = await run({ action: "show", sessionId: "meeting" }, true);
    expect(shown.content).toEqual([
      { type: "text", text: expect.stringContaining("Other guild notes") },
    ]);
    expect(authorize).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: "show",
        source: { providerId: "voice", guildId: "other" },
      }),
    );
  });

  it("bounds model-facing notes and reports active captures without summaries", async () => {
    activeSessions.set(session.sessionId, { session, providerId: "voice", phase: "active" });
    expect((await run({ action: "show", sessionId: "meeting" })).details).toMatchObject({
      active: true,
    });
    await expect(
      readThroughCatalog({ action: "show", sessionId: "meeting" }),
    ).resolves.toMatchObject({
      active: true,
      text: "No summary exists yet for this meeting. Capture is active.",
    });
    await store.writeSummary(
      { ...summarizeTranscripts({ session, utterances: [] }), overview: "x".repeat(20000) },
      session,
    );
    const shown = await run({ action: "show", sessionId: "meeting" });
    const text = shown.content[0];
    if (!text || text.type !== "text") {
      throw new Error("missing notes text");
    }
    expect(text.text.length).toBeLessThanOrEqual(12000);
    expect(text.text).toContain(
      `[truncated; run openclaw transcripts show ${transcriptSessionSelector(session)} for the full notes]`,
    );
    await expect(
      readThroughCatalog({ action: "show", sessionId: "meeting" }),
    ).resolves.toMatchObject({
      text: text.text,
    });
    for (let index = 0; index < 50; index++) {
      await store.writeSession({
        ...session,
        sessionId: `meeting-${index}`,
        title: "Long title ".repeat(40),
      });
    }
    const listed = await run({ action: "list", limit: 50 });
    expect(listed.details).toHaveProperty("sessions.length", 50);
    expect(JSON.stringify(listed.content).length).toBeLessThan(4200);
  });

  it.each([{}, { selector: "one", sessionId: "two" }])(
    "requires exactly one show selector %j",
    async (params) => {
      await expect(run({ action: "show", ...params })).rejects.toThrow("exactly one");
    },
  );
});
