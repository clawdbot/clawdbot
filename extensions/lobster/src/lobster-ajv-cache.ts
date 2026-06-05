// Lobster plugin module implements lobster ajv cache behavior.
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const installedSymbol = Symbol.for("openclaw.lobster.ajv-compile-cache.installed");
const cacheSymbol = Symbol.for("openclaw.lobster.ajv-compile-cache.entries");
const maxEntries = 512;

type ValidateFunction = (value: unknown) => boolean;
type AjvInstance = {
  compile: (schema: unknown) => ValidateFunction;
  removeSchema: (schemaKeyRef?: unknown) => AjvInstance;
};
type AjvConstructor = {
  new (opts?: object): AjvInstance;
  prototype: AjvInstance;
};
type AjvWithCompileCache = AjvInstance & {
  [cacheSymbol]?: Map<string, CompileCacheEntry>;
};
type AjvPrototypePatch = AjvInstance & {
  [installedSymbol]?: boolean;
};
type CompileCacheEntry = {
  schema: unknown;
  validate: ValidateFunction;
};

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
  removeSchema: AjvInstance["removeSchema"];
  schema: unknown;
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

async function resolveLobsterAjvConstructor(packageEntryPath: string): Promise<AjvConstructor> {
  const lobsterRequire = createRequire(packageEntryPath);
  const ajvPath = lobsterRequire.resolve("ajv");
  const ajvModule = (await import(pathToFileURL(ajvPath).href)) as { default?: unknown };
  return (ajvModule.default ?? ajvModule) as AjvConstructor;
}

export async function installLobsterAjvCompileCache(packageEntryPath: string) {
  let AjvCtor: AjvConstructor;
  try {
    AjvCtor = await resolveLobsterAjvConstructor(packageEntryPath);
  } catch {
    return;
  }
  const proto = AjvCtor.prototype as AjvPrototypePatch;
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
    schema: unknown,
  ): ValidateFunction {
    const key = compileCacheKey(schema);
    if (!key) {
      return originalCompile.call(this, schema);
    }
    const cache = readCompileCache(this);
    const cached = cache.get(key);
    if (cached) {
      return cached.validate;
    }
    const validate = originalCompile.call(this, schema);
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
    schemaKeyRef?: unknown,
  ) {
    this[cacheSymbol]?.clear();
    return originalRemoveSchema.call(this, schemaKeyRef);
  };
}
