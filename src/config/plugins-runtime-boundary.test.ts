// Verifies config code does not cross plugin runtime boundaries.
import { describe, expect, it } from "vitest";
import { FIELD_HELP } from "./schema.help.js";
import { FIELD_LABELS } from "./schema.labels.js";
import { OpenClawSchema } from "./zod-schema.js";

function hasLegacyPluginsRuntimeKeys(keys: string[]): boolean {
  return keys.some((key) => key === "plugins.runtime" || key.startsWith("plugins.runtime."));
}

describe("plugins runtime boundary config", () => {
  it("omits legacy plugins.runtime keys from schema metadata", () => {
    expect(hasLegacyPluginsRuntimeKeys(Object.keys(FIELD_HELP))).toBe(false);
    expect(hasLegacyPluginsRuntimeKeys(Object.keys(FIELD_LABELS))).toBe(false);
  });

  it("omits plugins.runtime from the generated config schema", () => {
    const schema = OpenClawSchema.toJSONSchema({
      target: "draft-7",
      io: "input",
      reused: "ref",
    }) as {
      properties?: Record<string, { properties?: Record<string, unknown> }>;
    };
    const pluginsProperties = schema.properties?.plugins?.properties ?? {};
    expect("runtime" in pluginsProperties).toBe(false);
  });

  it("rejects legacy plugins.runtime config entries", () => {
    const result = OpenClawSchema.safeParse({
      plugins: {
        runtime: {
          allowLegacyExec: true,
        },
      },
    });
    expect(result.success).toBe(false);
  });
});
