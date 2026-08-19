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
] as const;

/** Inline canonical schema bytes so bundled consumers need no SQL asset. */
export function createStateSchemaInlinePlugin(rootDir = process.cwd()) {
  const schemasByModulePath = new Map(
    STATE_SCHEMA_MODULES.map((schema) => [path.resolve(rootDir, schema.modulePath), schema]),
  );
  const cacheKeyForSchema = ({ id }: { id: string }) => {
    const schema = schemasByModulePath.get(path.resolve(id));
    return schema ? fs.readFileSync(path.resolve(rootDir, schema.schemaPath), "utf8") : undefined;
  };

  return {
    name: STATE_SCHEMA_INLINE_PLUGIN_NAME,
    configureVitest(context: {
      experimental_defineCacheKeyGenerator(callback: typeof cacheKeyForSchema): void;
    }) {
      context.experimental_defineCacheKeyGenerator(cacheKeyForSchema);
    },
    load(this: { addWatchFile(id: string): void }, id: string) {
      const schema = schemasByModulePath.get(path.resolve(id));
      if (!schema) {
        return null;
      }
      const schemaPath = path.resolve(rootDir, schema.schemaPath);
      this.addWatchFile(schemaPath);
      return {
        code: `export const ${schema.exportName} = ${JSON.stringify(fs.readFileSync(schemaPath, "utf8"))};\n`,
        moduleType: "js" as const,
      };
    },
  };
}
