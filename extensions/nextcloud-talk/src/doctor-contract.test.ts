// Nextcloud Talk tests cover doctor contract plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { legacyConfigRules, normalizeCompatibilityConfig } from "./doctor-contract.js";

function talkConfig(entry: Record<string, unknown>): OpenClawConfig {
  return { channels: { "nextcloud-talk": entry } } as never;
}

describe("nextcloud-talk streaming legacy config rules", () => {
  const rootRule = legacyConfigRules.find(
    (rule) =>
      rule.path.join(".") === "channels.nextcloud-talk" && rule.message.includes("chunkMode"),
  );

  it("matches flat delivery aliases but not the nested shape", () => {
    expect(rootRule?.match?.({ chunkMode: "newline" }, {})).toBe(true);
    expect(rootRule?.match?.({ streaming: { chunkMode: "newline" } }, {})).toBe(false);
  });
});

describe("nextcloud-talk normalizeCompatibilityConfig streaming aliases", () => {
  it("moves flat delivery aliases at root and account level with root seeding", () => {
    const result = normalizeCompatibilityConfig({
      cfg: talkConfig({
        chunkMode: "newline",
        accounts: {
          home: { blockStreaming: true },
        },
      }),
    });

    const talk = result.config.channels?.["nextcloud-talk"] as unknown as Record<string, unknown>;
    expect(talk.streaming).toEqual({ chunkMode: "newline" });
    expect(talk.chunkMode).toBeUndefined();
    const home = (talk.accounts as Record<string, Record<string, unknown>>).home;
    // Account merge replaces root streaming wholesale, so the migrated account
    // object carries the inherited root chunk mode.
    expect(home?.streaming).toEqual({ chunkMode: "newline", block: { enabled: true } });
    expect(home?.blockStreaming).toBeUndefined();
  });

  it("still runs the legacy private-network migration and stays idempotent", () => {
    const first = normalizeCompatibilityConfig({
      cfg: talkConfig({ allowPrivateNetwork: true, blockStreaming: false }),
    });
    const talk = first.config.channels?.["nextcloud-talk"] as unknown as Record<string, unknown>;
    expect(talk.allowPrivateNetwork).toBeUndefined();
    expect(talk.network).toEqual({ dangerouslyAllowPrivateNetwork: true });
    expect(talk.streaming).toEqual({ block: { enabled: false } });

    const second = normalizeCompatibilityConfig({ cfg: first.config });
    expect(second.changes).toEqual([]);
  });
});
