// Local media access helpers validate workspace-local media path access.
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInboundPathRoot } from "@openclaw/media-core/inbound-path-policy";
import { readFileHandleBounded } from "../infra/fs-safe-advanced.js";
import { FsSafeError, openLocalFileSafely } from "../infra/fs-safe.js";
import { assertNoWindowsNetworkPath } from "../infra/local-file-access.js";
import { isPathInside } from "../infra/path-guards.js";
import { getDefaultMediaLocalRoots } from "./local-roots.js";
import { MediaReferenceError, resolveInboundMediaReference } from "./media-reference.js";

/** Machine-readable reasons local media path validation can fail. */
export type LocalMediaAccessErrorCode =
  | "path-not-allowed"
  | "invalid-root"
  | "invalid-file-url"
  | "network-path-not-allowed"
  | "unsafe-bypass"
  | "not-found"
  | "invalid-path"
  | "not-file";

/** Error raised when a local media path escapes the configured allowlist. */
export class LocalMediaAccessError extends Error {
  code: LocalMediaAccessErrorCode;

  constructor(code: LocalMediaAccessErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = "LocalMediaAccessError";
  }
}

/** Returns the default root allowlist for local media reads. */
export function getDefaultLocalRoots(): readonly string[] {
  return getDefaultMediaLocalRoots();
}

async function resolveCanonicalBoundaryPath(root: string): Promise<string> {
  const resolved = path.resolve(root);
  try {
    return await fs.realpath(resolved);
  } catch {
    return resolved;
  }
}

/** Resolves an allowlist once for callers that validate several media paths. */
export async function resolveLocalMediaRoots(
  localRoots?: readonly string[],
): Promise<readonly string[]> {
  const roots = localRoots ?? getDefaultLocalRoots();
  return await Promise.all(
    roots.map(async (root) => {
      const resolvedRoot = await resolveCanonicalBoundaryPath(root);
      if (resolvedRoot === path.parse(resolvedRoot).root) {
        throw new LocalMediaAccessError(
          "invalid-root",
          `Invalid localRoots entry (refuses filesystem root): ${root}. Pass a narrower directory.`,
        );
      }
      return resolvedRoot;
    }),
  );
}

async function resolveLocalMediaPathForContainment(mediaPath: string): Promise<string> {
  try {
    return await fs.realpath(mediaPath);
  } catch {
    // Missing files (for example, staged outbound media supplied by host-read
    // callbacks) still need symlink-aware parent containment.
    try {
      return path.join(await fs.realpath(path.dirname(mediaPath)), path.basename(mediaPath));
    } catch {
      return path.resolve(mediaPath);
    }
  }
}

type ResolvedLocalMediaBoundary = {
  rejectHardlinks: boolean;
  roots: readonly string[] | "any";
};

type ManagedReferenceErrorPolicy = "ignore" | "reject";

