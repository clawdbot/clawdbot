// Verifies redacted snapshot schema metadata stays aligned with config schema.

import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { redactSnapshotTestHints as mainSchemaHints } from "../../test/helpers/config/redact-snapshot-test-hints.js";
import { REDACTED_SENTINEL, redactConfigSnapshot } from "./redact-snapshot.js";
import { makeSnapshot, restoreRedactedValues } from "./redact-snapshot.test-helpers.js";
import { buildConfigSchemaCore } from "./schema.js";

describe("realredactConfigSnapshot_real", () => {
  it("main schema redact works (samples)", () => {
    const snapshot = makeSnapshot({
      memory: {
        search: {
          remote: {
            apiKey: "1234",
          },
        },
      },

      agents: {
        defaults: {},
        entries: {
          main: {
            memory: {
              search: {
                remote: {
                  apiKey: "6789",
                },
              },
            },
          },
        },
      },
    });

    const result = redactConfigSnapshot(snapshot, mainSchemaHints);
    const config = result.config as typeof snapshot.config;
    expect(config.memory.search.remote.apiKey).toBe(REDACTED_SENTINEL);
    expect(
      expectDefined(config.agents.entries.main, "config.agents.entries.main test invariant").memory
        .search.remote.apiKey,
    ).toBe(REDACTED_SENTINEL);
    const restored = restoreRedactedValues(result.config, snapshot.config, mainSchemaHints);
    expect(restored.memory.search.remote.apiKey).toBe("1234");
    expect(
      expectDefined(restored.agents.entries.main, "restored.agents.entries.main test invariant")
        .memory.search.remote.apiKey,
    ).toBe("6789");
  });

  it("redacts bundled channel private keys from generated schema hints", () => {
    const hints = buildConfigSchemaCore().uiHints;
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
    expect(expectDefined(channels.nostr, "channels.nostr test invariant").privateKey).toBe(
      REDACTED_SENTINEL,
    );

    const restored = restoreRedactedValues(result.config, snapshot.config, hints);
    expect(restored.channels.nostr.privateKey).toBe(
      "nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5",
    );
  });

  it("redacts remote edge-auth header values from generated schema hints", () => {
    const hints = buildConfigSchemaCore().uiHints;
    const snapshot = makeSnapshot({
      gateway: {
        remote: {
          edgeAuth: { "X-Edge-Auth": "test-secret" },
        },
      },
    });

    const result = redactConfigSnapshot(snapshot, hints);
    const gateway = expectDefined(result.config.gateway, "redacted gateway config");
    const remote = expectDefined(gateway.remote, "redacted remote gateway config");
    const edgeAuth = expectDefined(remote.edgeAuth, "redacted edge auth config");
    expect(edgeAuth["X-Edge-Auth"]).toBe(REDACTED_SENTINEL);
    const restored = restoreRedactedValues(result.config, snapshot.config, hints);
    expect(restored.gateway.remote.edgeAuth["X-Edge-Auth"]).toBe("test-secret");
  });

  it("redacts Discord Activity client secrets registered on plain string schemas", () => {
    const hints = buildConfigSchemaCore().uiHints;
    expect(hints["channels.discord.activities.clientSecret"]?.sensitive).toBe(true);
    const snapshot = makeSnapshot({
      channels: {
        discord: {
          activities: {
            clientSecret: "cfgsec",
          },
        },
      },
    });

    const result = redactConfigSnapshot(snapshot, hints);
    const channels = result.config.channels as Record<string, Record<string, unknown>>;
    const discord = expectDefined(channels.discord, "channels.discord test invariant");
    const activities = discord.activities as Record<string, unknown>;
    expect(activities.clientSecret).toBe(REDACTED_SENTINEL);
  });

  it("redacts and restores web fetch operator headers from generated schema hints", () => {
    const hints = buildConfigSchemaCore().uiHints;
    expect(hints["tools.web.fetch.headers.*"]?.sensitive).toBe(true);
    const snapshot = makeSnapshot({
      tools: {
        web: {
          fetch: {
            headers: {
              "X-Routing-Target": "staging-private-route",
            },
          },
        },
      },
    });

    const result = redactConfigSnapshot(snapshot, hints);
    const tools = expectDefined(result.config.tools, "result.config.tools test invariant");
    const web = expectDefined(tools.web, "result.config.tools.web test invariant");
    const fetch = expectDefined(web.fetch, "result.config.tools.web.fetch test invariant");
    const headers = expectDefined(
      fetch.headers,
      "result.config.tools.web.fetch.headers test invariant",
    );
    expect(headers["X-Routing-Target"]).toBe(REDACTED_SENTINEL);

    const restored = restoreRedactedValues(result.config, snapshot.config, hints);
    expect(restored.tools.web.fetch.headers["X-Routing-Target"]).toBe("staging-private-route");
  });
});
