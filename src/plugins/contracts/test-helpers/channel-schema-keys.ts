/**
 * Shared JSON-Schema traversal for bundled-channel key contracts.
 *
 * Channel schemas nest documented keys behind `allOf`/`anyOf`/`oneOf`, so every
 * channel-key contract needs the same combinator walk. Two independent
 * evaluators drifted apart once already and disagreed about the same schema, so
 * they now share this one. Combinator semantics are unit-tested by the
 * "schema combinator semantics" suite in channel-health-monitor.contract.test.ts.
 */
export type JsonSchemaLike = {
  properties?: Record<string, unknown>;
  additionalProperties?: unknown;
  anyOf?: unknown[];
  oneOf?: unknown[];
  allOf?: unknown[];
};

export function asChannelSchema(value: unknown): JsonSchemaLike | undefined {
  return value && typeof value === "object" ? (value as JsonSchemaLike) : undefined;
}

/**
 * A closed schema without the key is what makes config loading fail. Some
 * channels (twitch) publish composed alternatives instead of one flat object,
 * so a config is refused only when every alternative refuses the key.
 */
export function channelSchemaRejectsKey(schema: JsonSchemaLike | undefined, key: string): boolean {
  if (!schema) {
    return false;
  }
  // oneOf validates only when exactly one branch matches, so a key two branches
  // both accept is refused at config load even though either branch alone allows
  // it. Collapsing oneOf into anyOf reported that as accepted.
  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    const accepting = schema.oneOf.filter(
      (branch) => !channelSchemaRejectsKey(asChannelSchema(branch), key),
    ).length;
    if (accepting !== 1) {
      return true;
    }
  }
  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    return schema.anyOf.every((branch) => channelSchemaRejectsKey(asChannelSchema(branch), key));
  }
  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    return false;
  }
  // allOf is an intersection: the value must satisfy every component, so one
  // closed component that omits the key still refuses it at config load.
  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    return schema.allOf.some((branch) => channelSchemaRejectsKey(asChannelSchema(branch), key));
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
export function channelPropertySchema(
  schema: JsonSchemaLike | undefined,
  key: string,
): JsonSchemaLike | undefined {
  if (!schema) {
    return undefined;
  }
  const direct = asChannelSchema(schema.properties?.[key]);
  if (direct) {
    return direct;
  }
  for (const branch of [
    ...(schema.anyOf ?? []),
    ...(schema.oneOf ?? []),
    ...(schema.allOf ?? []),
  ]) {
    const nested = channelPropertySchema(asChannelSchema(branch), key);
    if (nested) {
      return nested;
    }
  }
  return undefined;
}

/**
 * Whether the intersection refuses `parentKey.childKey`. Mirrors channelSchemaRejectsKey so
 * every allOf component is evaluated: taking the first component that happens to
 * declare the parent would discard a later closed sibling that refuses the leaf,
 * and the assertion would pass while real config loading fails.
 */
export function channelSchemaRejectsNestedKey(
  schema: JsonSchemaLike | undefined,
  parentKey: string,
  childKey: string,
): boolean {
  if (!schema) {
    return false;
  }
  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    const accepting = schema.oneOf.filter(
      (branch) => !channelSchemaRejectsNestedKey(asChannelSchema(branch), parentKey, childKey),
    ).length;
    if (accepting !== 1) {
      return true;
    }
  }
  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    return schema.anyOf.every((branch) =>
      channelSchemaRejectsNestedKey(asChannelSchema(branch), parentKey, childKey),
    );
  }
  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    return false;
  }
  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    return schema.allOf.some((branch) =>
      channelSchemaRejectsNestedKey(asChannelSchema(branch), parentKey, childKey),
    );
  }
  const parent = asChannelSchema(schema.properties?.[parentKey]);
  if (!parent) {
    // A closed component that omits the parent entirely refuses the leaf too, so
    // treating that as "not rejecting" would leave the contract green while real
    // config loading fails on the parent property.
    return schema.additionalProperties === false;
  }
  return channelSchemaRejectsKey(parent, childKey);
}

/**
 * Account-entry schemas reachable from a channel root.
 *
 * Enumeration, not validation: it collects every account entry a config could
 * land in, so callers iterate. Channels without an `accounts` envelope yield an
 * empty list, so an assertion on a missing envelope is skipped rather than
 * passing vacuously.
 */
export function channelAccountSchemas(schema: JsonSchemaLike | undefined): JsonSchemaLike[] {
  const flatten = (node: JsonSchemaLike | undefined): JsonSchemaLike[] =>
    node
      ? [
          node,
          ...[node.allOf, node.anyOf, node.oneOf]
            .flatMap((variants) => variants ?? [])
            .flatMap((variant) => flatten(asChannelSchema(variant))),
        ]
      : [];
  return flatten(schema).flatMap((root) =>
    flatten(asChannelSchema(root.properties?.accounts)).flatMap((accountsVariant) =>
      flatten(asChannelSchema(accountsVariant.additionalProperties)),
    ),
  );
}
