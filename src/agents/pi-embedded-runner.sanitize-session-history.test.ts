import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { SessionManager } from "@mariozechner/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as helpers from "./pi-embedded-helpers.js";

type SanitizeSessionHistory =
  typeof import("./pi-embedded-runner/google.js").sanitizeSessionHistory;
let sanitizeSessionHistory: SanitizeSessionHistory;

// Mock dependencies
vi.mock("./pi-embedded-helpers.js", async () => {
  const actual = await vi.importActual("./pi-embedded-helpers.js");
  return {
    ...actual,
    isGoogleModelApi: vi.fn(),
    downgradeGeminiHistory: vi.fn(),
    sanitizeSessionMessagesImages: vi.fn().mockImplementation(async (msgs) => msgs),
  };
});

// We don't mock session-transcript-repair.js as it is a pure function and complicates mocking.
// We rely on the real implementation which should pass through our simple messages.

describe("sanitizeSessionHistory", () => {
  const mockSessionManager = {
    getEntries: vi.fn().mockReturnValue([]),
    appendCustomEntry: vi.fn(),
  } as unknown as SessionManager;

  const mockMessages: AgentMessage[] = [{ role: "user", content: "hello" }];

  beforeEach(async () => {
    vi.resetAllMocks();
    vi.mocked(helpers.sanitizeSessionMessagesImages).mockImplementation(async (msgs) => msgs);
    // Default mock implementation
    vi.mocked(helpers.downgradeGeminiHistory).mockImplementation((msgs) => {
      if (!msgs) return [];
      return [...msgs, { role: "system", content: "downgraded" }];
    });
    vi.resetModules();
    ({ sanitizeSessionHistory } = await import("./pi-embedded-runner/google.js"));
  });

  it("should downgrade history for Google models if provider is not google-antigravity", async () => {
    vi.mocked(helpers.isGoogleModelApi).mockReturnValue(true);

    const result = await sanitizeSessionHistory({
      messages: mockMessages,
      modelApi: "google-gemini",
      provider: "google-vertex",
      sessionManager: mockSessionManager,
      sessionId: "test-session",
    });

    expect(helpers.isGoogleModelApi).toHaveBeenCalledWith("google-gemini");
    expect(helpers.downgradeGeminiHistory).toHaveBeenCalled();
    // Check if the result contains the downgraded message
    expect(result).toContainEqual({ role: "system", content: "downgraded" });
  });

  it("should NOT downgrade history for google-antigravity provider", async () => {
    vi.mocked(helpers.isGoogleModelApi).mockReturnValue(true);

    const result = await sanitizeSessionHistory({
      messages: mockMessages,
      modelApi: "google-gemini",
      provider: "google-antigravity",
      sessionManager: mockSessionManager,
      sessionId: "test-session",
    });

    expect(helpers.isGoogleModelApi).toHaveBeenCalledWith("google-gemini");
    expect(helpers.downgradeGeminiHistory).not.toHaveBeenCalled();
    // Result should not contain the downgraded message
    expect(result).not.toContainEqual({
      role: "system",
      content: "downgraded",
    });
  });

  it("should NOT downgrade history for non-Google models", async () => {
    vi.mocked(helpers.isGoogleModelApi).mockReturnValue(false);

    const _result = await sanitizeSessionHistory({
      messages: mockMessages,
      modelApi: "anthropic-messages",
      provider: "anthropic",
      sessionManager: mockSessionManager,
      sessionId: "test-session",
    });

    expect(helpers.isGoogleModelApi).toHaveBeenCalledWith("anthropic-messages");
    expect(helpers.downgradeGeminiHistory).not.toHaveBeenCalled();
  });

  it("should downgrade history if provider is undefined but model is Google", async () => {
    vi.mocked(helpers.isGoogleModelApi).mockReturnValue(true);

    const _result = await sanitizeSessionHistory({
      messages: mockMessages,
      modelApi: "google-gemini",
      provider: undefined,
      sessionManager: mockSessionManager,
      sessionId: "test-session",
    });

    expect(helpers.isGoogleModelApi).toHaveBeenCalledWith("google-gemini");
    expect(helpers.downgradeGeminiHistory).toHaveBeenCalled();
  });
});
