import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSanitizeSessionHistoryHelpersMock,
  createSanitizeSessionHistoryProviderRuntimeMock,
  loadSanitizeSessionHistoryWithCleanMocks,
  makeMockSessionManager,
  makeSimpleUserMessages,
  type SanitizeSessionHistoryHarness,
  sanitizeSnapshotChangedOpenAIReasoning,
  sanitizeWithOpenAIResponses,
} from "./pi-embedded-runner.sanitize-session-history.test-harness.js";

vi.mock(
  "./pi-embedded-helpers.js",
  async () => await createSanitizeSessionHistoryHelpersMock({ isGoogleModelApi: vi.fn() }),
);

vi.mock(
  "../plugins/provider-runtime.js",
  async () => await createSanitizeSessionHistoryProviderRuntimeMock(),
);

let sanitizeSessionHistory: SanitizeSessionHistoryHarness["sanitizeSessionHistory"];
let mockedHelpers: SanitizeSessionHistoryHarness["mockedHelpers"];

describe("sanitizeSessionHistory e2e smoke", () => {
  const mockSessionManager = makeMockSessionManager();
  const mockMessages = makeSimpleUserMessages();

  beforeAll(async () => {
    const harness = await loadSanitizeSessionHistoryWithCleanMocks();
    sanitizeSessionHistory = harness.sanitizeSessionHistory;
    mockedHelpers = harness.mockedHelpers;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(mockedHelpers.sanitizeSessionMessagesImages).mockImplementation(async (msgs) => msgs);
  });

  it("passes simple user-only history through for google model APIs", async () => {
    vi.mocked(mockedHelpers.isGoogleModelApi).mockReturnValue(true);

    const result = await sanitizeSessionHistory({
      messages: mockMessages,
      modelApi: "google-generative-ai",
      provider: "google-vertex",
      sessionManager: mockSessionManager,
      sessionId: "test-session",
    });

    expect(result).toEqual(mockMessages);
  });

  it("passes simple user-only history through for openai-responses", async () => {
    vi.mocked(mockedHelpers.isGoogleModelApi).mockReturnValue(false);

    const result = await sanitizeWithOpenAIResponses({
      sanitizeSessionHistory,
      messages: mockMessages,
      sessionManager: mockSessionManager,
    });

    expect(result).toEqual(mockMessages);
  });

  it("downgrades openai reasoning blocks when the model snapshot changed", async () => {
    const result = await sanitizeSnapshotChangedOpenAIReasoning({
      sanitizeSessionHistory,
    });

    expect(result).toEqual([]);
  });
});
