import { safeFileURLToPath } from "../../../infra/local-file-access.js";
import {
  isImageMediaFact,
  normalizeMediaFacts,
  type MediaFact,
} from "../../../media/media-facts.js";
import { resolveUserPath } from "../../../utils.js";

const URL_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:/i;
const WINDOWS_DRIVE_PATH_PATTERN = /^[A-Za-z]:[\\/]/;

export type MediaFileRef = {
  raw: string;
  type: "path" | "media-uri";
  resolved: string;
};

export type MediaImageRef = MediaFileRef & {
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

export function resolveMediaFactLocalRef(fact: MediaFact): MediaFileRef | undefined {
  const mediaUri = [fact.url, fact.path].find((value) => value?.startsWith("media://inbound/"));
  const identity = mediaUri ?? fact.path ?? fact.url;
  if (!identity) {
    return undefined;
  }
  let resolved = mediaUri;
  if (!resolved && /^file:/i.test(identity)) {
    try {
      resolved = safeFileURLToPath(identity);
    } catch {
      return undefined;
    }
  } else if (
    !resolved &&
    (!URL_SCHEME_PATTERN.test(identity) || WINDOWS_DRIVE_PATH_PATTERN.test(identity))
  ) {
    resolved = identity;
  }
  if (!resolved) {
    return undefined;
  }
  return {
    raw: identity,
    type: mediaUri ? "media-uri" : "path",
    resolved: resolved.startsWith("~") ? resolveUserPath(resolved) : resolved,
  };
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
  const localRef = resolveMediaFactLocalRef(fact);
  const hydrate = fact.hydrationSuppressed !== true;
  if (!localRef || isOpenClawCliImageCachePath(localRef.resolved)) {
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
    ...localRef,
    aliases: [fact.path, fact.url, localRef.resolved].filter((value): value is string =>
      Boolean(value),
    ),
    factIndex,
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

// Guards for transports that cannot carry attachments (paired-node CLI): only
// facts that will actually hydrate an image count; described/remote-only facts
// whose hydration is suppressed must not block text-only prompts.
export function hasHydratableMediaImages(media?: readonly MediaFact[]): boolean {
  return collectMediaImageRefs(media).some((ref) => ref?.hydrate === true);
}
