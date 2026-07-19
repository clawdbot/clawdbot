// Verifies config IO metadata for persisted and generated settings.
import { describe, expect, it } from "vitest";
import { AUTO_MANAGED_CONFIG_META_PATHS, stampConfigWriteMetadata } from "./io.meta.js";
import { computeModelPolicyAllowlist } from "./model-policy-allowlist-migration.js";

describe("config write metadata stamping", () => {
  it("stamps every declared auto-managed meta path", () => {
    const stamped = stampConfigWriteMetadata({});

    expect(AUTO_MANAGED_CONFIG_META_PATHS).toEqual([
      ["meta", "lastTouchedVersion"],
      ["meta", "lastTouchedAt"],
    ]);

    for (const [parent, field] of AUTO_MANAGED_CONFIG_META_PATHS) {
      expect(parent).toBe("meta");
      expect(typeof stamped.meta?.[field]).toBe("string");
    }
  });

  it("preserves a legacy model restriction before an unrelated write updates version metadata", () => {
    const previous = {
      meta: { lastTouchedVersion: "2026.7.1" },
      agents: {
        defaults: {
          models: {
            "openai/*": {},
            "anthropic/claude-sonnet-4-6": { alias: "sonnet" },
          },
        },
      },
    };

    const stamped = stampConfigWriteMetadata(
      previous,
      "2026-07-18T00:00:00.000Z",
      "2026.7.2",
      previous,
    );

    expect(stamped.agents?.defaults?.modelPolicy?.allow).toEqual([
      "openai/*",
      "anthropic/claude-sonnet-4-6",
    ]);
    expect(stamped.meta?.migrations?.modelPolicyAllowlist).toBe(true);
  });

  it("honors an explicit empty default model policy added on the first write", () => {
    const previous = {
      agents: {
        defaults: {
          models: { "openai/gpt-5.5": {} },
        },
      },
    };
    const next = {
      agents: {
        defaults: {
          ...previous.agents.defaults,
          modelPolicy: {},
        },
      },
    };

    const stamped = stampConfigWriteMetadata(
      next,
      "2026-07-18T00:00:00.000Z",
      "2026.7.2",
      previous,
    );

    expect(stamped.agents?.defaults?.modelPolicy).toEqual({});
    expect(stamped.meta?.migrations?.modelPolicyAllowlist).toBe(true);
  });

  it("marks a model-map-free write so later model metadata stays unrestricted", () => {
    const stamped = stampConfigWriteMetadata({}, "2026-07-18T00:00:00.000Z", "2026.7.2", {});
    const edited = {
      ...stamped,
      agents: {
        defaults: {
          models: { "custom/private-model": { alias: "private" } },
        },
      },
    };

    expect(stamped.meta?.migrations?.modelPolicyAllowlist).toBe(true);
    expect(
      computeModelPolicyAllowlist({
        root: edited,
        defaults: edited.agents.defaults,
      }),
    ).toBeNull();
  });

  it("does not widen a legacy restriction from model metadata added by the first write", () => {
    const previous = {
      agents: { defaults: { models: { "openai/gpt-5.5": {} } } },
    };
    const stamped = stampConfigWriteMetadata(
      {
        agents: {
          defaults: {
            models: {
              "openai/gpt-5.5": {},
              "anthropic/claude-sonnet-4-6": { alias: "sonnet" },
            },
          },
        },
      },
      "2026-07-18T00:00:00.000Z",
      "2026.7.2",
      previous,
    );

    expect(stamped.agents?.defaults?.modelPolicy?.allow).toEqual(["openai/gpt-5.5"]);
    expect(stamped.meta?.migrations?.modelPolicyAllowlist).toBe(true);
  });

  it("does not drop a legacy restriction when the first write removes model metadata", () => {
    const stamped = stampConfigWriteMetadata({}, "2026-07-18T00:00:00.000Z", "2026.7.2", {
      agents: { defaults: { models: { "openai/gpt-5.5": {} } } },
    });

    expect(stamped.agents?.defaults?.modelPolicy?.allow).toEqual(["openai/gpt-5.5"]);
    expect(stamped.meta?.migrations?.modelPolicyAllowlist).toBe(true);
  });

  it("does not materialize per-agent model metadata as policy before stamping", () => {
    const previous = {
      agents: {
        list: [{ id: "worker", models: { "anthropic/claude-sonnet-4-6": {} } }],
      },
    };

    const stamped = stampConfigWriteMetadata(
      previous,
      "2026-07-18T00:00:00.000Z",
      "2026.7.2",
      previous,
    );

    expect(stamped.agents?.list?.[0]?.modelPolicy).toBeUndefined();
    expect(stamped.meta?.migrations?.modelPolicyAllowlist).toBe(true);
  });

  it("keeps per-agent model metadata policy-free when the candidate already has the marker", () => {
    const previous = {
      agents: {
        list: [{ id: "worker", models: { "anthropic/claude-sonnet-4-6": {} } }],
      },
    };

    const stamped = stampConfigWriteMetadata(
      { ...previous, meta: { migrations: { modelPolicyAllowlist: true as const } } },
      "2026-07-18T00:00:00.000Z",
      "2026.7.2",
      previous,
    );

    expect(stamped.agents?.list?.[0]?.modelPolicy).toBeUndefined();
    expect(stamped.meta?.migrations?.modelPolicyAllowlist).toBe(true);
  });

  it("materializes only the default restriction when per-agent metadata is present", () => {
    const previous = {
      agents: {
        defaults: { models: { "openai/gpt-5.5": {} } },
        list: [{ id: "worker", models: { "anthropic/claude-sonnet-4-6": {} } }],
      },
    };

    const stamped = stampConfigWriteMetadata(
      previous,
      "2026-07-18T00:00:00.000Z",
      "2026.7.2",
      previous,
    );

    expect(stamped.agents?.defaults?.modelPolicy?.allow).toEqual(["openai/gpt-5.5"]);
    expect(stamped.agents?.list?.[0]?.modelPolicy).toBeUndefined();
    expect(stamped.meta?.migrations?.modelPolicyAllowlist).toBe(true);
  });

  it("does not widen an explicit per-agent policy with newly added metadata", () => {
    const previous = {
      agents: {
        list: [
          {
            id: "worker",
            models: { "anthropic/claude-sonnet-4-6": {} },
            modelPolicy: { allow: ["anthropic/claude-sonnet-4-6"] },
          },
        ],
      },
    };
    const next = {
      agents: {
        list: [
          {
            id: "worker",
            models: {
              "anthropic/claude-sonnet-4-6": {},
              "openai/gpt-5.5": {},
            },
            modelPolicy: { allow: ["anthropic/claude-sonnet-4-6"] },
          },
        ],
      },
    };

    const stamped = stampConfigWriteMetadata(
      next,
      "2026-07-18T00:00:00.000Z",
      "2026.7.2",
      previous,
    );

    expect(stamped.agents?.list?.[0]?.modelPolicy?.allow).toEqual(["anthropic/claude-sonnet-4-6"]);
    expect(stamped.meta?.migrations?.modelPolicyAllowlist).toBe(true);
  });

  it("marks a replacement agent's new model map as metadata-only", () => {
    const previous = {
      agents: {
        list: [{ id: "legacy", models: { "anthropic/claude-sonnet-4-6": {} } }],
      },
    };
    const next = {
      agents: {
        list: [{ id: "replacement", models: { "openai/gpt-5.5": {} } }],
      },
    };

    const stamped = stampConfigWriteMetadata(
      next,
      "2026-07-18T00:00:00.000Z",
      "2026.7.2",
      previous,
    );

    expect(stamped.agents?.list?.[0]?.modelPolicy).toBeUndefined();
    expect(stamped.meta?.migrations?.modelPolicyAllowlist).toBe(true);
  });

  it("does not trust a candidate marker over an unmarked legacy snapshot", () => {
    const stamped = stampConfigWriteMetadata(
      {
        meta: { migrations: { modelPolicyAllowlist: true } },
        agents: { defaults: { models: { "openai/gpt-5.5": {} } } },
      },
      "2026-07-18T00:00:00.000Z",
      "2026.7.2",
      {
        agents: { defaults: { models: { "anthropic/claude-sonnet-4-6": {} } } },
      },
    );

    expect(stamped.agents?.defaults?.modelPolicy?.allow).toEqual(["anthropic/claude-sonnet-4-6"]);
    expect(stamped.meta?.migrations?.modelPolicyAllowlist).toBe(true);
  });

  it("marks a newly created metadata model map without restricting it", () => {
    const stamped = stampConfigWriteMetadata(
      { agents: { defaults: { models: { "openai/gpt-5.5": {} } } } },
      "2026-07-18T00:00:00.000Z",
      "2026.7.2",
      null,
    );

    expect(stamped.agents?.defaults?.modelPolicy).toBeUndefined();
    expect(stamped.meta?.migrations?.modelPolicyAllowlist).toBe(true);
  });

  it("does not restore a removed allow list after the migration marker exists", () => {
    const stamped = stampConfigWriteMetadata(
      { agents: { defaults: { models: { "openai/gpt-5.5": {} } } } },
      "2026-07-18T00:00:00.000Z",
      "2026.7.2",
      {
        meta: { migrations: { modelPolicyAllowlist: true } },
        agents: {
          defaults: {
            models: { "openai/gpt-5.5": {} },
            modelPolicy: { allow: ["openai/gpt-5.5"] },
          },
        },
      },
    );

    expect(stamped.agents?.defaults?.modelPolicy).toBeUndefined();
    expect(stamped.meta?.migrations?.modelPolicyAllowlist).toBe(true);
  });

  it("does not restore a removed explicit allow list from a pre-marker config", () => {
    const stamped = stampConfigWriteMetadata(
      { agents: { defaults: { models: { "openai/gpt-5.5": {} } } } },
      "2026-07-18T00:00:00.000Z",
      "2026.7.2",
      {
        agents: {
          defaults: {
            models: { "openai/gpt-5.5": {} },
            modelPolicy: { allow: ["openai/gpt-5.5"] },
          },
        },
      },
    );

    expect(stamped.agents?.defaults?.modelPolicy).toBeUndefined();
    expect(stamped.meta?.migrations?.modelPolicyAllowlist).toBe(true);
  });
});
