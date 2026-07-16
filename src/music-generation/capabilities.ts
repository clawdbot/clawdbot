// Defines capability checks for music generation providers and models.
import type {
  MusicGenerationEditCapabilities,
  MusicGenerationMode,
  MusicGenerationModeCapabilities,
  MusicGenerationProvider,
} from "./types.js";

/**
 * Capability helpers for music generation providers.
 *
 * Music generation can run as prompt-only generation or image-conditioned edit;
 * these helpers choose the active mode and return the matching capability block.
 */
/** Resolve generation mode from the presence of input images. */
function resolveMusicGenerationMode(params: { inputImageCount?: number }): MusicGenerationMode {
  return (params.inputImageCount ?? 0) > 0 ? "edit" : "generate";
}

/** List modes supported by a provider in stable display order. */
export function listSupportedMusicGenerationModes(
  provider: Pick<MusicGenerationProvider, "capabilities">,
): MusicGenerationMode[] {
  const modes: MusicGenerationMode[] = ["generate"];
  const edit = provider.capabilities.edit;
  if (edit?.enabled) {
    modes.push("edit");
  }
  return modes;
}

/** Resolve the active mode and provider capability contract for one request. */
export function resolveMusicGenerationModeCapabilities(params: {
  provider?: Pick<MusicGenerationProvider, "capabilities">;
  inputImageCount?: number;
}): {
  mode: MusicGenerationMode;
  capabilities: MusicGenerationModeCapabilities | MusicGenerationEditCapabilities | undefined;
} {
  const mode = resolveMusicGenerationMode(params);
  const capabilities = params.provider?.capabilities;
  if (!capabilities) {
    return { mode, capabilities: undefined };
  }
  if (mode === "generate") {
    return {
      mode,
      capabilities: capabilities.generate,
    };
  }
  return {
    mode,
    capabilities: capabilities.edit,
  };
}
