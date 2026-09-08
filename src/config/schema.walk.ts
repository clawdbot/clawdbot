import { z } from "zod";

/** Visit schema wrappers and their fields in config path order, preserving array/wildcard paths. */
export function walkConfigSchema(
  schema: z.ZodType,
  path: string,
  visit: (schema: z.ZodType, path: string) => void,
): void {
  const walk = (node: z.core.$ZodType, fieldPath: string): void => {
    let current = node;
    while (true) {
      // SAFETY: Config trees use classic Zod; its child generics expose only the core type.
      visit(current as z.ZodType, fieldPath);
      if (!isUnwrappable(current)) {
        break;
      }
      current = current.unwrap();
    }

    if (current instanceof z.ZodPipe) {
      // Config projections follow parsed output, including preprocess pipelines.
      walk(current.out, fieldPath);
    } else if (current instanceof z.ZodObject) {
      for (const key in current.shape) {
        walk(current.shape[key], fieldPath ? `${fieldPath}.${key}` : key);
      }
      const catchall = current.def.catchall;
      if (catchall && !(catchall instanceof z.ZodNever)) {
        walk(catchall, fieldPath ? `${fieldPath}.*` : "*");
      }
    } else if (current instanceof z.ZodArray) {
      walk(current.element, fieldPath ? `${fieldPath}[]` : "[]");
    } else if (current instanceof z.ZodRecord) {
      walk(current.def.valueType, fieldPath ? `${fieldPath}.*` : "*");
    } else if (current instanceof z.ZodUnion) {
      for (const option of current.options) {
        walk(option, fieldPath);
      }
    } else if (current instanceof z.ZodIntersection) {
      walk(current.def.left, fieldPath);
      walk(current.def.right, fieldPath);
    }
  };
  walk(schema, path);
}

function isUnwrappable(
  schema: z.core.$ZodType,
): schema is z.core.$ZodType & { unwrap: () => z.core.$ZodType } {
  // Arrays also expose unwrap(), but introduce a path segment before visiting their element.
  return (
    "unwrap" in schema && typeof schema.unwrap === "function" && !(schema instanceof z.ZodArray)
  );
}
