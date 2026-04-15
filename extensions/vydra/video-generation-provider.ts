import { isProviderApiKeyConfigured } from "openclaw/plugin-sdk/provider-auth";
import {
  assertOkOrThrowHttpError,
  createProviderOperationDeadline,
  postJsonRequest,
  resolveProviderOperationTimeoutMs,
} from "openclaw/plugin-sdk/provider-http";
import type { VideoGenerationProvider } from "openclaw/plugin-sdk/video-generation";
import {
  DEFAULT_VYDRA_VIDEO_MODEL,
  downloadVydraAsset,
  extractVydraResultUrls,
  resolveCompletedVydraPayload,
  resolveVydraResponseJobId,
  resolveVydraResponseStatus,
  resolveVydraRequestContext,
} from "./shared.js";

const VYDRA_KLING_MODEL = "kling";

function resolveVydraVideoRequestBody(
  req: Parameters<VideoGenerationProvider["generateVideo"]>[0],
) {
  const model = req.model?.trim() || DEFAULT_VYDRA_VIDEO_MODEL;
  if (model === VYDRA_KLING_MODEL) {
    const input = req.inputImages?.[0];
    const imageUrl = input?.url?.trim();
    if (!imageUrl) {
      throw new Error("Vydra kling currently requires a remote image URL reference.");
    }
    return {
      model,
      body: {
        prompt: req.prompt,
        // Vydra's kling route has been inconsistent about which field it requires.
        image_url: imageUrl,
        video_url: imageUrl,
      },
    };
  }
  if ((req.inputImages?.length ?? 0) > 0) {
    throw new Error(
      `Vydra ${model} does not support image reference inputs in the bundled plugin.`,
    );
  }
  return {
    model,
    body: {
      prompt: req.prompt,
    },
  };
}

export function buildVydraVideoGenerationProvider(): VideoGenerationProvider {
  return {
    id: "vydra",
    label: "Vydra",
    defaultModel: DEFAULT_VYDRA_VIDEO_MODEL,
    models: [DEFAULT_VYDRA_VIDEO_MODEL, VYDRA_KLING_MODEL],
    isConfigured: ({ agentDir }) =>
      isProviderApiKeyConfigured({
        provider: "vydra",
        agentDir,
      }),
    capabilities: {
      generate: {
        maxVideos: 1,
      },
      imageToVideo: {
        enabled: true,
        maxVideos: 1,
        maxInputImages: 1,
      },
      videoToVideo: {
        enabled: false,
      },
    },
    async generateVideo(req) {
      if ((req.inputVideos?.length ?? 0) > 0) {
        throw new Error("Vydra video generation does not support video reference inputs.");
      }

      const { fetchFn, baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
        await resolveVydraRequestContext({
          cfg: req.cfg,
          agentDir: req.agentDir,
          authStore: req.authStore,
          capability: "video",
        });
      const deadline = createProviderOperationDeadline({
        timeoutMs: req.timeoutMs,
        label: "Vydra video generation",
      });
      const { model, body } = resolveVydraVideoRequestBody(req);
      const { response, release } = await postJsonRequest({
        url: `${baseUrl}/models/${model}`,
        headers,
        body,
        timeoutMs: resolveProviderOperationTimeoutMs({
          deadline,
          defaultTimeoutMs: 120_000,
        }),
        fetchFn,
        allowPrivateNetwork,
        dispatcherPolicy,
      });

      try {
        await assertOkOrThrowHttpError(response, "Vydra video generation failed");
        const submitted = await response.json();
        const completedPayload = await resolveCompletedVydraPayload({
          submitted,
          baseUrl,
          headers,
          timeoutMs: resolveProviderOperationTimeoutMs({
            deadline,
            defaultTimeoutMs: 120_000,
          }),
          fetchFn,
          kind: "video",
          missingJobIdMessage: "Vydra video generation response missing job id",
        });
        const videoUrl = extractVydraResultUrls(completedPayload, "video")[0];
        if (!videoUrl) {
          throw new Error("Vydra video generation completed without a video URL");
        }
        const video = await downloadVydraAsset({
          url: videoUrl,
          kind: "video",
          timeoutMs: resolveProviderOperationTimeoutMs({
            deadline,
            defaultTimeoutMs: 120_000,
          }),
          fetchFn,
        });
        return {
          videos: [
            {
              buffer: video.buffer,
              mimeType: video.mimeType,
              fileName: video.fileName,
            },
          ],
          model,
          metadata: {
            jobId:
              resolveVydraResponseJobId(completedPayload) ?? resolveVydraResponseJobId(submitted),
            videoUrl,
            status: resolveVydraResponseStatus(completedPayload) ?? "completed",
          },
        };
      } finally {
        await release();
      }
    },
  };
}
