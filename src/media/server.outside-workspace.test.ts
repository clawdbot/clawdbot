import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  LOOPBACK_FETCH_ENV,
  startMediaServerTestHarness,
  type MediaServerTestHarness,
} from "./server.test-support.js";

const mocks = vi.hoisted(() => ({
  readFileWithinRoot: vi.fn(),
  cleanOldMedia: vi.fn().mockResolvedValue(undefined),
  isSafeOpenError: vi.fn(
    (error: unknown) => typeof error === "object" && error !== null && "code" in error,
  ),
}));

let mediaDir = "";

vi.mock("./server.runtime.js", () => {
  return {
    MEDIA_MAX_BYTES: 5 * 1024 * 1024,
    readFileWithinRoot: mocks.readFileWithinRoot,
    isSafeOpenError: mocks.isSafeOpenError,
    getMediaDir: () => mediaDir,
    cleanOldMedia: mocks.cleanOldMedia,
  };
});

let mediaHarness: MediaServerTestHarness | undefined;
const mediaRootTracker = createSuiteTempRootTracker({
  prefix: "openclaw-media-outside-workspace-",
});

async function expectOutsideWorkspaceServerResponse(url: string) {
  const response = await withEnvAsync(LOOPBACK_FETCH_ENV, () => mediaHarness!.fetch(url));
  expect(response.status).toBe(400);
  expect(await response.text()).toBe("file is outside workspace root");
}

describe("media server outside-workspace mapping", () => {
  beforeAll(async () => {
    mediaHarness = await startMediaServerTestHarness({
      setupMediaRoot: async () => {
        await mediaRootTracker.setup();
        mediaDir = await mediaRootTracker.make("case");
      },
      cleanupMediaRoot: async () => {
        await mediaRootTracker.cleanup();
        mediaDir = "";
      },
    });
  });

  beforeEach(() => {
    mocks.readFileWithinRoot.mockReset();
    mocks.cleanOldMedia.mockClear();
  });

  afterAll(async () => {
    await mediaHarness?.cleanup();
    mediaHarness = undefined;
  });

  it("returns 400 with a specific outside-workspace message", async () => {
    if (mediaHarness?.listenBlocked) {
      return;
    }
    mocks.readFileWithinRoot.mockRejectedValueOnce({
      code: "outside-workspace",
      message: "file is outside workspace root",
    });

    await expectOutsideWorkspaceServerResponse(mediaHarness!.url("ok-id"));
  });
});
