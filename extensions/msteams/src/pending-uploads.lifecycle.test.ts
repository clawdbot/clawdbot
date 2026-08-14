// Msteams tests cover lifecycle cleanup for pending upload timers.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const singleton = vi.hoisted(() => ({ reset: undefined as (() => void) | undefined }));

vi.mock("openclaw/plugin-sdk/global-singleton", () => ({
  resolveGlobalSingleton: <T>(_key: symbol, create: () => T, reset?: (value: T) => void): T => {
    const value = create();
    singleton.reset = () => reset?.(value);
    return value;
  },
}));

import { getPendingUpload, storePendingUpload } from "./pending-uploads.js";

describe("pending upload lifecycle reset", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    singleton.reset?.();
    vi.useRealTimers();
  });

  it("cancels every TTL timer before clearing pending uploads", () => {
    const id = storePendingUpload({
      buffer: Buffer.from("data"),
      filename: "file.txt",
      conversationId: "conv-1",
    });
    expect(getPendingUpload(id)).toBeDefined();
    expect(vi.getTimerCount()).toBe(1);

    singleton.reset?.();

    expect(getPendingUpload(id)).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
});
