import type { CDPSession, Page } from "playwright-core";
import { describe, expect, it, vi } from "vitest";
import { pageStates } from "./pw-session-contracts.js";
import { ensurePageState } from "./pw-session-state.js";

describe("page emulation lifecycle", () => {
  it("detaches the persistent emulation session when the page closes", async () => {
    const handlers = new Map<string, () => void>();
    const page = {
      on: vi.fn((event: string, handler: () => void) => {
        handlers.set(event, handler);
      }),
    } as unknown as Page;
    const detach = vi.fn(async () => {});
    const state = ensurePageState(page);
    state.emulation = {
      session: Promise.resolve({ detach } as unknown as CDPSession),
    };

    handlers.get("close")?.();

    await vi.waitFor(() => expect(detach).toHaveBeenCalledTimes(1));
    expect(pageStates.has(page)).toBe(false);
  });
});
