import { describe, expect, it } from "vitest";
import { z } from "zod";
import { projectConfigFieldMetadata } from "./schema.field-metadata.js";
import { configUiMetadata } from "./zod-schema.sensitive.js";

describe("schema-owned config field documentation", () => {
  it("discovers nested fields and preserves outer documentation overrides", () => {
    const field = z.string().register(configUiMetadata, { label: "Field", help: "Shared help" });
    const schema = z.object({
      undocumented: z.boolean(),
      direct: field.optional().register(configUiMetadata, { help: "Direct field help" }),
      list: z.array(field),
      dictionary: z.record(z.string(), z.object({ value: field })),
      catchall: z.object({}).catchall(field),
      deferred: z.lazy(() => z.object({ value: field })),
      variants: z.union([z.object({ first: field }), z.object({ second: field })]),
      merged: z.object({ left: field }).and(z.object({ right: field })),
      preprocessed: z.preprocess((value) => value, z.object({ value: field })),
    });

    expect(projectConfigFieldMetadata(schema, "example")).toEqual({
      labels: {
        "example.direct": "Field",
        "example.list[]": "Field",
        "example.dictionary.*.value": "Field",
        "example.catchall.*": "Field",
        "example.deferred.value": "Field",
        "example.variants.first": "Field",
        "example.variants.second": "Field",
        "example.merged.left": "Field",
        "example.merged.right": "Field",
        "example.preprocessed.value": "Field",
      },
      help: {
        "example.direct": "Direct field help",
        "example.list[]": "Shared help",
        "example.dictionary.*.value": "Shared help",
        "example.catchall.*": "Shared help",
        "example.deferred.value": "Shared help",
        "example.variants.first": "Shared help",
        "example.variants.second": "Shared help",
        "example.merged.left": "Shared help",
        "example.merged.right": "Shared help",
        "example.preprocessed.value": "Shared help",
      },
    });
  });
});