async function resolveLocalMediaBoundary(
  mediaPath: string,
  localRoots: readonly string[] | "any" | undefined,
  managedReferenceErrors: ManagedReferenceErrorPolicy,
  options?: {
    inboundRoots?: readonly string[];
    resolvedRoots?: readonly string[];
    resolveRoots?: () => Promise<readonly string[]>;
  },
): Promise<ResolvedLocalMediaBoundary> {
  if (localRoots === "any") {
    return { rejectHardlinks: false, roots: "any" };
  }
  let inboundReference;
  try {
    inboundReference = await resolveInboundMediaReference(mediaPath);
  } catch (err) {
    if (managedReferenceErrors === "reject" && err instanceof MediaReferenceError) {
      throw new LocalMediaAccessError(err.code, err.message, { cause: err });
    }
    if (!(err instanceof MediaReferenceError)) {
      throw err;
    }
  }
  if (inboundReference) {
    return {
      rejectHardlinks: true,
      roots: await resolveLocalMediaRoots([path.dirname(inboundReference.physicalPath)]),
    };
  }
  try {
    assertNoWindowsNetworkPath(mediaPath, "Local media path");
  } catch (err) {
    throw new LocalMediaAccessError("network-path-not-allowed", (err as Error).message, {
      cause: err,
    });
  }
  const matchedInboundRoot = options?.inboundRoots?.length
    ? resolveInboundPathRoot({ filePath: mediaPath, roots: options.inboundRoots })
    : undefined;
  if (matchedInboundRoot) {
    // Channel inbound roots may contain whole-segment wildcards. Freeze the
    // matched root under the stable pre-wildcard anchor so an alias cannot
    // promote an outside directory into the authorized boundary.
    const resolvedAnchor = await resolveCanonicalBoundaryPath(matchedInboundRoot.anchorRoot);
    const resolvedRoot = await resolveCanonicalBoundaryPath(matchedInboundRoot.matchedRoot);
    if (!isPathInside(resolvedAnchor, resolvedRoot)) {
      throw new LocalMediaAccessError(
        "path-not-allowed",
        `Local media path is not under an allowed directory: ${mediaPath}`,
      );
    }
    return {
      rejectHardlinks: true,
      roots: [resolvedRoot],
    };
  }
  const roots = localRoots ?? getDefaultLocalRoots();
  const resolved = await resolveLocalMediaPathForContainment(mediaPath);

  if (localRoots === undefined) {
    // Unscoped default roots include workspace, but not sibling workspace-* agent sandboxes.
    const workspaceRoot = roots.find((root) => path.basename(root) === "workspace");
    if (workspaceRoot) {
      const stateDir = path.dirname(workspaceRoot);
      const rel = path.relative(stateDir, resolved);
      if (rel && isPathInside(stateDir, resolved)) {
        const firstSegment = rel.split(path.sep)[0] ?? "";
        if (firstSegment.startsWith("workspace-")) {
          throw new LocalMediaAccessError(
            "path-not-allowed",
            `Local media path is not under an allowed directory: ${mediaPath}`,
          );
        }
      }
    }
  }

  const resolvedRoots =
    options?.resolvedRoots ??
    (await options?.resolveRoots?.()) ??
    (await resolveLocalMediaRoots(roots));
  for (const [index, resolvedRoot] of resolvedRoots.entries()) {
    const root = roots[index] ?? resolvedRoot;
    if (resolvedRoot === path.parse(resolvedRoot).root) {
      throw new LocalMediaAccessError(
        "invalid-root",
        `Invalid localRoots entry (refuses filesystem root): ${root}. Pass a narrower directory.`,
      );
    }
    if (isPathInside(resolvedRoot, resolved)) {
      return { rejectHardlinks: false, roots: resolvedRoots };
    }
  }

  throw new LocalMediaAccessError(
    "path-not-allowed",
    `Local media path is not under an allowed directory: ${mediaPath}`,
  );
}

/** Verifies that a local media path is managed inbound media or lives under allowed roots. */
export async function assertLocalMediaAllowed(
  mediaPath: string,
  localRoots: readonly string[] | "any" | undefined,
  options?: {
    inboundRoots?: readonly string[];
    resolvedRoots?: readonly string[];
    resolveRoots?: () => Promise<readonly string[]>;
  },
): Promise<void> {
  await resolveLocalMediaBoundary(mediaPath, localRoots, "ignore", options);
}

/** Opens, revalidates, and bounded-reads local media against one frozen root boundary. */
export async function readLocalMediaFile(
  mediaPath: string,
  localRoots: readonly string[] | "any" | undefined,
  options: {
    inboundRoots?: readonly string[];
    maxBytes: number;
    resolvedRoots?: readonly string[];
    resolveRoots?: () => Promise<readonly string[]>;
  },
): Promise<Buffer> {
  const boundary = await resolveLocalMediaBoundary(mediaPath, localRoots, "reject", options);
  const opened = await openLocalFileSafely({ filePath: mediaPath });
  try {
    if (
      boundary.roots !== "any" &&
      !boundary.roots.some((resolvedRoot) => isPathInside(resolvedRoot, opened.realPath))
    ) {
      throw new LocalMediaAccessError(
        "path-not-allowed",
        `Local media path is not under an allowed directory: ${mediaPath}`,
      );
    }
    if (boundary.rejectHardlinks && opened.stat.nlink > 1) {
      throw new FsSafeError("hardlink", "hardlinked path not allowed");
    }
    if (opened.stat.size > options.maxBytes) {
      throw new FsSafeError(
        "too-large",
        `file exceeds limit of ${options.maxBytes} bytes (got ${opened.stat.size})`,
      );
    }
    return await readFileHandleBounded(opened.handle, options.maxBytes);
  } finally {
    await opened.handle.close().catch(() => {});
  }
}
