// Verifies channels documented as exposing health-monitor overrides accept the key.
import { describe, expect, it } from "vitest";
import { GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA } from "../../config/bundled-channel-config-metadata.generated.js";
import { validateJsonSchemaValue } from "../schema-validator.js";

/**
 * The channels docs/gateway/health.md lists as exposing the per-channel
 * health-monitor override. The gateway supervisor reads the key for every
 * started account, so rejecting it refuses the whole config.
 */
const HEALTH_MONITOR_CHANNELS = [
  "discord",
  "googlechat",
  "imessage",
  "irc",
  "msteams",
  "signal",
  "slack",
  "telegram",
  "whatsapp",
] as const;

type JsonSchemaLike = {
  properties?: Record<string, unknown>;
  additionalProperties?: unknown;
  anyOf?: unknown[];
  oneOf?: unknown[];
  allOf?: unknown[];
};

function asSchema(value: unknown): JsonSchemaLike | undefined {
  return value && typeof value === "object" ? (value as JsonSchemaLike) : undefined;
}

/**
 * A closed schema without the key is what makes config loading fail. Some
 * channels (twitch) publish composed alternatives instead of one flat object,
 * so a config is refused only when every alternative refuses the key.
 */
function rejectsKey(schema: JsonSchemaLike | undefined, key: string): boolean {
  if (!schema) {
    return false;
  }
  // oneOf validates only when exactly one branch matches, so a key two branches
  // both accept is refused at config load even though either branch alone allows
  // it. Collapsing oneOf into anyOf reported that as accepted.
  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    const accepting = schema.oneOf.filter((branch) => !rejectsKey(asSchema(branch), key)).length;
    if (accepting !== 1) {
      return true;
    }
  }
  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    return schema.anyOf.every((branch) => rejectsKey(asSchema(branch), key));
  }
  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    return false;
  }
  // allOf is an intersection: the value must satisfy every component, so one
  // closed component that omits the key still refuses it at config load.
  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    return schema.allOf.some((branch) => rejectsKey(asSchema(branch), key));
  }
  if (schema.additionalProperties !== false) {
    return false;
  }
  return !Object.hasOwn(schema.properties ?? {}, key);
}

/**
 * Resolves a property's sub-schema across composed alternatives. The parent key
 * existing is not the documented contract; `healthMonitor.enabled` is, and a
 * strict empty object would satisfy the parent check while refusing that leaf.
 */
function propertySchema(
  schema: JsonSchemaLike | undefined,
  key: string,
): JsonSchemaLike | undefined {
  if (!schema) {
    return undefined;
  }
  const direct = asSchema(schema.properties?.[key]);
  if (direct) {
    return direct;
  }
  for (const branch of [
    ...(schema.anyOf ?? []),
    ...(schema.oneOf ?? []),
    ...(schema.allOf ?? []),
  ]) {
    const nested = propertySchema(asSchema(branch), key);
    if (nested) {
      return nested;
    }
  }
  return undefined;
}

/**
 * Whether the intersection refuses `parentKey.childKey`. Mirrors rejectsKey so
 * every allOf component is evaluated: taking the first component that happens to
 * declare the parent would discard a later closed sibling that refuses the leaf,
 * and the assertion would pass while real config loading fails.
 */
function rejectsNestedKey(
  schema: JsonSchemaLike | undefined,
  parentKey: string,
  childKey: string,
): boolean {
  if (!schema) {
    return false;
  }
  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    const accepting = schema.oneOf.filter(
      (branch) => !rejectsNestedKey(asSchema(branch), parentKey, childKey),
    ).length;
    if (accepting !== 1) {
      return true;
    }
  }
  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    return schema.anyOf.every((branch) => rejectsNestedKey(asSchema(branch), parentKey, childKey));
  }
  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    return false;
  }
  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    return schema.allOf.some((branch) => rejectsNestedKey(asSchema(branch), parentKey, childKey));
  }
  const parent = asSchema(schema.properties?.[parentKey]);
  if (!parent) {
    // A closed component that omits the parent entirely refuses the leaf too, so
    // treating that as "not rejecting" would leave the contract green while real
    // config loading fails on the parent property.
    return schema.additionalProperties === false;
  }
  return rejectsKey(parent, childKey);
}

/**
 * Validates the documented `{ healthMonitor: { enabled: false } }` override
 * against the generated schema. Presence checks alone would pass on a leaf typed
 * as something other than boolean, which real config loading would refuse.
 */
/**
 * Whether the composed schema accepts the documented `{ enabled: false }`.
 *
 * Mirrors the combinators `rejectsKey` uses, because the same composition rules
 * apply to values: `anyOf`/`oneOf` need one accepting branch, `allOf` needs every
 * component to accept. Flattening them together over-rejects a valid union, and
 * taking the first match under-rejects a conflicting intersection.
 */
