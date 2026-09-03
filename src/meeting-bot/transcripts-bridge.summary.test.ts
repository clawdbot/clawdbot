import { afterEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createTranscriptsStore } from "../transcripts/store.js";
import type { MeetingSessionRecord } from "./session-types.js";
import { createMeetingDurableTranscriptBridge } from "./transcripts-bridge.runtime.js";

const { runIsolatedCompletion, resolveSimpleCompletionSelectionForAgent } = vi.hoisted(() => ({
  runIsolatedCompletion:
    vi.fn<typeof import("../transcripts/summary-model.runtime.js").runIsolatedCompletion>(),
  resolveSimpleCompletionSelectionForAgent:
    vi.fn<
      typeof import("../transcripts/summary-model.runtime.js").resolveSimpleCompletionSelectionForAgent
    >(),
}));
vi.mock("../transcripts/summary-model.runtime.js", () => ({
  runIsolatedCompletion,
  resolveSimpleCompletionSelectionForAgent,
}));
const tempDirs = createTempDirTracker();
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  tempDirs.cleanup();
  vi.clearAllMocks();
});

const session: MeetingSessionRecord = {
  id: "meeting-summary",
  url: "https://meeting.example/research",
  transport: "chrome",
  mode: "agent",
  agentId: "research",
  state: "active",
  createdAt: "2026-09-02T10:00:00.000Z",
  updatedAt: "2026-09-02T10:00:00.000Z",
  participantIdentity: "OpenClaw browser guest",
  realtime: { enabled: false, toolPolicy: "none" },
  notes: [],
};
const modelNotes = {
  overview: "The team will publish meeting notes.",
  decisions: ["Publish the notes"],
  actionItems: ["Blake: send the announcement"],
  risks: [],
};

describe("meeting transcript summary persistence", () => {
  it.each(["model", "no-model", "failure"] as const)(
    "saves canonical meeting notes with %s inference",
    async (mode) => {
      const stateDir = tempDirs.make("meeting-summary-");
      const cfg: OpenClawConfig =
        mode === "no-model"
          ? { agents: { defaults: { utilityModel: "" } } }
          : {
              agents: {
                defaults: {
                  model: "openai/gpt-5.6-sol",
                  utilityModel: "openai/gpt-5.6-sol",
                },
                list: [
                  {
                    id: "research",
                    model: "openai/gpt-5.6-sol",
                    utilityModel: "openai/gpt-5.6-luna",
                  },
                ],
              },
            };
      resolveSimpleCompletionSelectionForAgent.mockReset().mockImplementation(({ modelRef }) => {
        if (!modelRef) {
          throw new Error("expected configured model reference");
        }
        return {
          provider: "openai",
          modelId: modelRef.slice("openai/".length),
          agentDir: stateDir,
        };
      });
      runIsolatedCompletion.mockReset().mockImplementation(async ({ provider, model }) => ({
        text: JSON.stringify(modelNotes),
        provider,
        model,
        owner: { kind: "harness", id: "meeting-summary-fixture" },
      }));
      if (mode === "failure") {
        runIsolatedCompletion.mockRejectedValue(new Error("inference unavailable"));
      }
      const bridge = createMeetingDurableTranscriptBridge({
        logger: { warn: vi.fn() },
        options: { cfg, providerId: "meeting", providerName: "Meeting", stateDir },
      });
      const store = createTranscriptsStore(stateDir);
      try {
        await bridge.start(session, async () => {});
        await bridge.ingest(session, [{ speaker: "Avery", text: "We agreed to ship the notes." }]);
        await expect(
          bridge.stop(session, async () => {
            await bridge.ingest(session, [
              { speaker: "Blake", text: "I will send the announcement." },
            ]);
          }),
        ).resolves.toBe(true);
        closeOpenClawStateDatabaseForTest();
        const stored = await store.readSession(session.id);
        if (!stored) {
          throw new Error("expected durable meeting session");
        }
        expect(stored).toMatchObject({
          metadata: { agentId: "research" },
          stoppedAt: expect.any(String),
        });
        const notes = await store.readSummary(stored);
        expect(notes.summary).toMatchObject({
          sessionId: session.id,
          participants: ["Avery", "Blake"],
          utteranceCount: 2,
          transcript: [
            "Avery: We agreed to ship the notes.",
            "Blake: I will send the announcement.",
          ],
        });
        expect(notes.markdown).toContain("Blake: I will send the announcement.");
        if (mode === "model") {
          expect(notes.summary).toMatchObject({
            ...modelNotes,
            source: "model",
            model: "openai/gpt-5.6-luna",
          });
          expect(notes.markdown).toContain(modelNotes.overview);
          expect(runIsolatedCompletion).toHaveBeenCalledWith(
            expect.objectContaining({
              config: cfg,
              agentId: "research",
              model: "gpt-5.6-luna",
            }),
          );
        } else {
          expect(notes.summary).toMatchObject({
            source: "heuristic",
            decisions: ["Avery: We agreed to ship the notes."],
          });
          expect(notes.summary).not.toHaveProperty("model");
          if (mode === "no-model") {
            expect(runIsolatedCompletion).not.toHaveBeenCalled();
          } else {
            expect(runIsolatedCompletion).toHaveBeenCalled();
          }
        }
      } finally {
        await bridge.stop(session, async () => {});
      }
    },
  );
});
