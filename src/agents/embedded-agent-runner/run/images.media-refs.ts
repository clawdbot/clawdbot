import { safeFileURLToPath } from "../../../infra/local-file-access.js";
import {
  isImageMediaFact,
  normalizeMediaFacts,
  type MediaFact,
} from "../../../media/media-facts.js";
import type { PromptImageOrderEntry } from "../../../media/prompt-image-order.js";
import { resolveUserPath } from "../../../utils.js";

const URL_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:/i;
const WINDOWS_DRIVE_PATH_PATTERN = /^[A-Za-z]:[\\/]/;

type DetectedImageRef = {
  raw: string;
  type: "path" | "media-uri";
  resolved: string;
};

export type MediaImageRef = DetectedImageRef & {
  aliases: string[];
  detect?: boolean;
  factIndex: number;
  hydrate: boolean;
  workspaceDir?: string;
};

export function isOpenClawCliImageCachePath(filePath: string): boolean {
  const parts = filePath.replaceAll("\\", "/").split("/");
  return parts.some((part, index) => {
    if (part === ".openclaw-cli-images") {
      return true;
    }
    const parent = parts[index - 1] ?? "";
    return part === "openclaw-cli-images" && /^openclaw(?:-\d+)?$/.test(parent);
  });
}

function mediaFactToImageRef(fact: MediaFact, factIndex: number): MediaImageRef | undefined {
  if (!isImageMediaFact(fact)) {
    return undefined;
  }
  const mediaUri = [fact.url, fact.path].find((value) => value?.startsWith("media://inbound/"));
  const identity = mediaUri ?? fact.path ?? fact.url;
  if (!identity) {
    return fact.hydrationSuppressed === true
      ? {
          aliases: [],
          detect: false,
          factIndex,
          raw: "",
          type: "path",
          resolved: "",
          hydrate: false,
          ...(fact.workspaceDir ? { workspaceDir: fact.workspaceDir } : {}),
        }
      : undefined;
  }
  let resolved = mediaUri;
  if (!resolved && identity && /^file:/i.test(identity)) {
    try {
      resolved = safeFileURLToPath(identity);
    } catch {
      resolved = undefined;
    }
  } else if (
    !resolved &&
    identity &&
    (!URL_SCHEME_PATTERN.test(identity) || WINDOWS_DRIVE_PATH_PATTERN.test(identity))
  ) {
    resolved = identity;
  }
  if (resolved?.startsWith("~")) {
    resolved = resolveUserPath(resolved);
  }
  const hydrate = fact.hydrationSuppressed !== true;
  if (!resolved || isOpenClawCliImageCachePath(resolved)) {
    return {
      aliases: [fact.path, fact.url].filter((value): value is string => Boolean(value)),
      detect: false,
      factIndex,
      raw: identity,
      type: "path",
      resolved: identity,
      hydrate: false,
      ...(fact.workspaceDir ? { workspaceDir: fact.workspaceDir } : {}),
    };
  }
  return {
    aliases: [fact.path, fact.url, resolved].filter((value): value is string => Boolean(value)),
    factIndex,
    raw: mediaUri ?? fact.path ?? fact.url ?? resolved,
    type: mediaUri ? "media-uri" : "path",
    resolved,
    hydrate,
    ...(fact.workspaceDir ? { workspaceDir: fact.workspaceDir } : {}),
  };
}

export function collectMediaImageRefs(
  media?: readonly MediaFact[],
): Array<MediaImageRef | undefined> {
  return normalizeMediaFacts(media).flatMap((fact, factIndex) =>
    isImageMediaFact(fact) ? [mediaFactToImageRef(fact, factIndex)] : [],
  );
}

export function collectIdentitylessMediaImageFactIndexes(media?: readonly MediaFact[]): number[] {
  return normalizeMediaFacts(media).flatMap((fact, factIndex) =>
    isImageMediaFact(fact) &&
    fact.hydrationSuppressed !== true &&
    fact.path === undefined &&
    fact.url === undefined
      ? [factIndex]
      : [],
  );
}

// Guards for transports that cannot carry attachments (paired-node CLI): only
// facts that will actually hydrate an image count; described/remote-only facts
// whose hydration is suppressed must not block text-only prompts.
export function hasHydratableMediaImages(media?: readonly MediaFact[]): boolean {
  return collectMediaImageRefs(media).some((ref) => ref?.hydrate === true);
}

export function selectMediaImageRefs(params: {
  refs: Array<MediaImageRef | undefined>;
  existingImageCount: number;
  imageOrder?: readonly PromptImageOrderEntry[];
}): Array<MediaImageRef | undefined> {
  const { refs } = params;
  if (!params.imageOrder?.length) {
    // Legacy turns (no layout metadata): identity-less facts are the inline
    // images' own slots — pair them positionally so they cannot count as failed
    // offloads; identity-bearing refs remain genuine offloaded attachments.
    let inlinePairs = params.existingImageCount;
    return refs.filter((ref) => {
      if (ref === undefined && inlinePairs > 0) {
        inlinePairs -= 1;
        return false;
      }
      return true;
    });
  }
  if (refs.length !== params.imageOrder.length) {
    // Partial fact arrays cannot prove positional ownership. Keep every ref as
    // an offload so no attachment is silently consumed by an inline slot.
    return refs;
  }
  let remainingExisting = params.existingImageCount;
  return params.imageOrder.flatMap((entry, index) => {
    if (entry === "offloaded") {
      return [refs[index]];
    }
    if (remainingExisting > 0) {
      remainingExisting -= 1;
      return [];
    }
    return [undefined];
  });
}
