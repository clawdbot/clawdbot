// Verifies config IO metadata for persisted and generated settings.
import { describe, expect, it } from "vitest";
import { AUTO_MANAGED_CONFIG_META_PATHS, stampConfigWriteMetadata } from "./io.meta.js";
import { computeModelPolicyAllowlist } from "./model-policy-allowlist-migration.js";
import type {
  AgentDefaultsConfig,
  AgentModelEntryConfig,
  AgentModelPolicyConfig,
} from "./types.agent-defaults.js";
import type { AgentConfig } from "./types.agents.js";
import type { OpenClawConfig } from "./types.openclaw.js";
import { validateConfigObjectRaw } from "./validation-core.js";

const models = { "openai/gpt-5.5": {} };
const worker = { id: "worker", models: { "anthropic/claude-sonnet-4-6": {} } };
const marker = { migrations: { modelPolicyAllowlist: true as const } };
const withModels = (
  entries: Record<string, AgentModelEntryConfig>,
  modelPolicy?: AgentModelPolicyConfig,
): OpenClawConfig => ({
  agents: {
    defaults: { models: entries, ...(modelPolicy ? { modelPolicy } : {}) },
    entries: { main: {} },
  },
});
const legacy = withModels(models);
const versionedLegacy = { ...legacy, meta: { lastTouchedVersion: "2026.7.1" } };
const restricted = withModels(models, { allow: Object.keys(models) });
const withAgent = (agent: AgentConfig, defaults: AgentDefaultsConfig = {}): OpenClawConfig => ({
  agents: { defaults, list: [agent] },
});

describe("config write metadata stamping", () => {
  it("stamps every declared auto-managed meta path", () => {
    const stamped = stampConfigWriteMetadata({}, undefined, undefined, {});
    expect(AUTO_MANAGED_CONFIG_META_PATHS).toEqual([
      ["meta", "lastTouchedVersion"],
      ["meta", "migrations", "modelPolicyAllowlist"],
    ]);
    expect(typeof stamped.meta?.lastTouchedVersion).toBe("string");
    expect(stamped.meta?.migrations?.modelPolicyAllowlist).toBe(true);
  });

  const cases: Array<
    [string, OpenClawConfig | null, OpenClawConfig, AgentModelPolicyConfig | undefined]
  > = [
    [
      "preserves a legacy restriction across version updates",
      versionedLegacy,
      versionedLegacy,
      { allow: Object.keys(models) },
    ],
    [
      "does not widen a restriction from added metadata",
      legacy,
      withModels({ ...models, ...worker.models }),
      { allow: Object.keys(models) },
    ],
    [
      "does not drop a restriction when metadata is removed",
      legacy,
      {},
      { allow: Object.keys(models) },
    ],
    [
      "ignores per-agent metadata without default restrictions",
      withAgent(worker),
      withAgent(worker),
      undefined,
    ],
    [
      "keeps marked per-agent metadata policy-free",
      withAgent(worker),
      { ...withAgent(worker), meta: marker },
      undefined,
    ],
    [
      "materializes only the default restriction",
      withAgent(worker, legacy.agents?.defaults),
      withAgent(worker, legacy.agents?.defaults),
      { allow: Object.keys(models) },
    ],
    [
      "marks replacement agent metadata policy-free",
      withAgent(worker),
      { agents: { list: [{ id: "replacement", models }] } },
      undefined,
    ],
    [
      "does not trust a candidate marker",
      withModels(worker.models),
      { ...legacy, meta: marker },
      { allow: Object.keys(worker.models) },
    ],
    ["does not restrict a newly created map", null, legacy, undefined],
    ["does not restore removed marked policy", { ...restricted, meta: marker }, legacy, undefined],
    ["does not restore removed pre-marker policy", restricted, legacy, undefined],
    ...[{}, { allow: [] }].map((policy): (typeof cases)[number] => [
      `honors explicit allow-any ${JSON.stringify(policy)}`,
      legacy,
      withModels(models, policy),
      policy,
    ]),
  ];
  it.each(cases)("%s", (_name, previous, next, policy) => {
    const original = structuredClone({ previous, next });
    const stamped = stampConfigWriteMetadata(
      next,
      "2026-07-18T00:00:00.000Z",
      "2026.7.2",
      previous,
    );
    expect(stamped.agents?.defaults?.modelPolicy).toEqual(policy);
    expect(stamped.agents?.list).toEqual(next.agents?.list);
    expect(stamped.meta?.migrations?.modelPolicyAllowlist).toBe(true);
    expect(stamped.meta?.lastTouchedVersion).toBe("2026.7.2");
    expect({ previous, next }).toEqual(original);
  });

  it("does not widen an explicit per-agent policy with newly added metadata", () => {
    const agent = { ...worker, modelPolicy: { allow: Object.keys(worker.models) } };
    const previous = withAgent(agent);
    const next = withAgent({ ...agent, models: { ...worker.models, ...models } });
    const stamped = stampConfigWriteMetadata(next, undefined, undefined, previous);
    expect(stamped.agents?.list?.[0]?.modelPolicy).toEqual(agent.modelPolicy);
    expect(stamped.meta?.migrations?.modelPolicyAllowlist).toBe(true);
  });

  const validMaps: Array<Record<string, AgentModelEntryConfig>> = [
    { "openai/*": {}, "anthropic/claude-sonnet-4-6": { alias: "sonnet" } },
    { approved: {}, "demo/model": { alias: "approved" }, "demo/namespace/*": {} },
    { "openrouter:auto": {}, "openrouter:free": {} },
  ];
  it.each(validMaps)("preserves valid wildcard, alias and selector refs: %j", (modelMap) => {
    const previous = withModels(modelMap);
    const stamped = stampConfigWriteMetadata(previous, undefined, undefined, previous);
    expect(stamped.agents?.defaults?.modelPolicy?.allow).toEqual(Object.keys(modelMap));
    expect(stamped.meta?.migrations?.modelPolicyAllowlist).toBe(true);
    expect(validateConfigObjectRaw(stamped)).toEqual({ ok: true, config: expect.anything() });
  });

  it.each(["unchanged", "added", "removed", "candidate-marker"])(
    "keeps unresolved legacy semantics on the first %s metadata write",
    (change) => {
      const previous = withModels({ bare: {} });
      const next = withModels(
        change === "removed"
          ? {}
          : change === "added"
            ? { bare: {}, "demo/new": {} }
            : { bare: {} },
      );
      if (change === "candidate-marker") {
        next.meta = marker;
      }
      const stamped = stampConfigWriteMetadata(next, undefined, undefined, previous);
      expect(stamped.agents).toEqual(next.agents);
      expect(stamped.meta?.migrations?.modelPolicyAllowlist).toBeUndefined();
      expect(validateConfigObjectRaw(stamped)).toEqual({ ok: true, config: expect.anything() });
      expect(
        computeModelPolicyAllowlist({ root: stamped, defaults: stamped.agents?.defaults }),
      ).toEqual(change === "removed" ? null : Object.keys(next.agents?.defaults?.models ?? {}));
    },
  );

  it("marks a model-map-free write so later model metadata stays unrestricted", () => {
    const stamped = stampConfigWriteMetadata({}, undefined, undefined, {});
    const edited = { ...stamped, ...legacy };
    expect(stamped.meta?.migrations?.modelPolicyAllowlist).toBe(true);
    expect(
      computeModelPolicyAllowlist({ root: edited, defaults: edited.agents?.defaults }),
    ).toBeNull();
  });
});
