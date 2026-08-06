import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/sandbox";
import { resolveLocalPathFromRootsSync } from "openclaw/plugin-sdk/security-runtime";
import { resolveQQBotPayloadLocalFilePath } from "../utils/platform.js";

// The temp root is process-stable, so resolve it once. Only the success value is
// cached: a transient provisioning failure returns null without poisoning later
// calls.
let cachedTrustedTmpRoot: string | undefined;
function trustedOpenClawTmpRoot(): string | null {
  if (cachedTrustedTmpRoot === undefined) {
    try {
      cachedTrustedTmpRoot = resolvePreferredOpenClawTmpDir();
    } catch {
      return null;
    }
  }
  return cachedTrustedTmpRoot;
}

/**
 * Resolve a local outbound media path against every trusted root, returning the
 * canonical path or null when it sits outside all of them.
 *
 * QQBot is the only channel that root-sandboxes outbound local files, and the
 * same check runs at three sites (`resolveOutboundMediaPath`, the voice send
 * re-check, and structured-payload validation), so they must all agree or a file
 * accepted at one gate is rejected at the next. Beyond the QQ Bot media storage
 * roots, this also trusts OpenClaw's permission-hardened temp root, where
 * framework scratch media is written (e.g. cron auto-TTS voice files). Core
 * already treats that temp root as a sanctioned media root (`buildMediaLocalRoots`);
 * without it here, auto-routed sends are dropped and cron delivery silently loses
 * the message.
 *
 * `allowMissing` lets callers accept a not-yet-flushed temp file (e.g. TTS still
 * writing) under the temp root; existence is then enforced later by the voice
 * send re-check before upload.
 */
export function resolveTrustedOutboundMediaPath(
  p: string,
  options: { allowMissing?: boolean } = {},
): string | null {
  const storageRootPath = resolveQQBotPayloadLocalFilePath(p);
  if (storageRootPath) {
    return storageRootPath;
  }

  const tmpRoot = trustedOpenClawTmpRoot();
  if (!tmpRoot) {
    return null;
  }
  return (
    resolveLocalPathFromRootsSync({
      filePath: p,
      roots: [tmpRoot],
      label: "OpenClaw temp media root",
      allowMissing: options.allowMissing === true,
    })?.path ?? null
  );
}