function acceptsDocumentedOverride(
  schema: JsonSchemaLike | undefined,
  cacheKey: string,
  depth = 0,
): boolean {
  if (!schema) {
    return false;
  }
  // Exactly-one counting belongs in the key helpers, not here. This probe returns a
  // vacuous true for a component that says nothing about the leaf, so counting those
  // trues would treat "constrains nothing" as a matching oneOf branch. Whether a
  // oneOf is satisfiable at all is rejectsKey/rejectsNestedKey's question.
  const alternatives = [...(schema.anyOf ?? []), ...(schema.oneOf ?? [])];
  if (alternatives.length > 0) {
    return alternatives.some((branch, index) =>
      acceptsDocumentedOverride(asSchema(branch), `${cacheKey}.any${depth}_${index}`, depth + 1),
    );
  }
  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    return schema.allOf.every((branch, index) =>
      acceptsDocumentedOverride(asSchema(branch), `${cacheKey}.all${depth}_${index}`, depth + 1),
    );
  }
  const healthMonitor = asSchema(schema.properties?.healthMonitor);
  if (!healthMonitor) {
    // This component says nothing about the leaf, so it constrains nothing here.
    // Whether an omission refuses the parent is the key question, which
    // `rejectsNestedKey` already owns.
    return true;
  }
  // Validate the sub-schema rather than the channel object: a channel schema has
  // its own required credentials, so a partial object would fail for unrelated
  // reasons.
  return validateJsonSchemaValue({
    cacheKey: `health-monitor-contract.${cacheKey}`,
    schema: healthMonitor as Parameters<typeof validateJsonSchemaValue>[0]["schema"],
    value: { enabled: false },
    cache: false,
  }).ok;
}

function schemaFor(channelId: string): JsonSchemaLike | undefined {
  return asSchema(
    GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA.find((entry) => entry.channelId === channelId)
      ?.schema,
  );
}

