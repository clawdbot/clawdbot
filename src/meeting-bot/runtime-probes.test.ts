import { describe, expect, it, vi } from "vitest";
import { createMeetingRuntimeProbes } from "./runtime-probes.js";
import type { MeetingBrowserHealth } from "./session-types.js";

type Mode = "agent" | "bidi" | "transcribe";
type Transport = "chrome" | "chrome-node";
type Health = MeetingBrowserHealth & {
  transcriptLines?: number;
  lastCaptionAt?: string;
  lastCaptionText?: string;
};
type Session = {
  id: string;
  chrome?: {
    launched: boolean;
    browserTab?: { targetId?: string };
    health?: Health;
  };
};
type Request = {
  url: string;
  mode?: Mode;
  transport?: Transport;
  timeoutMs?: number;
  message?: string;
  agentId?: string;
};
type Config = {
  defaultMode: Mode;
  chrome: { joinTimeoutMs: number };
  chromeNode: { node?: string };
};

const cases = [
  {
    name: "Teams",
    invalidRequestName: "Error",
    session: { id: "teams", chrome: { launched: true } } satisfies Session,
    shouldWaitForListening: (session: Session) => Boolean(session.chrome?.launched),
  },
  {
    name: "Zoom",
    invalidRequestName: "ZoomInvalidRequest",
    session: { id: "zoom", chrome: { launched: true } } satisfies Session,
    shouldWaitForListening: (session: Session) => Boolean(session.chrome?.browserTab?.targetId),
  },
] as const;

describe.each(cases)("$name meeting runtime probe parity", (testCase) => {
  const createProbes = () =>
    createMeetingRuntimeProbes<Config, Mode, Transport, Health, Session, Request>({
      defaultSpeechMessage: `Say exactly: ${testCase.name} speech test complete.`,
      invalidRequest: (message) => {
        const error = new Error(message);
        error.name = testCase.invalidRequestName;
        return error;
      },
      resolveTimeoutMs: () => 5,
      shouldWaitForListening: testCase.shouldWaitForListening,
      talkBackMode: (mode) => mode === "agent" || mode === "bidi",
    });

  it("preserves the platform invalid-request contract", async () => {
    const probes = createProbes();
    await expect(
      probes.testSpeech(
        {
          config: { defaultMode: "agent", chrome: { joinTimeoutMs: 5 }, chromeNode: {} },
          resolveAgentId: () => "main",
          list: () => [],
          join: vi.fn(),
          isReusable: () => false,
          hasHealthHandle: () => false,
          refreshHealth: vi.fn(),
          refreshCaptionHealth: vi.fn(),
        },
        { url: "https://example.test/meeting", mode: "transcribe" },
      ),
    ).rejects.toMatchObject({
      name: testCase.invalidRequestName,
      message: "test_speech requires mode: agent or bidi",
    });
  });

  it("preserves the platform listening wait ownership", async () => {
    const probes = createProbes();
    const refreshCaptionHealth = vi.fn(async () => undefined);
    const context = {
      config: { defaultMode: "agent" as const, chrome: { joinTimeoutMs: 5 }, chromeNode: {} },
      resolveAgentId: () => "main",
      list: () => [],
      join: vi.fn(async () => ({ session: testCase.session })),
      isReusable: () => false,
      hasHealthHandle: () => false,
      refreshHealth: vi.fn(),
      refreshCaptionHealth,
    };

    await probes.testListening(context, {
      url: "https://example.test/meeting",
      mode: "transcribe",
      timeoutMs: 5,
    });

    if (testCase.name === "Teams") {
      expect(refreshCaptionHealth).toHaveBeenCalled();
    } else {
      expect(refreshCaptionHealth).not.toHaveBeenCalled();
    }
  });
});
