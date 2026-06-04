// Verifies redacted snapshot schema metadata stays aligned with config schema.
import { describe, expect, it } from "vitest";
import { redactSnapshotTestHints as mainSchemaHints } from "../../test/helpers/config/redact-snapshot-test-hints.js";
import { REDACTED_SENTINEL, redactConfigSnapshot } from "./redact-snapshot.js";
import { makeSnapshot, restoreRedactedValues } from "./redact-snapshot.test-helpers.js";
import { buildConfigSchema } from "./schema.js";

describe("realredactConfigSnapshot_real", () => {
  it("main schema redact works (samples)", () => {
    const snapshot = makeSnapshot({
      agents: {
        defaults: {
          memorySearch: {
            remote: {
              apiKey: "1234",
            },
          },
        },
        list: [
          {
            memorySearch: {
              remote: {
                apiKey: "6789",
              },
            },
          },
        ],
      },
    });

    const result = redactConfigSnapshot(snapshot, mainSchemaHints);
    const config = result.config as typeof snapshot.config;
    expect(config.agents.defaults.memorySearch.remote.apiKey).toBe(REDACTED_SENTINEL);
    expect(config.agents.list[0].memorySearch.remote.apiKey).toBe(REDACTED_SENTINEL);
    const restored = restoreRedactedValues(result.config, snapshot.config, mainSchemaHints);
    expect(restored.agents.defaults.memorySearch.remote.apiKey).toBe("1234");
    expect(restored.agents.list[0].memorySearch.remote.apiKey).toBe("6789");
  });

  it("redacts bundled channel private keys from generated schema hints", () => {
    const hints = buildConfigSchema().uiHints;
    const snapshot = makeSnapshot({
      channels: {
        nostr: {
          privateKey: "nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5",
          relays: ["wss://relay.example.com"],
        },
      },
    });

    const result = redactConfigSnapshot(snapshot, hints);
    const channels = result.config.channels as Record<string, Record<string, unknown>>;
    expect(channels.nostr.privateKey).toBe(REDACTED_SENTINEL);

    const restored = restoreRedactedValues(result.config, snapshot.config, hints);
    expect(restored.channels.nostr.privateKey).toBe(
      "nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5",
    );
  });
});