describe("channel healthMonitor contract", () => {
  it("treats a closed allOf sibling as refusing the healthMonitor leaf", () => {
    // The shape that used to slip through: one component declares the leaf while a
    // closed sibling omits it, so config loading refuses `healthMonitor.enabled`
    // even though a first-match lookup finds an accepting schema.
    const composed: JsonSchemaLike = {
      allOf: [
        {
          properties: {
            healthMonitor: { properties: { enabled: {} }, additionalProperties: false },
          },
          additionalProperties: false,
        },
        {
          properties: { healthMonitor: { properties: {}, additionalProperties: false } },
          additionalProperties: false,
        },
      ],
    };

    expect(propertySchema(composed, "healthMonitor")).toBeDefined();
    expect(rejectsNestedKey(composed, "healthMonitor", "enabled")).toBe(true);
  });

  it("accepts the documented value when one union branch allows it", () => {
    // anyOf needs a single matching branch, so a boolean branch beside one that
    // refuses booleans still loads. Requiring every branch would fail a valid
    // union and report a working config as broken.
    const union: JsonSchemaLike = {
      anyOf: [
        {
          properties: {
            healthMonitor: {
              type: "object",
              properties: { enabled: { type: "boolean" } },
              additionalProperties: false,
            },
          },
          additionalProperties: false,
        },
        {
          properties: {
            healthMonitor: {
              type: "object",
              properties: { enabled: { type: "string" } },
              additionalProperties: false,
            },
          },
          additionalProperties: false,
        },
      ],
    };

    expect(acceptsDocumentedOverride(union, "union-branches")).toBe(true);
  });

  it("rejects the documented value when a sibling branch types the leaf differently", () => {
    // allOf is an intersection, so a second branch that requires a string for
    // `enabled` refuses the documented boolean even though the first branch
    // accepts it. Taking the first matching branch would report acceptance.
    const conflicting: JsonSchemaLike = {
      allOf: [
        {
          properties: {
            healthMonitor: {
              type: "object",
              properties: { enabled: { type: "boolean" } },
              additionalProperties: false,
            },
          },
          additionalProperties: false,
        },
        {
          properties: {
            healthMonitor: {
              type: "object",
              properties: { enabled: { type: "string" } },
              additionalProperties: false,
            },
          },
          additionalProperties: false,
        },
      ],
    };

    // Key presence alone still reports the leaf as accepted, which is why the
    // value check has to look at every branch.
    expect(rejectsNestedKey(conflicting, "healthMonitor", "enabled")).toBe(false);
    expect(acceptsDocumentedOverride(conflicting, "conflicting-branches")).toBe(false);
  });

  it("treats a closed sibling that omits the parent as refusing the leaf", () => {
    // The remaining hole: the sibling does not declare `healthMonitor` at all.
    // Real validation refuses the parent property, so reporting "not rejected"
    // here would keep the contract green on a schema that cannot load.
    const composed: JsonSchemaLike = {
      allOf: [
        {
          properties: {
            healthMonitor: { properties: { enabled: {} }, additionalProperties: false },
          },
          additionalProperties: false,
        },
        { properties: { other: {} }, additionalProperties: false },
      ],
    };

    expect(rejectsNestedKey(composed, "healthMonitor", "enabled")).toBe(true);
    // An open sibling that omits the parent adds no restriction.
    const permissive: JsonSchemaLike = {
      allOf: [
        {
          properties: {
            healthMonitor: { properties: { enabled: {} }, additionalProperties: false },
          },
          additionalProperties: false,
        },
        { properties: { other: {} } },
      ],
    };
    expect(rejectsNestedKey(permissive, "healthMonitor", "enabled")).toBe(false);
  });

  it.each(HEALTH_MONITOR_CHANNELS)("%s accepts channels.<id>.healthMonitor", (channelId) => {
    expect(rejectsKey(schemaFor(channelId), "healthMonitor")).toBe(false);
  });

  it.each(HEALTH_MONITOR_CHANNELS)(
    "%s accepts channels.<id>.accounts.<account>.healthMonitor",
    (channelId) => {
      const accounts = asSchema(schemaFor(channelId)?.properties?.accounts);
      expect(rejectsKey(asSchema(accounts?.additionalProperties), "healthMonitor")).toBe(false);
    },
  );

  it.each(HEALTH_MONITOR_CHANNELS)(
    "%s accepts the documented channels.<id>.healthMonitor.enabled leaf",
    (channelId) => {
      const healthMonitor = propertySchema(schemaFor(channelId), "healthMonitor");
      expect(healthMonitor, `${channelId} exposes no healthMonitor schema`).toBeDefined();
      expect(rejectsNestedKey(schemaFor(channelId), "healthMonitor", "enabled")).toBe(false);
      // Structural presence is not the contract: a leaf typed as string would
      // satisfy the checks above while refusing the documented boolean.
      expect(acceptsDocumentedOverride(schemaFor(channelId), `${channelId}.root`)).toBe(true);
    },
  );

  it.each(HEALTH_MONITOR_CHANNELS)(
    "%s accepts the documented accounts.<account>.healthMonitor.enabled leaf",
    (channelId) => {
      const accounts = asSchema(schemaFor(channelId)?.properties?.accounts);
      const accountEntry = asSchema(accounts?.additionalProperties);
      if (!accountEntry) {
        // Single-account channels publish no accounts envelope; the channel-scope
        // assertion above already covers the documented override for them.
        return;
      }
      const healthMonitor = propertySchema(accountEntry, "healthMonitor");
      expect(healthMonitor, `${channelId} account entry exposes no healthMonitor`).toBeDefined();
      expect(rejectsNestedKey(accountEntry, "healthMonitor", "enabled")).toBe(false);
      expect(acceptsDocumentedOverride(accountEntry, `${channelId}.account`)).toBe(true);
    },
  );
});

describe("schema combinator semantics", () => {
  // A closed object that accepts healthMonitor.enabled.
  const acceptingBranch = {
    type: "object",
    additionalProperties: false,
    properties: {
      healthMonitor: {
        type: "object",
        additionalProperties: false,
        properties: { enabled: { type: "boolean" } },
      },
    },
  };

  it("treats a oneOf matched by two branches as refused", () => {
    // oneOf validates only when exactly one branch matches, so config load
    // rejects this even though either branch alone would accept the key.
    const schema = { oneOf: [acceptingBranch, acceptingBranch] } as JsonSchemaLike;

    expect(rejectsKey(schema, "healthMonitor")).toBe(true);
    expect(rejectsNestedKey(schema, "healthMonitor", "enabled")).toBe(true);
  });

  it("keeps a oneOf matched by exactly one branch accepted", () => {
    const closedWithoutKey = { type: "object", additionalProperties: false, properties: {} };
    const schema = { oneOf: [acceptingBranch, closedWithoutKey] } as JsonSchemaLike;

    expect(rejectsKey(schema, "healthMonitor")).toBe(false);
    expect(rejectsNestedKey(schema, "healthMonitor", "enabled")).toBe(false);
  });

  it("keeps anyOf accepting when any branch accepts", () => {
    const closedWithoutKey = { type: "object", additionalProperties: false, properties: {} };
    const schema = {
      anyOf: [acceptingBranch, acceptingBranch, closedWithoutKey],
    } as JsonSchemaLike;

    expect(rejectsKey(schema, "healthMonitor")).toBe(false);
    expect(acceptsDocumentedOverride(schema, "multi-branch-anyOf")).toBe(true);
  });
});
