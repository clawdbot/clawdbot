export type VercelContainerRegistryPublishPlan = {
  channel: "stable" | "extended-stable" | "beta";
  copies: Array<{ sourceRef: string; targetRef: string; targetTag: string }>;
  readinessTags: string[];
  sourceImage: string;
  targetImage: string;
  version: string;
};

export function createVercelContainerRegistryPublishPlan(params: {
  includeBrowser: boolean;
  version: string;
  sourceImage: string;
  targetImage: string;
}): VercelContainerRegistryPublishPlan;

export function publishVercelContainerRegistryImages(
  params: {
    includeBrowser: boolean;
    version: string;
    sourceImage: string;
    targetImage: string;
  },
  options?: {
    execFileSyncImpl?: (command: string, args: string[], options: object) => unknown;
    log?: (message: string) => void;
  },
): VercelContainerRegistryPublishPlan;
