import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";

type SchemaNode = {
  $schema?: string;
  $id?: string;
  title?: string;
  description?: string;
  type?: string;
  const?: unknown;
  required?: string[];
  properties?: Record<string, SchemaNode>;
  propertyNames?: SchemaNode;
  additionalProperties?: SchemaNode | boolean;
  items?: SchemaNode;
  oneOf?: SchemaNode[];
  allOf?: SchemaNode[];
  $ref?: string;
  $defs?: Record<string, SchemaNode>;
};

function resolveRef(schema: SchemaNode, ref: string): SchemaNode {
  const match = /^#\/\$defs\/(.+)$/u.exec(ref);
  if (!match || !schema.$defs) {
    throw new Error(`Unresolvable $ref ${ref}`);
  }
  const resolved = schema.$defs[match[1]!];
  if (!resolved) {
    throw new Error(`Missing $def ${match[1]}`);
  }
  return resolved;
}

/** Asserts every key of value has a structural home in the schema node. */
function assertCovered(schema: SchemaNode, value: unknown, path: string, root: SchemaNode): void {
  let node = schema;
  if (node.$ref) {
    node = resolveRef(root, node.$ref);
  }
  if (node.oneOf && typeof value === "object" && value !== null && !Array.isArray(value)) {
    const keys = Object.keys(value);
    const covered = node.oneOf.some((candidate) => {
      const resolved = candidate.$ref ? resolveRef(root, candidate.$ref) : candidate;
      return keys.every((key) => resolved.properties?.[key] !== undefined);
    });
    if (!covered) {
      throw new Error(`${path}: no oneOf branch covers keys ${keys.join(", ")}`);
    }
    return;
  }
  if (node.propertyNames && typeof value === "object" && value !== null && !Array.isArray(value)) {
    for (const key of Object.keys(value)) {
      assertCovered(node.propertyNames, key, `${path}.<key>`, root);
    }
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (node.properties?.[key]) {
        assertCovered(node.properties[key]!, child, `${path}.${key}`, root);
        continue;
      }
      if (node.additionalProperties && typeof node.additionalProperties === "object") {
        assertCovered(node.additionalProperties, child, `${path}.${key}`, root);
        continue;
      }
      throw new Error(`${path}.${key}: no schema property covers this fixture key`);
    }
  }
  if (Array.isArray(value) && node.items) {
    for (const [index, child] of value.entries()) {
      assertCovered(node.items, child, `${path}[${index}]`, root);
    }
  }
}

describe("claw manifest JSON schema", () => {
  it("ships a well-formed draft 2020-12 envelope", async () => {
    const raw = await readFile("src/claws/schema/claw-manifest.schema.json", "utf8");
    const schema = JSON.parse(raw) as SchemaNode;
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.$id).toBe("https://openclaw.ai/schemas/claw-manifest.v1.schema.json");
    expect(schema.title).toBeTruthy();
    expect(schema.type).toBe("object");
    expect(schema.required).toEqual(["schemaVersion", "agent"]);
    expect(schema.properties?.schemaVersion).toEqual({ const: 1 });
    expect(schema.$defs?.openClawProfile).toBeDefined();
  });

  it("structurally covers every shipped manifest fixture", async () => {
    const raw = await readFile("src/claws/schema/claw-manifest.schema.json", "utf8");
    const schema = JSON.parse(raw) as SchemaNode;
    for (const fixture of [
      "src/claws/fixtures/minimal-agent.claw.json",
      "src/claws/fixtures/incident-response.claw.json",
      "src/claws/fixtures/workspace-agent.claw.json",
    ]) {
      const value = JSON.parse(await readFile(fixture, "utf8")) as unknown;
      expect(() => assertCovered(schema, value, fixture, schema)).not.toThrow();
    }
  });

  it("structurally covers the shipped openclaw profile", async () => {
    const raw = await readFile("src/claws/schema/claw-manifest.schema.json", "utf8");
    const schema = JSON.parse(raw) as SchemaNode;
    const profileYaml = await readFile(
      "src/claws/fixtures/profiles/incident-response.openclaw.yml",
      "utf8",
    );
    const profile = parseDocument(profileYaml).toJS() as unknown;
    const profileSchema = schema.$defs?.openClawProfile;
    if (!profileSchema) {
      throw new Error("missing openClawProfile $def");
    }
    expect(() => assertCovered(profileSchema, profile, "openclaw.yml", schema)).not.toThrow();
  });
});
