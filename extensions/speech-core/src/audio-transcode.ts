import { spawn } from "node:child_process";
import { tempWorkspaceSync, resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/sandbox";

type TranscodeOutcome =
  | { ok: true; buffer: Buffer }
  | {
      ok: false;
      reason:
        | "platform-unsupported"
        | "invalid-extension"
        | "noop-same-container"
        | "no-recipe"
        | "transcoder-failed";
      detail?: string;
    };

/**
 * Best-effort audio container transcode using macOS `afconvert`.
 *
 * Used by the TTS pipeline to pre-encode synthesized audio into a channel's
 * preferred container (see `ChannelTtsVoiceDeliveryCapabilities.preferAudioFileFormat`)
 * so the channel's downstream does not have to perform a container
 * conversion of its own. Returns a discriminated outcome so callers can
 * distinguish "we didn't try" (platform/recipe/noop) from "we tried and the
 * transcoder failed", which is the case worth logging.
 *
 * Currently only macOS is supported because `afconvert` is the only widely
 * available encoder we ship a recipe for.
 */
export async function transcodeAudioBuffer(params: {
  audioBuffer: Buffer;
  sourceExtension: string;
  targetExtension: string;
  timeoutMs?: number;
}): Promise<TranscodeOutcome> {
  // Validate inputs first so callers get a specific reason regardless of
  // host platform. Platform-unsupported is the gate immediately before the
  // actual `afconvert` invocation.
  const source = normalizeExt(params.sourceExtension);
  const target = normalizeExt(params.targetExtension);
  if (!source || !target) {
    return { ok: false, reason: "invalid-extension" };
  }
  if (source === target) {
    return { ok: false, reason: "noop-same-container" };
  }
  const recipe = pickAfconvertRecipe(source, target);
  if (!recipe) {
    return { ok: false, reason: "no-recipe" };
  }
  if (process.platform !== "darwin") {
    return { ok: false, reason: "platform-unsupported" };
  }

  const tmp = tempWorkspaceSync({
    rootDir: resolvePreferredOpenClawTmpDir(),
    prefix: "tts-transcode-",
  });
  const inPath = tmp.write(`in.${source}`, params.audioBuffer);
  const outPath = tmp.path(`out.${target}`);
  try {
    const result = await runAfconvert({
      args: [...recipe, inPath, outPath],
      timeoutMs: params.timeoutMs ?? 5000,
    });
    if (!result.ok) {
      return { ok: false, reason: "transcoder-failed", detail: result.detail };
    }
    return { ok: true, buffer: tmp.read(`out.${target}`) };
  } catch (err) {
    return { ok: false, reason: "transcoder-failed", detail: (err as Error).message };
  } finally {
    tmp.cleanup();
  }
}

function normalizeExt(ext: string): string | undefined {
  // Pattern matches the sibling helper in src/media/audio-transcode.ts: a short
  // alphanumeric extension token. Keeps the value safe to interpolate into
  // tmp-file names below without introducing a path-traversal surface.
  const trimmed = ext.trim().toLowerCase().replace(/^\./, "");
  return /^[a-z0-9]{1,12}$/.test(trimmed) ? trimmed : undefined;
}

function pickAfconvertRecipe(_source: string, target: string): string[] | undefined {
  // Currently only the MP3->CAF path used by native Messages voice memos.
  if (target === "caf") {
    // Opus-in-CAF, mono, 24 kHz. Validated against macOS 15.x Messages.app's
    // native voice-memo CAF descriptor (1 ch, 24000 Hz, opus); other CAF
    // flavors (PCM, AAC) get downgraded to plain audio attachments along the
    // Messages.app path. If iMessage stops rendering the result
    // as a voice memo after a system update, try forcing frames-per-packet
    // explicitly via `opus@24000#480` and re-validate. See #72506.
    return ["-f", "caff", "-d", "opus@24000", "-c", "1"];
  }
  return undefined;
}

function runAfconvert(params: {
  args: string[];
  timeoutMs: number;
}): Promise<{ ok: true } | { ok: false; detail: string }> {
  return new Promise((resolve) => {
    const child = spawn("/usr/bin/afconvert", params.args, { stdio: "ignore" });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ ok: false, detail: `timeout-${params.timeoutMs}ms` });
    }, params.timeoutMs);
    child.once("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, detail: err.message });
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ ok: true });
      } else {
        resolve({ ok: false, detail: `exit-${code ?? "unknown"}` });
      }
    });
  });
}
