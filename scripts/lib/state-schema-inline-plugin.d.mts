export const STATE_SCHEMA_INLINE_PLUGIN_NAME: string;

export function createStateSchemaInlinePlugin(rootDir?: string): {
  name: string;
  load(
    this: { addWatchFile(id: string): void },
    id: string,
  ): { code: string; moduleType: "js" } | null;
};
