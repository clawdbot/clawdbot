import { loadBundledPluginPublicArtifactModuleFromCandidatesSync } from "../../plugins/public-surface-loader.js";

// Missing artifacts are optional; errors from resolved artifacts must propagate.
export function loadOptionalBundledChannelPublicArtifact(params: {
  channelId: string;
  artifactBasename: string;
}): object | undefined {
  return (
    loadBundledPluginPublicArtifactModuleFromCandidatesSync({
      dirName: params.channelId.trim(),
      artifactCandidates: [params.artifactBasename],
    }) ?? undefined
  );
}
