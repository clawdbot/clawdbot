import { createHash } from "node:crypto";
import AjvPkg, { type AnySchema, type ValidateFunction } from "ajv";

const installedSymbol = Symbol.for("openclaw.lobster.ajv-compile-cache.installed");
const cacheSymbol = Symbol.for("openclaw.lobster.ajv-compile-cache.entries");
const maxEntries = 512;

type AjvInstance = import("ajv").default;

type CompileCacheEntry = {
  schema: AnySchema;
  validate: ValidateFunction;
};

const AjvCtor = AjvPkg as unknown as {
  new (opts?: object): AjvInstance;
  prototype: AjvInstance;
};

type AjvWithCompileCache = AjvInstance & {
  [cacheSymbol]?: Map<string, CompileCacheEntry>;
};

type AjvPrototypePatch = {
  [installedSymbol]?: boolean;
  compile: (schema: AnySchema) => ValidateFunction;
  removeSchema: (schemaKeyRef?: Parameters<AjvInstance["removeSchema"]>[0]) => AjvInstance;
};

type JsonLike = null | boolean | number | string | JsonLike[] | { [key: string]: JsonLike };

function stableJsonStringify(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (seen.has(value)) {
    throw new TypeError("Cannot cache cyclic JSON schema");
  }
  seen.add(value);
  if (Array.isArray(value)) {
    const items = value.map((entry) => stableJsonStringify(entry, seen));
    seen.delete(value);
    return `[${items.join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).toSorted();
  const properties = keys
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableJsonStringify(record[key], seen)}`);
  seen.delete(value);
  return `{${properties.join(",")}}`;
}

function compileCacheKey(schema: unknown): string | null {
  try {
    return createHash("sha256").update(stableJsonStringify(schema)).digest("hex");
  } catch {
    return null;
  }
}

function readCompileCache(instance: AjvWithCompileCache): Map<string, CompileCacheEntry> {
  let cache = instance[cacheSymbol];
  if (!cache) {
    cache = new Map<string, CompileCacheEntry>();
    Object.defineProperty(instance, cacheSymbol, {
      value: cache,
      configurable: true,
    });
  }
  return cache;
}

function rememberCompiledValidator(params: {
  cache: Map<string, CompileCacheEntry>;
  instance: AjvWithCompileCache;
  key: string;
  removeSchema: AjvPrototypePatch["removeSchema"];
  schema: AnySchema;
  validate: ValidateFunction;
}) {
  const { cache, instance, key, removeSchema, schema, validate } = params;
  if (!cache.has(key) && cache.size >= maxEntries) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) {
      const evicted = cache.get(oldest);
      cache.delete(oldest);
      if (evicted) {
        removeSchema.call(instance, evicted.schema);
      }
    }
  }
  cache.set(key, { schema, validate });
}

export function installLobsterAjvCompileCache() {
  const proto = AjvCtor.prototype as unknown as AjvPrototypePatch;
  if (proto[installedSymbol]) {
    return;
  }

  const originalCompile = proto.compile;
  const originalRemoveSchema = proto.removeSchema;

  Object.defineProperty(proto, installedSymbol, {
    value: true,
    configurable: true,
  });

  proto.compile = function compileWithContentCache(
    this: AjvWithCompileCache,
    schema: AnySchema,
  ): ValidateFunction<JsonLike> {
    const key = compileCacheKey(schema);
    if (!key) {
      return originalCompile.call(this, schema) as ValidateFunction<JsonLike>;
    }
    const cache = readCompileCache(this);
    const cached = cache.get(key);
    if (cached) {
      return cached.validate as ValidateFunction<JsonLike>;
    }
    const validate = originalCompile.call(this, schema) as ValidateFunction<JsonLike>;
    rememberCompiledValidator({
      cache,
      instance: this,
      key,
      removeSchema: originalRemoveSchema,
      schema,
      validate,
    });
    return validate;
  };

  proto.removeSchema = function removeSchemaAndClearContentCache(
    this: AjvWithCompileCache,
    schemaKeyRef?: Parameters<AjvInstance["removeSchema"]>[0],
  ) {
    this[cacheSymbol]?.clear();
    return originalRemoveSchema.call(this, schemaKeyRef);
  };
}
