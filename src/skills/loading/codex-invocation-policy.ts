// Reads Codex's per-skill `agents/openai.yaml` sidecar to derive whether
// implicit (model) invocation is disabled for a skill.
//
// Codex stores invocation policy in this sidecar (`policy.allow_implicit_invocation`),
// separate from the SKILL.md frontmatter field `disable-model-invocation` that
// OpenClaw reads. The core Agent Skills specification defines neither field;
// both are client-specific extensions. OpenClaw discovers the same shared
// Agent Skills roots as Codex (`~/.agents/skills`, `.agents/skills`), so when a
// skill author marks a workflow explicit-only via the Codex sidecar, OpenClaw
// must honor it too -- otherwise the same on-disk skill is implicit-invocable in
// one client and explicit-only in the other.
//
// The sidecar is read through the same root-scoped boundary helper used for
// SKILL.md so a symlinked sidecar cannot escape the skill root. Only an explicit
// `policy.allow_implicit_invocation: false` disables invocation; an absent sidecar,
// a missing policy key, or an unparseable file leaves behavior unchanged (returns
// false), so malformed input can never restrict a skill that would otherwise load.
import { closeSync, existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { openRootFileSync, readFileDescriptorBoundedSync } from "../../infra/boundary-file-read.js";

/** Cap sidecar reads: a metadata YAML file is tiny in practice. */
const CODEX_SIDECAR_MAX_BYTES = 65_536;

/** Path of the sidecar relative to the skill directory. */
const CODEX_SIDECAR_RELATIVE_PATH = join("agents", "openai.yaml");

/**
 * Returns whether Codex's `agents/openai.yaml` sidecar disables implicit
 * (model) invocation for the skill at `skillDir`. See module docs for the
 * conservative default (false) on absent/malformed input.
 */
export function readCodexImplicitInvocationDisabled(skillDir: string): boolean {
  const sidecarPath = resolve(skillDir, CODEX_SIDECAR_RELATIVE_PATH);
  // Cheap stat gates the realpath + bounded open behind the sidecar actually
  // existing; openRootFileSync re-validates, so the race is harmless.
  if (!existsSync(sidecarPath)) {
    return false;
  }
  let rootRealPath: string;
  try {
    rootRealPath = realpathSync(skillDir);
  } catch {
    return false;
  }
  const opened = openRootFileSync({
    absolutePath: sidecarPath,
    rootPath: rootRealPath,
    rootRealPath,
    boundaryLabel: "skill root",
    maxBytes: CODEX_SIDECAR_MAX_BYTES,
  });
  if (!opened.ok) {
    return false;
  }
  try {
    const buffer = readFileDescriptorBoundedSync(opened.fd, CODEX_SIDECAR_MAX_BYTES);
    const parsed = parseYaml(buffer.toString("utf8")) as
      | { policy?: { allow_implicit_invocation?: unknown } }
      | null
      | undefined;
    return parsed?.policy?.allow_implicit_invocation === false;
  } catch {
    return false;
  } finally {
    closeSync(opened.fd);
  }
}
