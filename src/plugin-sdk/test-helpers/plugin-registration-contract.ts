import { describe, expect, it } from "vitest";
import { loadPluginManifestRegistry, pluginRegistrationContractRegistry } from "../testing.js";

type PluginRegistrationContractParams = {
  pluginId: string;
  cliBackendIds?: string[];
  providerIds?: string[];
  webFetchProviderIds?: string[];
  webSearchProviderIds?: string[];
  speechProviderIds?: string[];
  realtimeTranscriptionProviderIds?: string[];
  realtimeVoiceProviderIds?: string[];
  mediaUnderstandingProviderIds?: string[];
  imageGenerationProviderIds?: string[];
  videoGenerationProviderIds?: string[];
  musicGenerationProviderIds?: string[];
  toolNames?: string[];
  requireSpeechVoices?: boolean;
  requireDescribeImages?: boolean;
  requireGenerateImage?: boolean;
  requireGenerateVideo?: boolean;
  manifestAuthChoice?: {
    pluginId: string;
    choiceId: string;
    choiceLabel: string;
    groupId: string;
    groupLabel: string;
    groupHint: string;
  };
};

function findRegistration(pluginId: string) {
  const entry = pluginRegistrationContractRegistry.find(
    (candidate) => candidate.pluginId === pluginId,
  );
  if (!entry) {
    throw new Error(`plugin registration contract missing for ${pluginId}`);
  }
  return entry;
}

export function describePluginRegistrationContract(params: PluginRegistrationContractParams) {
  describe(`${params.pluginId} plugin registration contract`, () => {
    if (params.cliBackendIds) {
      it("keeps bundled cli-backend ownership explicit", () => {
        expect(findRegistration(params.pluginId).cliBackendIds).toEqual(params.cliBackendIds);
      });
    }

    if (params.providerIds) {
      it("keeps bundled provider ownership explicit", () => {
        expect(findRegistration(params.pluginId).providerIds).toEqual(params.providerIds);
      });
    }

    if (params.webSearchProviderIds) {
      it("keeps bundled web search ownership explicit", () => {
        expect(findRegistration(params.pluginId).webSearchProviderIds).toEqual(
          params.webSearchProviderIds,
        );
      });
    }

    if (params.webFetchProviderIds) {
      it("keeps bundled web fetch ownership explicit", () => {
        expect(findRegistration(params.pluginId).webFetchProviderIds).toEqual(
          params.webFetchProviderIds,
        );
      });
    }

    if (params.speechProviderIds) {
      it("keeps bundled speech ownership explicit", () => {
        expect(findRegistration(params.pluginId).speechProviderIds).toEqual(
          params.speechProviderIds,
        );
      });
    }

    if (params.realtimeTranscriptionProviderIds) {
      it("keeps bundled realtime-transcription ownership explicit", () => {
        expect(findRegistration(params.pluginId).realtimeTranscriptionProviderIds).toEqual(
          params.realtimeTranscriptionProviderIds,
        );
      });
    }

    if (params.realtimeVoiceProviderIds) {
      it("keeps bundled realtime-voice ownership explicit", () => {
        expect(findRegistration(params.pluginId).realtimeVoiceProviderIds).toEqual(
          params.realtimeVoiceProviderIds,
        );
      });
    }

    if (params.mediaUnderstandingProviderIds) {
      it("keeps bundled media-understanding ownership explicit", () => {
        expect(findRegistration(params.pluginId).mediaUnderstandingProviderIds).toEqual(
          params.mediaUnderstandingProviderIds,
        );
      });
    }

    if (params.imageGenerationProviderIds) {
      it("keeps bundled image-generation ownership explicit", () => {
        expect(findRegistration(params.pluginId).imageGenerationProviderIds).toEqual(
          params.imageGenerationProviderIds,
        );
      });
    }

    if (params.videoGenerationProviderIds) {
      it("keeps bundled video-generation ownership explicit", () => {
        expect(findRegistration(params.pluginId).videoGenerationProviderIds).toEqual(
          params.videoGenerationProviderIds,
        );
      });
    }

    if (params.musicGenerationProviderIds) {
      it("keeps bundled music-generation ownership explicit", () => {
        expect(findRegistration(params.pluginId).musicGenerationProviderIds).toEqual(
          params.musicGenerationProviderIds,
        );
      });
    }

    if (params.toolNames) {
      it("keeps bundled tool ownership explicit", () => {
        expect(findRegistration(params.pluginId).toolNames).toEqual(params.toolNames);
      });
    }

    const manifestAuthChoice = params.manifestAuthChoice;
    if (manifestAuthChoice) {
      it("keeps onboarding auth grouping explicit", () => {
        const plugin = loadPluginManifestRegistry({}).plugins.find(
          (entry) => entry.origin === "bundled" && entry.id === manifestAuthChoice.pluginId,
        );

        expect(plugin?.providerAuthChoices).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              choiceId: manifestAuthChoice.choiceId,
              choiceLabel: manifestAuthChoice.choiceLabel,
              groupId: manifestAuthChoice.groupId,
              groupLabel: manifestAuthChoice.groupLabel,
              groupHint: manifestAuthChoice.groupHint,
            }),
          ]),
        );
      });
    }
  });
}
