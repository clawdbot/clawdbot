// Line tests cover text-chunk-limit plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { LINE_TEXT_CHUNK_LIMIT, resolveLineTextChunkLimit } from "./text-chunk-limit.js";

const cfgWith = (line: Record<string, unknown>): OpenClawConfig => ({ channels: { line } });

describe("resolveLineTextChunkLimit", () => {
  it.each([
    {
      name: "falls back to what LINE accepts when nothing is configured",
      cfg: cfgWith({}),
      accountId: "default",
      expected: LINE_TEXT_CHUNK_LIMIT,
    },
    {
      name: "uses the channel-wide limit",
      cfg: cfgWith({ textChunkLimit: 800 }),
      accountId: "default",
      expected: 800,
    },
    {
      name: "prefers the account limit over the channel-wide one",
      cfg: cfgWith({ textChunkLimit: 800, accounts: { work: { textChunkLimit: 300 } } }),
      accountId: "work",
      expected: 300,
    },
    {
      name: "bounds a channel limit LINE would reject",
      cfg: cfgWith({ textChunkLimit: 9000 }),
      accountId: "default",
      expected: LINE_TEXT_CHUNK_LIMIT,
    },
    {
      name: "bounds an account limit LINE would reject",
      cfg: cfgWith({ accounts: { work: { textChunkLimit: 9000 } } }),
      accountId: "work",
      expected: LINE_TEXT_CHUNK_LIMIT,
    },
  ])("$name", ({ cfg, accountId, expected }) => {
    expect(resolveLineTextChunkLimit({ cfg, accountId })).toBe(expected);
  });

  it("keeps LINE's cap for a missing config", () => {
    expect(resolveLineTextChunkLimit({ cfg: undefined })).toBe(LINE_TEXT_CHUNK_LIMIT);
  });
});
