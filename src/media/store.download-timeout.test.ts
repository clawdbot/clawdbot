// Media store remote download timeout ownership stays in the canonical fetch path.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { saveMediaSource } from "./store.js";

const saveRemoteMediaMock = vi.hoisted(() => vi.fn());

vi.mock("./fetch.js", () => ({
  saveRemoteMedia: saveRemoteMediaMock,
}));

describe("media store remote download timeouts", () => {
  let testState: OpenClawTestState;

  beforeAll(async () => {
    testState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-media-store-download-timeout-",
    });
  });

  beforeEach(() => {
    saveRemoteMediaMock.mockReset();
  });

  afterAll(async () => {
    await testState.cleanup();
  });

  it("delegates both remote download deadlines to the canonical fetch owner", async () => {
    const timeoutError = Object.assign(new Error("response headers timed out"), {
      name: "MediaFetchError",
      code: "fetch_failed",
    });
    saveRemoteMediaMock.mockRejectedValueOnce(timeoutError);

    await expect(saveMediaSource("https://example.com/media.bin")).rejects.toBe(timeoutError);

    expect(saveRemoteMediaMock).toHaveBeenCalledOnce();
    expect(saveRemoteMediaMock).toHaveBeenCalledWith(
      expect.objectContaining({
        responseHeaderTimeoutMs: 30_000,
        readIdleTimeoutMs: 30_000,
      }),
    );
  });
});
