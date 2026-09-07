import { loadBundledPluginPublicArtifactModuleFromCandidatesSync } from "../../plugins/public-surface-loader.js";

// Missing artifacts are optional; errors from resolved artifacts must propagate.
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Dynamic public artifact loaders use caller-supplied module surface types.
export function loadOptionalBundledChannelPublicArtifact<T extends object>(
  channelId: string,
  artifactBasename: string,
): T | undefined {
  return (
    loadBundledPluginPublicArtifactModuleFromCandidatesSync<T>({
      dirName: channelId.trim(),
      artifactCandidates: [artifactBasename],
    }) ?? undefined
  );
}
