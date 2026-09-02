import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { MAX_IMAGE_BYTES } from "@openclaw/media-core/constants";
import { pruneProcessedHistoryImages } from "../../agents/embedded-agent-runner/run/history-image-prune.js";
import {
  detectAndLoadPromptImages,
  hydratePromptMediaMessages,
} from "../../agents/embedded-agent-runner/run/images.js";
import { resolveMediaFactLocalRef } from "../../agents/embedded-agent-runner/run/images.media-refs.js";
import {
  readPersistedMediaImageLayout,
  readPersistedImageBlockFactIndexes,
  type ImageFactIndex,
} from "../../agents/embedded-agent-runner/run/prompt-image-metadata.js";
import { resolveImageSanitizationLimits } from "../../agents/image-sanitization.js";
import type { AgentMessage } from "../../agents/runtime/index.js";
import type { SessionPlacementTurnParams } from "../../agents/session-placement-admission.js";
import { resolveEffectiveToolFsWorkspaceOnly } from "../../agents/tool-fs-policy.js";
import { tempWorkspace } from "../../infra/private-temp-workspace.js";
import { resolvePreferredOpenClawTmpDir } from "../../infra/tmp-openclaw-dir.js";
import { logWarn } from "../../logger.js";
import { readLocalMediaFile } from "../../media/local-media-access.js";
import { getAgentScopedMediaLocalRoots } from "../../media/local-roots.js";
import { readPersistedMediaFacts, type MediaFact } from "../../media/media-facts.js";
import { resolveMediaReferenceLocalPath } from "../../media/media-reference.js";
import {
  ensureStagedInputDirectory,
  stagedInputDirectory,
  stagedInputFileName,
} from "../../media/staged-inputs.js";
import { MEDIA_MAX_BYTES } from "../../media/store.js";
import type { WorkerLaunchPlan } from "../../worker/launch-descriptor.js";
import {
  cloneImageContent,
  cloneTextContent,
  isWorkerTranscriptMessageFrameSafe,
} from "../../worker/transcript-message.js";
import type { WorkerTunnelHandle } from "./tunnel-contract.js";
import {
  MAX_RECONCILIATION_TOTAL_BYTES,
  MAX_RECONCILIATION_ENTRIES,
} from "./workspace-manifest.js";

function prepareInput(
  content: Extract<AgentMessage, { role: "user" }>["content"],
  media: MediaFact[],
  modelHasVision: boolean,
  imageFactIndexes?: readonly ImageFactIndex[],
) {
  // Factless replay bypasses hydration, so gate its raw image parts here too.
  const parts = (
    typeof content === "string" ? [{ type: "text" as const, text: content }] : content
  ).filter((part) => modelHasVision || part.type !== "image");
  const unownedImages = parts
    .filter((part) => part.type === "image")
    .filter((_image, index) => {
      const factIndex = imageFactIndexes?.[index];
      return factIndex == null || !resolveMediaFactLocalRef(media[factIndex]!);
    });
  return {
    parts,
    // Hydration suppression controls model reinjection, not source-file access for tools.
    media,
    unownedImages,
    files: new Set<string>(),
  };
}

