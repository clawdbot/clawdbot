import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginRuntime, RuntimeLogger } from "../plugins/runtime/types.js";
import type { createMeetingRealtimeEngineBindings } from "./agent-consult.js";
import type { startMeetingAgentRealtimeEngine } from "./realtime-agent-engine.js";
import type { MeetingRealtimeEngineConfig, startMeetingRealtimeEngine } from "./realtime-engine.js";
import type { createLocalMeetingRealtimeAudioTransport } from "./realtime-local-audio-transport.js";
import type { createNodeMeetingRealtimeAudioTransport } from "./realtime-node-audio-transport.js";

const browserMocks = vi.hoisted(() => ({
  leave: vi.fn(),
  open: vi.fn(),
  resolveLocal: vi.fn(),
}));

vi.mock("./browser-controller.js", () => ({
  openMeetingWithBrowser: browserMocks.open,
  recoverMeetingBrowserTab: vi.fn(),
}));
vi.mock("./browser-request.js", () => ({
  resolveLocalMeetingBrowserRequest: browserMocks.resolveLocal,
}));
vi.mock("./browser-session-control.js", () => ({
  leaveMeetingWithBrowser: browserMocks.leave,
  readMeetingTranscriptWithBrowser: vi.fn(),
}));

import { createMeetingChromeTransport } from "./chrome-transport.js";
import type {
  MeetingPlatformAdapter,
  MeetingPlatformRuntimeMetadata,
} from "./platform-adapter-contract.js";
import type { MeetingBrowserHealth, MeetingTranscriptSnapshot } from "./session-types.js";

type TestMode = "agent" | "transcribe";
type TestConfig = MeetingRealtimeEngineConfig & {
  chrome: MeetingRealtimeEngineConfig["chrome"] & {
    audioInputCommand: string[];
    audioOutputCommand: string[];
    autoJoin: boolean;
    bargeInCooldownMs: number;
    bargeInPeakThreshold: number;
    bargeInRmsThreshold: number;
    guestName: string;
    joinTimeoutMs: number;
    launch: boolean;
    reuseExistingTab: boolean;
    waitForInCallMs: number;
  };
  chromeNode: { node?: string };
  realtime: MeetingRealtimeEngineConfig["realtime"] & {
    toolPolicy: "none";
  };
};

const config = {
  chrome: {
    audioFormat: "pcm16-24khz",
    audioInputCommand: [],
    audioOutputCommand: [],
    autoJoin: true,
    bargeInCooldownMs: 0,
    bargeInPeakThreshold: 0,
    bargeInRmsThreshold: 0,
    guestName: "OpenClaw",
    joinTimeoutMs: 1_000,
    launch: true,
    reuseExistingTab: true,
    waitForInCallMs: 1_000,
  },
  chromeNode: {},
  realtime: {
    providers: {},
    strategy: "agent",
    toolPolicy: "none",
  },
} satisfies TestConfig;

const platform = {
  id: "test-meetings",
  displayName: "Test meetings",
  browserLabel: "Test meeting",
  logScope: "[test-meetings]",
  agentConsult: {
    surface: "a private test meeting",
    userLabel: "Participant",
    assistantLabel: "Agent",
    questionSourceLabel: "participant",
    workingResponseLabel: "participant",
    extraSystemPrompt: "Test",
  },
  session: {
    idPrefix: "test_meeting",
    participantIdentity: () => "Test participant",
  },
  nodeCommandName: "testmeetings.chrome",
  nodeConfigPath: "plugins.entries.test-meetings.config.chromeNode.node",
} as unknown as MeetingPlatformAdapter<
  { meetingSessionId: string; mode: TestMode; url: string },
  TestMode,
  MeetingBrowserHealth,
  MeetingTranscriptSnapshot
> &
  MeetingPlatformRuntimeMetadata;

const logger: RuntimeLogger = {
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
};

const cases = [
  { name: "Teams", preserveTrackedBrowserOnEngineFailure: false, expectedLeaves: 1 },
  { name: "Zoom", preserveTrackedBrowserOnEngineFailure: true, expectedLeaves: 0 },
] as const;

describe.each(cases)("$name Chrome transport parity", (testCase) => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    browserMocks.resolveLocal.mockResolvedValue(vi.fn());
    browserMocks.open.mockResolvedValue({
      launched: true,
      browser: { inCall: true },
      tab: { targetId: "tracked-tab", openedByPlugin: false },
    });
    browserMocks.leave.mockResolvedValue({ left: true, note: "Left meeting." });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("preserves the platform rollback ownership rule for tracked calls", async () => {
    const dispose = vi.fn(async () => {});
    const transport = createMeetingChromeTransport<
      TestConfig,
      TestMode,
      MeetingBrowserHealth,
      MeetingTranscriptSnapshot
    >({
      browserNodeAdapter: platform,
      isRealtimeRouteReady: () => true,
      isTalkBackMode: () => true,
      meetingLabel: `${testCase.name} meeting`,
      nodeCommandName: platform.nodeCommandName,
      outputMentionsAudioDevice: () => true,
      platform,
      preserveTrackedBrowserOnEngineFailure: testCase.preserveTrackedBrowserOnEngineFailure,
      runtime: {
        createBindings: vi.fn(() => ({
          platform: { displayName: "Test", logScope: "[test]", sessionIdPrefix: "test" },
          consultAgent: vi.fn(),
          tools: [],
          handleToolCall: vi.fn(),
        })) as unknown as typeof createMeetingRealtimeEngineBindings,
        createLocalAudioTransport: vi.fn(() => ({
          clearOutput: vi.fn(),
          dispose,
          onFatal: vi.fn(),
          startInput: vi.fn(),
          stop: vi.fn(),
          writeOutput: vi.fn(),
        })) as unknown as typeof createLocalMeetingRealtimeAudioTransport,
        createNodeAudioTransport:
          vi.fn() as unknown as typeof createNodeMeetingRealtimeAudioTransport,
        startAgentRealtimeEngine: vi.fn(async () => {
          throw new Error("realtime startup failed");
        }) as unknown as typeof startMeetingAgentRealtimeEngine,
        startRealtimeEngine: vi.fn() as unknown as typeof startMeetingRealtimeEngine,
      },
      systemProfilerCommand: "/usr/sbin/system_profiler",
    });
    const runtime = {
      system: {
        runCommandWithTimeout: vi.fn(async () => ({
          code: 0,
          stderr: "",
          stdout: "BlackHole 2ch",
        })),
      },
    } as unknown as PluginRuntime;

    await expect(
      transport.launchInChrome({
        config,
        fullConfig: { transcripts: { enabled: false } } as OpenClawConfig,
        logger,
        meetingSessionId: "session-1",
        mode: "agent",
        runtime,
        trackedTargetId: "tracked-tab",
        url: "https://example.test/meeting",
      }),
    ).rejects.toThrow("realtime startup failed");

    expect(dispose).toHaveBeenCalledOnce();
    expect(browserMocks.open).toHaveBeenCalledWith(
      expect.objectContaining({
        session: expect.objectContaining({ captureCaptions: false, mode: "agent" }),
      }),
    );
    expect(browserMocks.leave).toHaveBeenCalledTimes(testCase.expectedLeaves);
  });
});
