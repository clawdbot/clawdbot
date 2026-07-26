// Business Connect grammY api spy shared by the create-telegram-bot test
// harness. Split out of bot.create-telegram-bot.test-harness.ts (already at
// the project's max-lines budget) rather than growing that file further.
// Self-registers its own reset hook so the harness only needs one import
// line plus one spread of `businessApi` into its mocked bot.api object.
//
// Only getBusinessConnection is wired here: the live bot instance is the
// only thing that ever calls it (inbound connection-hydration fallback).
// readBusinessMessage is called from send-message.ts's independently
// constructed api client instead, and is covered by send.test-harness.ts.
import { beforeEach, vi } from "vitest";

type AnyAsyncMock = ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<unknown>>>;

const NOT_STUBBED_MESSAGE = "getBusinessConnection not stubbed";
const getBusinessConnectionSpy: AnyAsyncMock = vi.fn(() =>
  Promise.reject(new Error(NOT_STUBBED_MESSAGE)),
);

export const businessApi = { getBusinessConnection: getBusinessConnectionSpy };

beforeEach(() => {
  getBusinessConnectionSpy.mockReset();
  getBusinessConnectionSpy.mockRejectedValue(new Error(NOT_STUBBED_MESSAGE));
});
