// Manual facade. Keep loader boundary explicit.
type FacadeModule = {
  MINIMAX_DEFAULT_MODEL_ID: string;
  MINIMAX_DEFAULT_MODEL_REF: string;
  MINIMAX_TEXT_MODEL_REFS: readonly string[];
};
import {
  createLazyFacadeArrayValue,
  loadBundledPluginPublicSurfaceModuleSync,
} from "./facade-loader.js";

function loadFacadeModule(): FacadeModule {
  return loadBundledPluginPublicSurfaceModuleSync<FacadeModule>({
    dirName: "minimax",
    artifactBasename: "api.js",
  });
}

/** Default MiniMax text model id exposed by the bundled provider facade. */
export const MINIMAX_DEFAULT_MODEL_ID: FacadeModule["MINIMAX_DEFAULT_MODEL_ID"] =
  loadFacadeModule().MINIMAX_DEFAULT_MODEL_ID;
/** Default MiniMax provider/model reference used by config helpers. */
export const MINIMAX_DEFAULT_MODEL_REF: FacadeModule["MINIMAX_DEFAULT_MODEL_REF"] =
  loadFacadeModule().MINIMAX_DEFAULT_MODEL_REF;
/** MiniMax text model references advertised by the bundled provider facade. */
export const MINIMAX_TEXT_MODEL_REFS: FacadeModule["MINIMAX_TEXT_MODEL_REFS"] =
  createLazyFacadeArrayValue(
    () => loadFacadeModule().MINIMAX_TEXT_MODEL_REFS as unknown as readonly unknown[],
  ) as FacadeModule["MINIMAX_TEXT_MODEL_REFS"];
