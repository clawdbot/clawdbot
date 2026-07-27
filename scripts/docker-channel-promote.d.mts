import type { DockerReleaseChannel } from "./lib/docker-release-policy.mjs";

export type DockerChannelPromotion = {
  image: string;
  sourceRef: string;
  targetRefs: string[];
};

export type DockerChannelPromotionPlan = {
  channel: DockerReleaseChannel;
  promotions: DockerChannelPromotion[];
  version: string;
};

export function createDockerChannelPromotionPlan(params: {
  version: string;
  images: string[];
}): DockerChannelPromotionPlan;

export function promoteDockerChannel(
  params: { version: string; images: string[] },
  options?: {
    allowRollback?: boolean;
    execFileSyncImpl?: (command: string, args: string[], options: object) => string;
    log?: (message: string) => void;
    verifyAttestationsImpl?: (params: {
      imageRefs: string[];
      requiredPlatforms: Array<{
        architecture: string;
        os: string;
        variant?: string;
      }>;
      execFileSyncImpl: (command: string, args: string[], options: object) => string;
      log: (message: string) => void;
    }) => void;
  },
): DockerChannelPromotionPlan;
