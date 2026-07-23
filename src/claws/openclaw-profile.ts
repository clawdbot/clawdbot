// Safe loader for package-local OpenClaw profiles referenced by Claw metadata.
import { isScalar, parseDocument, visit } from "yaml";
import { FsSafeError, root as fsSafeRoot } from "../infra/fs-safe.js";
import { isSafeClawRelativePath } from "./schema-portability.js";
import { parseClawOpenClawProfile } from "./schema.js";
import type { ClawDiagnostic, ClawManifest, ClawOpenClawProfile } from "./types.js";

const MAX_OPENCLAW_PROFILE_BYTES = 256 * 1024;

function diagnostic(code: string, message: string, path = "$"): ClawDiagnostic {
  return { level: "error", code, phase: "parse", path, message };
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
    maxBytes: MAX_OPENCLAW_PROFILE_BYTES,
    nonBlockingRead: true,
    symlinks: "reject",
  });
  return read.buffer;
}

export async function readClawOpenClawProfile(params: {
  packageRoot: string;
  manifest: ClawManifest;
}): Promise<
  | { ok: true; profile?: ClawOpenClawProfile; raw?: Buffer; path?: string }
  | { ok: false; diagnostics: ClawDiagnostic[] }
> {
  const declaredPath = params.manifest.metadata?.["openclaw.config"];
  if (declaredPath === undefined) {
    return { ok: true };
  }
  if (
    declaredPath.includes("\\") ||
    !isSafeClawRelativePath(declaredPath) ||
    !/\.ya?ml$/i.test(declaredPath)
  ) {
    return {
      ok: false,
      diagnostics: [
        diagnostic(
          "invalid_openclaw_profile_path",
          "metadata.openclaw.config must reference a forward-slash package-relative .yml or .yaml file.",
          "$.metadata.openclaw.config",
        ),
      ],
    };
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
              ? `The OpenClaw profile exceeds ${MAX_OPENCLAW_PROFILE_BYTES} bytes.`
              : `Could not read ${declaredPath}: ${(error as Error).message}`,
          "$.metadata.openclaw.config",
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
        path: `$.metadata.openclaw.config${entry.path.slice(1)}`,
      })),
    };
  }
  return { ok: true, profile: parsed.profile, raw, path: declaredPath };
}
