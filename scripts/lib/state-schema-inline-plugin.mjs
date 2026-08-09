import fs from "node:fs";
import path from "node:path";

export const STATE_SCHEMA_INLINE_PLUGIN_NAME = "openclaw:inline-state-schemas";

const STATE_SCHEMA_MODULES = [
  {
    modulePath: "src/state/openclaw-state-schema.ts",
    schemaPath: "src/state/openclaw-state-schema.sql",
    exportName: "OPENCLAW_STATE_SCHEMA_SQL",
  },
  {
    modulePath: "src/state/openclaw-agent-schema.ts",
    schemaPath: "src/state/openclaw-agent-schema.sql",
    exportName: "OPENCLAW_AGENT_SCHEMA_SQL",
  },
];

/** Inline canonical schema bytes so bundled consumers need no SQL asset. */
export function createStateSchemaInlinePlugin(rootDir = process.cwd()) {
  const schemasByModulePath = new Map(
    STATE_SCHEMA_MODULES.map((schema) => [path.resolve(rootDir, schema.modulePath), schema]),
  );

  return {
    name: STATE_SCHEMA_INLINE_PLUGIN_NAME,
    load(id) {
      const schema = schemasByModulePath.get(path.resolve(id));
      if (!schema) {
        return null;
      }
      const schemaPath = path.resolve(rootDir, schema.schemaPath);
      this.addWatchFile(schemaPath);
      return {
        code: `export const ${schema.exportName} = ${JSON.stringify(fs.readFileSync(schemaPath, "utf8"))};\n`,
        moduleType: "js",
      };
    },
  };
}
