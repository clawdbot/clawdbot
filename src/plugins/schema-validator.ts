import AjvPkg, { type ErrorObject, type ValidateFunction } from "ajv";

const ajv = new (AjvPkg as unknown as new (opts?: object) => import("ajv").default)({
  allErrors: true,
  strict: false,
  removeAdditional: false,
});

type CachedValidator = {
  validate: ValidateFunction;
  schema: Record<string, unknown>;
};

const schemaCache = new Map<string, CachedValidator>();

function formatAjvErrors(errors: ErrorObject[] | null | undefined): string[] {
  if (!errors || errors.length === 0) return ["invalid config"];
  return errors.map((error) => {
    const path = error.instancePath?.replace(/^\//, "").replace(/\//g, ".") || "<root>";
    const message = error.message ?? "invalid";
    return `${path}: ${message}`;
  });
}

export function validateJsonSchemaValue(params: {
  schema: Record<string, unknown>;
  cacheKey: string;
  value: unknown;
}): { ok: true } | { ok: false; errors: string[] } {
  let cached = schemaCache.get(params.cacheKey);
  if (!cached || cached.schema !== params.schema) {
    const validate = ajv.compile(params.schema) as ValidateFunction;
    cached = { validate, schema: params.schema };
    schemaCache.set(params.cacheKey, cached);
  }

  const ok = cached.validate(params.value);
  if (ok) return { ok: true };
  return { ok: false, errors: formatAjvErrors(cached.validate.errors) };
}
