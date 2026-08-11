// Safe loader for the conventional package-local OpenClaw profile.
import { isScalar, parseDocument, visit } from "yaml";
import { FsSafeError, root as fsSafeRoot } from "../infra/fs-safe.js";
import { isSafeClawRelativePath } from "./schema-portability.js";
import { parseClawOpenClawProfile } from "./schema.js";
import type { ClawDiagnostic, ClawOpenClawProfile } from "./types.js";

const MAX_PROFILE_BYTES = 256 * 1024;
const CLAW_PROFILE_PATH = "profiles/openclaw.yml";
const LEGACY_PROFILE_POINTER_KEY = "openclaw.config";
const LEGACY_PROFILE_POINTER_PATH = "$.metadata.openclaw.config";
const CONVENTIONAL_PROFILE_PATH = "$.profiles.openclaw";

function diagnostic(code: string, message: string, path = "$"): ClawDiagnostic {
  return { level: "error", code, phase: "parse", path, message };
}

function warning(code: string, message: string, path: string): ClawDiagnostic {
  return { level: "warning", code, phase: "parse", path, message };
}

function parseProfileYaml(
  raw: string,
  path: string,
): { ok: true; value: unknown } | { ok: false; diagnostics: ClawDiagnostic[] } {
  const document = parseDocument(raw.startsWith("\uFEFF") ? raw.slice(1) : raw, {
    prettyErrors: false,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    return {
      ok: false,
      diagnostics: document.errors.map((error) =>
        diagnostic("invalid_openclaw_profile", `Could not parse ${path}: ${error.message}`),
      ),
    };
  }
  let unsupportedFeature: string | undefined;
  visit(document, {
    Alias() {
      unsupportedFeature ??= "aliases";
    },
    Node(_key, node) {
      if (node.anchor) {
        unsupportedFeature ??= "anchors";
      } else if (node.tag) {
        unsupportedFeature ??= "explicit tags";
      }
    },
    Pair(_key, pair) {
      if (isScalar(pair.key) && pair.key.value === "<<") {
        unsupportedFeature ??= "merge keys";
      }
    },
  });
  if (unsupportedFeature) {
    return {
      ok: false,
      diagnostics: [
        diagnostic(
          "unsupported_openclaw_profile_yaml_feature",
          `${path} uses ${unsupportedFeature}; OpenClaw profile YAML must map directly to JSON data.`,
        ),
      ],
    };
  }
  try {
    return { ok: true, value: document.toJSON() };
  } catch (error) {
    return {
      ok: false,
      diagnostics: [
        diagnostic(
          "invalid_openclaw_profile",
          `Could not parse ${path}: ${(error as Error).message}`,
        ),
      ],
    };
  }
}

async function readProfileFile(packageRoot: string, path: string): Promise<Buffer> {
  const packageFiles = await fsSafeRoot(packageRoot);
  const read = await packageFiles.read(path, {
    hardlinks: "reject",
    maxBytes: MAX_PROFILE_BYTES,
    nonBlockingRead: true,
    symlinks: "reject",
  });
  return read.buffer;
}

/**
 * Resolves the OpenClaw profile for a package.
 *
 * `profiles/openclaw.yml` is the conventional location. The retired
 * `metadata.openclaw.config` pointer is still read for compatibility with
 * packages published against the released contract; it reports a deprecation
 * warning instead of failing, and only errors when it is malformed or conflicts
 * with a conventional profile.
 */
export async function readClawOpenClawProfile(params: {
  packageRoot: string;
  metadata?: Record<string, string>;
}): Promise<
  | {
      ok: true;
      profile?: ClawOpenClawProfile;
      raw?: Buffer;
      path?: string;
      diagnostics?: ClawDiagnostic[];
    }
  | { ok: false; diagnostics: ClawDiagnostic[] }
> {
  const packageFiles = await fsSafeRoot(params.packageRoot);
  const conventionalExists = await packageFiles.exists(CLAW_PROFILE_PATH);
  const legacyPointer = params.metadata?.[LEGACY_PROFILE_POINTER_KEY];
  const diagnostics: ClawDiagnostic[] = [];
  let declaredPath = CLAW_PROFILE_PATH;
  let diagnosticPath = CONVENTIONAL_PROFILE_PATH;

  if (legacyPointer !== undefined) {
    if (
      legacyPointer.includes("\\") ||
      !isSafeClawRelativePath(legacyPointer) ||
      !/\.ya?ml$/i.test(legacyPointer)
    ) {
      return {
        ok: false,
        diagnostics: [
          diagnostic(
            "invalid_openclaw_profile_path",
            `metadata.${LEGACY_PROFILE_POINTER_KEY} must reference a forward-slash package-relative .yml or .yaml file.`,
            LEGACY_PROFILE_POINTER_PATH,
          ),
        ],
      };
    }
    if (conventionalExists && legacyPointer !== CLAW_PROFILE_PATH) {
      return {
        ok: false,
        diagnostics: [
          diagnostic(
            "conflicting_openclaw_profile_pointer",
            `metadata.${LEGACY_PROFILE_POINTER_KEY} references ${legacyPointer} while ${CLAW_PROFILE_PATH} also exists; keep only ${CLAW_PROFILE_PATH}.`,
            LEGACY_PROFILE_POINTER_PATH,
          ),
        ],
      };
    }
    declaredPath = legacyPointer;
    diagnosticPath = LEGACY_PROFILE_POINTER_PATH;
    diagnostics.push(
      warning(
        "deprecated_openclaw_profile_pointer",
        `metadata.${LEGACY_PROFILE_POINTER_KEY} is deprecated; move the profile to ${CLAW_PROFILE_PATH} and remove the metadata entry.`,
        LEGACY_PROFILE_POINTER_PATH,
      ),
    );
  } else if (!conventionalExists) {
    return { ok: true };
  }

  let raw: Buffer;
  try {
    raw = await readProfileFile(params.packageRoot, declaredPath);
  } catch (error) {
    const unsafe =
      error instanceof FsSafeError &&
      (error.code === "hardlink" || error.code === "symlink" || error.code === "path-mismatch");
    const tooLarge = error instanceof FsSafeError && error.code === "too-large";
    return {
      ok: false,
      diagnostics: [
        diagnostic(
          unsafe
            ? "openclaw_profile_unsafe"
            : tooLarge
              ? "openclaw_profile_too_large"
              : "openclaw_profile_read_failed",
          unsafe
            ? "The OpenClaw profile must be a regular, non-symlinked, non-hardlinked file."
            : tooLarge
              ? `The OpenClaw profile exceeds ${MAX_PROFILE_BYTES} bytes.`
              : `Could not read ${declaredPath}: ${(error as Error).message}`,
          diagnosticPath,
        ),
      ],
    };
  }

  const yaml = parseProfileYaml(raw.toString("utf8"), declaredPath);
  if (!yaml.ok) {
    return yaml;
  }
  const parsed = parseClawOpenClawProfile(yaml.value);
  if (!parsed.ok) {
    return {
      ok: false,
      diagnostics: parsed.diagnostics.map((entry) => ({
        ...entry,
        path: `${diagnosticPath}${entry.path.slice(1)}`,
      })),
    };
  }
  return {
    ok: true,
    profile: parsed.profile,
    raw,
    path: declaredPath,
    ...(diagnostics.length > 0 ? { diagnostics } : {}),
  };
}
