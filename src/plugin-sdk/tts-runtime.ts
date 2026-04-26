import {
  createLazyFacadeValue as createLazyFacadeRuntimeValue,
  createLazyFacadeObjectValue,
  loadActivatedBundledPluginPublicSurfaceModuleSync,
} from "./facade-runtime.js";
import type {
  ResolvedTtsConfig,
  ResolvedTtsModelOverrides,
  TtsDirectiveOverrides,
  TtsDirectiveParseResult,
  TtsResult,
  TtsRuntimeFacade,
  TtsSynthesisResult,
  TtsTelephonyResult,
} from "./tts-runtime.types.js";

// Manual facade. Keep loader boundary explicit and avoid typing this public SDK
// seam through the bundled speech-core runtime surface.
type FacadeModule = TtsRuntimeFacade;

function loadFacadeModule(): FacadeModule {
  return loadActivatedBundledPluginPublicSurfaceModuleSync<FacadeModule>({
    dirName: "speech-core",
    artifactBasename: "runtime-api.js",
  });
}

export const _test: FacadeModule["_test"] = createLazyFacadeObjectValue(
  () => loadFacadeModule()._test,
);
export const buildTtsSystemPromptHint: FacadeModule["buildTtsSystemPromptHint"] =
  createLazyFacadeRuntimeValue(loadFacadeModule, "buildTtsSystemPromptHint");
export const getLastTtsAttempt: FacadeModule["getLastTtsAttempt"] = createLazyFacadeRuntimeValue(
  loadFacadeModule,
  "getLastTtsAttempt",
);
export const getResolvedSpeechProviderConfig: FacadeModule["getResolvedSpeechProviderConfig"] =
  createLazyFacadeRuntimeValue(loadFacadeModule, "getResolvedSpeechProviderConfig");
export const getTtsMaxLength: FacadeModule["getTtsMaxLength"] = createLazyFacadeRuntimeValue(
  loadFacadeModule,
  "getTtsMaxLength",
);
export const getTtsPersona: FacadeModule["getTtsPersona"] = createLazyFacadeRuntimeValue(
  loadFacadeModule,
  "getTtsPersona",
);
export const getTtsProvider: FacadeModule["getTtsProvider"] = createLazyFacadeRuntimeValue(
  loadFacadeModule,
  "getTtsProvider",
);
export const isSummarizationEnabled: FacadeModule["isSummarizationEnabled"] =
  createLazyFacadeRuntimeValue(loadFacadeModule, "isSummarizationEnabled");
export const isTtsEnabled: FacadeModule["isTtsEnabled"] = createLazyFacadeRuntimeValue(
  loadFacadeModule,
  "isTtsEnabled",
);
export const isTtsProviderConfigured: FacadeModule["isTtsProviderConfigured"] =
  createLazyFacadeRuntimeValue(loadFacadeModule, "isTtsProviderConfigured");
export const listSpeechVoices: FacadeModule["listSpeechVoices"] = createLazyFacadeRuntimeValue(
  loadFacadeModule,
  "listSpeechVoices",
);
export const listTtsPersonas: FacadeModule["listTtsPersonas"] = createLazyFacadeRuntimeValue(
  loadFacadeModule,
  "listTtsPersonas",
);
export const maybeApplyTtsToPayload: FacadeModule["maybeApplyTtsToPayload"] =
  createLazyFacadeRuntimeValue(loadFacadeModule, "maybeApplyTtsToPayload");
export const resolveExplicitTtsOverrides: FacadeModule["resolveExplicitTtsOverrides"] =
  createLazyFacadeRuntimeValue(loadFacadeModule, "resolveExplicitTtsOverrides");
export const resolveTtsAutoMode: FacadeModule["resolveTtsAutoMode"] = createLazyFacadeRuntimeValue(
  loadFacadeModule,
  "resolveTtsAutoMode",
);
export const resolveTtsConfig: FacadeModule["resolveTtsConfig"] = createLazyFacadeRuntimeValue(
  loadFacadeModule,
  "resolveTtsConfig",
);
export const resolveTtsPrefsPath: FacadeModule["resolveTtsPrefsPath"] =
  createLazyFacadeRuntimeValue(loadFacadeModule, "resolveTtsPrefsPath");
export const resolveTtsProviderOrder: FacadeModule["resolveTtsProviderOrder"] =
  createLazyFacadeRuntimeValue(loadFacadeModule, "resolveTtsProviderOrder");
export const setLastTtsAttempt: FacadeModule["setLastTtsAttempt"] = createLazyFacadeRuntimeValue(
  loadFacadeModule,
  "setLastTtsAttempt",
);
export const setSummarizationEnabled: FacadeModule["setSummarizationEnabled"] =
  createLazyFacadeRuntimeValue(loadFacadeModule, "setSummarizationEnabled");
export const setTtsAutoMode: FacadeModule["setTtsAutoMode"] = createLazyFacadeRuntimeValue(
  loadFacadeModule,
  "setTtsAutoMode",
);
export const setTtsEnabled: FacadeModule["setTtsEnabled"] = createLazyFacadeRuntimeValue(
  loadFacadeModule,
  "setTtsEnabled",
);
export const setTtsMaxLength: FacadeModule["setTtsMaxLength"] = createLazyFacadeRuntimeValue(
  loadFacadeModule,
  "setTtsMaxLength",
);
export const setTtsPersona: FacadeModule["setTtsPersona"] = createLazyFacadeRuntimeValue(
  loadFacadeModule,
  "setTtsPersona",
);
export const setTtsProvider: FacadeModule["setTtsProvider"] = createLazyFacadeRuntimeValue(
  loadFacadeModule,
  "setTtsProvider",
);
export const synthesizeSpeech: FacadeModule["synthesizeSpeech"] = createLazyFacadeRuntimeValue(
  loadFacadeModule,
  "synthesizeSpeech",
);
export const textToSpeech: FacadeModule["textToSpeech"] = createLazyFacadeRuntimeValue(
  loadFacadeModule,
  "textToSpeech",
);
export const textToSpeechTelephony: FacadeModule["textToSpeechTelephony"] =
  createLazyFacadeRuntimeValue(loadFacadeModule, "textToSpeechTelephony");

export type {
  ResolvedTtsConfig,
  ResolvedTtsModelOverrides,
  TtsDirectiveOverrides,
  TtsDirectiveParseResult,
  TtsResult,
  TtsSynthesisResult,
  TtsTelephonyResult,
} from "./tts-runtime.types.js";