/** Prepare transient worker input; canonical media paths and transcript bytes stay on the Gateway. */
export async function prepareWorkerTurnMedia(params: {
  turn: SessionPlacementTurnParams;
  history: AgentMessage[];
  localWorkspaceDir: string;
  remoteWorkspaceDir: string;
  tunnel: WorkerTunnelHandle;
  isAuthorized: () => boolean;
  signal: AbortSignal;
}): Promise<{
  prompt: WorkerLaunchPlan["assignment"]["prompt"];
  history: AgentMessage[];
  images: Awaited<ReturnType<typeof detectAndLoadPromptImages>>["images"];
  imageFactIndexes: Awaited<ReturnType<typeof detectAndLoadPromptImages>>["imageFactIndexes"];
}> {
  const { turn, signal } = params;
  const assertCurrent = () => {
    signal.throwIfAborted();
    if (!params.isAuthorized()) {
      throw new Error("Worker media preparation lost its active placement or turn claim");
    }
  };
  assertCurrent();
  const recorded =
    turn.userTurnTranscriptRecorder?.message ??
    (await turn.userTurnTranscriptRecorder?.resolveMessage());
  assertCurrent();
  const recordedMedia = recorded ? readPersistedMediaFacts(recorded) : undefined;
  const media = recordedMedia?.length ? recordedMedia : (turn.media ?? []);
  const localRoots = resolveEffectiveToolFsWorkspaceOnly({
    cfg: turn.config,
    agentId: turn.agentId,
  })
    ? [params.localWorkspaceDir]
    : [...getAgentScopedMediaLocalRoots(turn.config ?? {}, turn.agentId), params.localWorkspaceDir];
  const modelHasVision = turn.modelHasVision === true;
  const mediaOptions = {
    workspaceDir: params.localWorkspaceDir,
    model: { input: modelHasVision ? ["text", "image"] : ["text"] },
    maxBytes: MAX_IMAGE_BYTES,
    maxDimensionPx: resolveImageSanitizationLimits(turn.config).maxDimensionPx,
    localRoots,
  };
  const currentImages = await detectAndLoadPromptImages({
    ...mediaOptions,
    prompt: turn.prompt,
    existingImages: turn.images,
    imageOrder: turn.imageOrder,
    media,
    mediaImageLayout: recorded ? readPersistedMediaImageLayout(recorded) : undefined,
  });
  assertCurrent();
  if (currentImages.failedMediaCount) {
    throw new Error(
      `Cloud worker could not load ${currentImages.failedMediaCount} image attachment(s); resend the attachment and retry.`,
    );
  }
  const pruned = pruneProcessedHistoryImages(params.history) ?? params.history;
  const history = await hydratePromptMediaMessages(pruned, mediaOptions);
  assertCurrent();

  const current = prepareInput(
    [{ type: "text", text: turn.prompt }, ...currentImages.images],
    media,
    modelHasVision,
    currentImages.imageFactIndexes,
  );
  const replay = new Map(
    history.flatMap((message) =>
      message.role === "user"
        ? [
            [
              message,
              prepareInput(
                message.content,
                readPersistedMediaFacts(message) ?? [],
                modelHasVision,
                readPersistedImageBlockFactIndexes(message),
              ),
            ] as const,
          ]
        : [],
    ),
  );
  const inputs = [current, ...replay.values()];
  // Stable names preserve edits; the same projection is used for first input and replay.
  const projectedPaths = new Map<string, string>();
  let staging: Awaited<ReturnType<typeof tempWorkspace>> | undefined;
  try {
    let bytes = 0;
    const stagedPaths = new Set<string>();
    const stageFile = async (data: Buffer, identity: string, fileName: string) => {
      assertCurrent();
      const directory = stagedInputDirectory(identity);
      const relative = path.posix.join(directory, stagedInputFileName(fileName));
      const remotePath = path.posix.isAbsolute(params.remoteWorkspaceDir)
        ? path.posix.join(params.remoteWorkspaceDir, relative)
        : path.win32.join(params.remoteWorkspaceDir, ...relative.split("/"));
      if (stagedPaths.has(remotePath)) {
        return remotePath;
      }
      bytes += data.length;
      if (
        bytes > MAX_RECONCILIATION_TOTAL_BYTES ||
        stagedPaths.size >= MAX_RECONCILIATION_ENTRIES
      ) {
        throw new Error(
          "Cloud worker attachments exceed the workspace transfer budget; send fewer or smaller files.",
        );
      }
      staging ??= await tempWorkspace({
        rootDir: resolvePreferredOpenClawTmpDir(),
        prefix: "worker-attachments-",
      });
      const destination = path.join(staging.dir, ...relative.split("/"));
      assertCurrent();
      await ensureStagedInputDirectory(staging.dir, directory, signal);
      assertCurrent();
      await fs.writeFile(destination, data, { mode: 0o600, signal });
      stagedPaths.add(remotePath);
      return remotePath;
    };
    for (const input of inputs) {
      for (const fact of input.media) {
        const ref = resolveMediaFactLocalRef(fact);
        if (!ref) {
          continue;
        }
        let remotePath = projectedPaths.get(ref.raw);
        if (!remotePath) {
          let source: string;
          let data: Buffer;
          try {
            source = path.resolve(
              fact.workspaceDir ?? params.localWorkspaceDir,
              await resolveMediaReferenceLocalPath(ref.resolved),
            );
            assertCurrent();
            data = await readLocalMediaFile(source, localRoots, {
              maxBytes: Math.max(MAX_IMAGE_BYTES, MEDIA_MAX_BYTES),
            });
          } catch (error) {
            assertCurrent();
            if (input === current) {
              throw error;
            }
            // Retention can expire replay sources; only current input requires availability.
            // Keep authority checks and staging/transfer failures outside this omission policy.
            logWarn("worker-media: Omitted an unavailable historical attachment source");
            continue;
          }
          assertCurrent();
          const identity = createHash("sha256").update(source).digest("hex");
          remotePath = await stageFile(data, identity, path.basename(source));
          for (const alias of [ref.raw, ref.resolved, source, fact.path, fact.url]) {
            if (alias) {
              projectedPaths.set(alias, remotePath);
            }
          }
        }
        input.files.add(remotePath);
      }
      for (const image of input.unownedImages) {
        const data = Buffer.from(image.data, "base64");
        const identity = createHash("sha256").update(data).digest("hex");
        input.files.add(await stageFile(data, identity, "image"));
      }
    }
    if (staging) {
      if (!params.tunnel.stageAttachments) {
        throw new Error(
          "Worker transport cannot stage attachments; update and reprovision the worker.",
        );
      }
      assertCurrent();
      await params.tunnel.stageAttachments({
        localPath: staging.dir,
        isAuthorized: params.isAuthorized,
        signal,
      });
    }
  } finally {
    await staging?.cleanup();
  }
  assertCurrent();
  const projectText = (text: string) => {
    let projected = text;
    for (const [source, destination] of projectedPaths) {
      projected = projected.replaceAll(source, destination);
    }
    return projected;
  };
  const projectInput = (input: ReturnType<typeof prepareInput>) => {
    // Gateway bookkeeping is not part of the closed worker content contract.
    const parts = input.parts.map((part) =>
      part.type === "text"
        ? { ...cloneTextContent(part), text: projectText(part.text) }
        : cloneImageContent(part),
    );
    const text = parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
    const notes = [...input.files]
      .filter((file) => !text.includes(file))
      .map((file) => `[media attached: ${file}]`)
      .join("\n");
    if (notes) {
      const index = parts.findIndex((part) => part.type === "text");
      const part = parts[index];
      if (part?.type === "text") {
        parts[index] = { ...part, text: [part.text, notes].filter(Boolean).join("\n") };
      } else {
        parts.unshift({ type: "text", text: notes });
      }
    }
    return parts;
  };
  const prompt = projectInput(current);
  if (
    !isWorkerTranscriptMessageFrameSafe({ role: "user", content: prompt, timestamp: Date.now() })
  ) {
    throw new Error(
      "Cloud worker input exceeds its 25 MiB image or 64 KiB text/control limit; send fewer or smaller attachments.",
    );
  }
  return {
    images: currentImages.images,
    imageFactIndexes: currentImages.imageFactIndexes,
    prompt: prompt.length === 1 && prompt[0]?.type === "text" ? prompt[0].text : prompt,
    history: history.map((message) => {
      const input = message.role === "user" ? replay.get(message) : undefined;
      return input ? Object.assign({}, message, { content: projectInput(input) }) : message;
    }),
  };
}
