// Regresses legacy provider config shapes accepted by config loading.
import { describe, expect, it } from "vitest";
import { normalizeLegacyTalkConfig } from "../commands/doctor/shared/legacy-talk-config-normalizer.js";
import type { OpenClawConfig } from "./types.js";
import { OpenClawSchema } from "./zod-schema.js";

describe("legacy provider-shaped config snapshots", () => {
  it("preserves provider-owned legacy Talk fields for the provider doctor migration", () => {
    const raw = {
      talk: {
        voiceAliases: {
          Clawd: "VoiceAlias1234567890",
          Roger: "CwhRBWXzGAHq8TQ4Fs17",
        },
      },
    };
    const changes: string[] = [];
    const migrated = normalizeLegacyTalkConfig(raw as unknown as OpenClawConfig, changes);

    expect(changes).toEqual([]);
    expect(migrated).toEqual(raw);
  });

  it("rejects non-string voice alias values", () => {
    const res = OpenClawSchema.safeParse({
      talk: {
        voiceAliases: {
          Clawd: 123,
        },
      },
    });
    expect(res.success).toBe(false);
  });
});
