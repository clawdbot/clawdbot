export const STATE_SCHEMA_INLINE_PLUGIN_NAME: string;

export type StateSchemaInlinePluginOptions = {
  vitestFsModuleCache?: boolean;
};

export type VitestCacheKeyGenerator = (context: {
  id: string;
  sourceCode: string;
  environment: unknown;
}) => string | undefined | null | false;

export function createStateSchemaInlinePlugin(
  rootDir?: string,
  options?: StateSchemaInlinePluginOptions,
): {
  name: string;
  load(
    this: { addWatchFile(id: string): void },
    id: string,
  ): { code: string; moduleType: "js" } | null;
  configureVitest?: (context: {
    experimental_defineCacheKeyGenerator(callback: VitestCacheKeyGenerator): void;
  }) => void;
};
