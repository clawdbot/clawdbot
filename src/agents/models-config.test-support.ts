import "./models-config.js";

type ModelsConfigTestApi = {
  ensureModelsFileModeForModelsJson(pathname: string): Promise<void>;
  writeModelsFileAtomicForModelsJson(targetPath: string, contents: string): Promise<void>;
};

function getTestApi(): ModelsConfigTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.modelsConfigTestApi")
  ] as ModelsConfigTestApi;
}

export const ensureModelsFileModeForModelsJson = async (pathname: string): Promise<void> =>
  await getTestApi().ensureModelsFileModeForModelsJson(pathname);

export const writeModelsFileAtomicForModelsJson = async (
  targetPath: string,
  contents: string,
): Promise<void> => await getTestApi().writeModelsFileAtomicForModelsJson(targetPath, contents);
