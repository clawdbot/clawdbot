// Qa Lab plugin module implements desktop browser smoke behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { ensureRepoBoundDirectory, resolveRepoRelativeOutputDir } from "../cli-paths.js";
import { isTruthyOptIn, trimToValue } from "../mantis-options.runtime.js";
import {
  copyCrabboxArtifacts,
  type CommandRunner,
  type CrabboxInspect,
  defaultCommandRunner,
  inspectCrabbox,
  resolveCrabboxBin,
  runCommand,
  shellQuote,
  stopCrabbox,
  warmupCrabbox,
} from "./crabbox-runtime.js";

export type MantisDesktopBrowserSmokeOptions = {
  browserProfileArchiveEnv?: string;
  browserProfileDir?: string;
  browserUrl?: string;
  commandRunner?: CommandRunner;
  crabboxBin?: string;
  env?: NodeJS.ProcessEnv;
  htmlFile?: string;
  idleTimeout?: string;
  keepLease?: boolean;
  leaseId?: string;
  machineClass?: string;
  now?: () => Date;
  outputDir?: string;
  provider?: string;
  repoRoot?: string;
  ttl?: string;
  videoDurationSeconds?: number;
};

type MantisDesktopBrowserSmokeResult = {
  outputDir: string;
  reportPath: string;
  screenshotPath?: string;
  status: "pass" | "fail";
  summaryPath: string;
  videoPath?: string;
};

type MantisDesktopBrowserSmokeSummary = {
  artifacts: Omit<MantisDesktopBrowserSmokeResult, "outputDir" | "status">;
  browserUrl: string;
  htmlFile?: string;
  crabbox: {
    bin: string;
    createdLease: boolean;
    id: string;
    provider: string;
    slug?: string;
    state?: string;
    vncCommand: string;
  };
  error?: string;
  finishedAt: string;
  outputDir: string;
  remoteOutputDir: string;
  startedAt: string;
  status: "pass" | "fail";
};

const DEFAULT_BROWSER_URL = "https://openclaw.ai";
const DEFAULT_PROVIDER = "hetzner";
const DEFAULT_CLASS = "beast";
const DEFAULT_IDLE_TIMEOUT = "60m";
const DEFAULT_TTL = "120m";
const CRABBOX_BIN_ENV = "OPENCLAW_MANTIS_CRABBOX_BIN";
const CRABBOX_PROVIDER_ENV = "OPENCLAW_MANTIS_CRABBOX_PROVIDER";
const CRABBOX_CLASS_ENV = "OPENCLAW_MANTIS_CRABBOX_CLASS";
const CRABBOX_LEASE_ID_ENV = "OPENCLAW_MANTIS_CRABBOX_LEASE_ID";
const CRABBOX_KEEP_ENV = "OPENCLAW_MANTIS_KEEP_VM";
const CRABBOX_IDLE_TIMEOUT_ENV = "OPENCLAW_MANTIS_CRABBOX_IDLE_TIMEOUT";
const CRABBOX_TTL_ENV = "OPENCLAW_MANTIS_CRABBOX_TTL";
const BROWSER_PROFILE_ARCHIVE_ENV = "OPENCLAW_MANTIS_BROWSER_PROFILE_TGZ_B64";
const BROWSER_PROFILE_DIR_ENV = "OPENCLAW_MANTIS_BROWSER_PROFILE_DIR";
const DEFAULT_VIDEO_DURATION_SECONDS = 10;

function defaultOutputDir(repoRoot: string, startedAt: Date) {
  const stamp = startedAt.toISOString().replace(/[:.]/gu, "-");
  return path.join(repoRoot, ".artifacts", "qa-e2e", "mantis", `desktop-browser-${stamp}`);
}

function assertSafeEnvName(value: string, label: string) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)) {
    throw new Error(`${label} must be an environment variable name.`);
  }
}

function assertSafeRemoteProfileDir(value: string, label: string) {
  if (!value.startsWith("/") && !value.startsWith("$HOME/") && !value.startsWith("~/")) {
    throw new Error(`${label} must be an absolute path, ~/ path, or $HOME path.`);
  }
  if (value.includes("\n") || value.includes("\r") || value.includes("\0")) {
    throw new Error(`${label} must not contain control characters.`);
  }
}

function resolveRepoBoundFile(repoRoot: string, filePath: string, label: string) {
  const resolved = path.resolve(repoRoot, filePath);
  const relative = path.relative(repoRoot, resolved);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} must be inside the repository: ${filePath}`);
  }
  return resolved;
}

function renderRemoteScript(params: {
  browserUrl: string;
  browserProfileArchiveEnv: string;
  browserProfileDir?: string;
  htmlBase64?: string;
  remoteOutputDir: string;
  videoDurationSeconds: number;
}) {
  const shellUrl = shellQuote(params.browserUrl);
  const shellUrlJson = shellQuote(JSON.stringify(params.browserUrl));
  const htmlBase64 = shellQuote(params.htmlBase64 ?? "");
  const shellOutputDir = shellQuote(params.remoteOutputDir);
  const videoDurationSeconds = Math.max(1, Math.floor(params.videoDurationSeconds));
  const profileArchiveEnv = params.browserProfileArchiveEnv;
  const profileDir = shellQuote(
    params.browserProfileDir ?? `${params.remoteOutputDir}/chrome-profile`,
  );
  const temporaryProfile = params.browserProfileDir ? "false" : "true";
  const inputModeJson = shellQuote(JSON.stringify(params.htmlBase64 ? "html-file" : "url"));
  const openedUrlJson = shellQuote(
    JSON.stringify(
      params.htmlBase64 ? `file://${params.remoteOutputDir}/input.html` : params.browserUrl,
    ),
  );
  return `set -euo pipefail
out=${shellOutputDir}
url=${shellUrl}
url_json=${shellUrlJson}
html_b64=${htmlBase64}
input_mode_json=${inputModeJson}
opened_url_json=${openedUrlJson}
rm -rf "$out"
mkdir -p "$out"
if [ -n "$html_b64" ]; then
  printf '%s' "$html_b64" | base64 -d >"$out/input.html"
  url="file://$out/input.html"
fi
export DISPLAY="\${DISPLAY:-:99}"
if ! command -v scrot >/dev/null 2>&1; then
  sudo apt-get update -y >"$out/apt.log" 2>&1
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y scrot >>"$out/apt.log" 2>&1
fi
profile=${profileDir}
temporary_profile=${temporaryProfile}
mkdir -p "$profile"
profile_restored=false
profile_archive_b64="\${${profileArchiveEnv}:-}"
if [ -n "$profile_archive_b64" ]; then
  profile_archive="$profile/openclaw-mantis-browser-profile.tgz"
  printf '%s' "$profile_archive_b64" | base64 -d >"$profile_archive"
  tar -xzf "$profile_archive" -C "$profile"
  rm -f "$profile_archive"
  profile_restored=true
fi
browser_bin=""
for candidate in "\${BROWSER:-}" "\${CHROME_BIN:-}" google-chrome chromium chromium-browser; do
  if [ -n "$candidate" ] && command -v "$candidate" >/dev/null 2>&1; then
    browser_bin="$(command -v "$candidate")"
    break
  fi
done
if [ -z "$browser_bin" ]; then
  echo "No browser binary found. Checked BROWSER, CHROME_BIN, google-chrome, chromium, chromium-browser." >&2
  exit 127
fi
video_pid=""
if command -v ffmpeg >/dev/null 2>&1; then
  :
else
  sudo apt-get update -y >>"$out/apt.log" 2>&1 || true
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y ffmpeg >>"$out/apt.log" 2>&1 || true
fi
if command -v ffmpeg >/dev/null 2>&1; then
  display_input="$DISPLAY"
  case "$display_input" in
    *.*) ;;
    *) display_input="$display_input.0" ;;
  esac
  ffmpeg -hide_banner -loglevel error -y -f x11grab -framerate 15 -i "$display_input" -t ${videoDurationSeconds} -pix_fmt yuv420p "$out/desktop-browser-smoke.mp4" >"$out/ffmpeg.log" 2>&1 &
  video_pid=$!
else
  echo "ffmpeg missing; video artifact skipped" >"$out/ffmpeg.log"
fi
"$browser_bin" \
  --user-data-dir="$profile" \
  --no-first-run \
  --no-default-browser-check \
  --disable-dev-shm-usage \
  --window-size=1280,900 \
  --window-position=0,0 \
  --class=mantis-desktop-browser-smoke \
  "$url" >"$out/chrome.log" 2>&1 &
chrome_pid=$!
cleanup() {
  kill "$chrome_pid" >/dev/null 2>&1 || true
}
trap cleanup EXIT
sleep 8
scrot "$out/desktop-browser-smoke.png"
if [ -n "$video_pid" ]; then
  wait "$video_pid" || true
fi
cleanup
trap - EXIT
sleep 1
if [ "$temporary_profile" = "true" ]; then
  rm -rf "$profile" || true
fi
cat >"$out/remote-metadata.json" <<MANTIS_REMOTE_METADATA
{
  "browserUrl": $url_json,
  "browserBinary": "$browser_bin",
  "display": "$DISPLAY",
  "chromePid": $chrome_pid,
  "browserProfileArchiveEnv": "${profileArchiveEnv}",
  "browserProfileDir": "$profile",
  "browserProfileRestored": $profile_restored,
  "temporaryBrowserProfile": $temporary_profile,
  "inputMode": $input_mode_json,
  "openedUrl": $opened_url_json,
  "capturedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
MANTIS_REMOTE_METADATA
test -s "$out/desktop-browser-smoke.png"
`;
}

function renderReport(summary: MantisDesktopBrowserSmokeSummary) {
  const lines = [
    "# Mantis Desktop Browser Smoke",
    "",
    `Status: ${summary.status}`,
    `Browser URL: ${summary.browserUrl}`,
    summary.htmlFile ? `HTML file: ${summary.htmlFile}` : undefined,
    `Output: ${summary.outputDir}`,
    `Started: ${summary.startedAt}`,
    `Finished: ${summary.finishedAt}`,
    "",
    "## Crabbox",
    "",
    `- Provider: ${summary.crabbox.provider}`,
    `- Lease: ${summary.crabbox.id}${summary.crabbox.slug ? ` (${summary.crabbox.slug})` : ""}`,
    `- Created by run: ${summary.crabbox.createdLease}`,
    `- State: ${summary.crabbox.state ?? "unknown"}`,
    `- VNC: \`${summary.crabbox.vncCommand}\``,
    "",
    "## Artifacts",
    "",
    summary.artifacts.screenshotPath
      ? `- Screenshot: \`${path.basename(summary.artifacts.screenshotPath)}\``
      : "- Screenshot: missing",
    summary.artifacts.videoPath
      ? `- Video: \`${path.basename(summary.artifacts.videoPath)}\``
      : "- Video: missing",
    "- Remote metadata: `remote-metadata.json`",
    "- FFmpeg log: `ffmpeg.log`",
    "- Chrome log: `chrome.log`",
    summary.error ? `- Error: ${summary.error}` : undefined,
    "",
  ].filter((line) => line !== undefined);
  return `${lines.join("\n")}\n`;
}

function artifactFailure(results: PromiseSettledResult<unknown>[]): AggregateError | undefined {
  const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  return errors.length
    ? new AggregateError(errors, errors.map(formatErrorMessage).join("; "))
    : undefined;
}

async function inspectVisualArtifact(filePath: string): Promise<string | undefined> {
  const [inspection] = await Promise.allSettled([fs.lstat(filePath)]);
  if (inspection.status === "fulfilled" && inspection.value.isFile() && inspection.value.size > 0) {
    return filePath;
  }
  // Failure workflows upload raw paths: remove invalid entries, never symlink targets or directories.
  // Settle cleanup separately so a removal failure cannot replace the original inspection error.
  const results = await Promise.allSettled([fs.rm(filePath, { force: true })]);
  if (
    inspection.status === "rejected" &&
    (inspection.reason as NodeJS.ErrnoException).code !== "ENOENT"
  ) {
    results.unshift(inspection);
  }
  const error = artifactFailure(results);
  if (error) {
    throw error;
  }
}

export async function runMantisDesktopBrowserSmoke(
  opts: MantisDesktopBrowserSmokeOptions = {},
): Promise<MantisDesktopBrowserSmokeResult> {
  const env = opts.env ?? process.env;
  const startedAt = (opts.now ?? (() => new Date()))();
  const repoRoot = path.resolve(opts.repoRoot ?? process.cwd());
  const outputDir = await ensureRepoBoundDirectory(
    repoRoot,
    resolveRepoRelativeOutputDir(repoRoot, opts.outputDir) ?? defaultOutputDir(repoRoot, startedAt),
    "Mantis desktop browser smoke output directory",
    { mode: 0o755 },
  );
  const summaryPath = path.join(outputDir, "mantis-desktop-browser-smoke-summary.json");
  const reportPath = path.join(outputDir, "mantis-desktop-browser-smoke-report.md");
  const errorPath = path.join(outputDir, "error.txt");
  const visualPaths = ["desktop-browser-smoke.png", "desktop-browser-smoke.mp4"].map((name) =>
    path.join(outputDir, name),
  );
  const clearArtifacts = (paths: string[]) =>
    Promise.allSettled(paths.map((filePath) => fs.rm(filePath, { force: true })));
  // Retire old captures and reports before preflight can reject without publishing a new result.
  const initialCleanupError = artifactFailure(
    await clearArtifacts([...visualPaths, summaryPath, reportPath, errorPath]),
  );
  const crabboxBin = await resolveCrabboxBin({
    env,
    envName: CRABBOX_BIN_ENV,
    explicit: opts.crabboxBin,
    repoRoot,
  });
  const provider =
    trimToValue(opts.provider) ?? trimToValue(env[CRABBOX_PROVIDER_ENV]) ?? DEFAULT_PROVIDER;
  const machineClass =
    trimToValue(opts.machineClass) ?? trimToValue(env[CRABBOX_CLASS_ENV]) ?? DEFAULT_CLASS;
  const idleTimeout =
    trimToValue(opts.idleTimeout) ??
    trimToValue(env[CRABBOX_IDLE_TIMEOUT_ENV]) ??
    DEFAULT_IDLE_TIMEOUT;
  const ttl = trimToValue(opts.ttl) ?? trimToValue(env[CRABBOX_TTL_ENV]) ?? DEFAULT_TTL;
  const htmlFileOption = trimToValue(opts.htmlFile);
  const htmlFile = htmlFileOption
    ? resolveRepoBoundFile(repoRoot, htmlFileOption, "Mantis desktop HTML file")
    : undefined;
  const htmlBase64 = htmlFile
    ? Buffer.from(await fs.readFile(htmlFile)).toString("base64")
    : undefined;
  const browserUrl = htmlFile
    ? pathToFileURL(htmlFile).toString()
    : (trimToValue(opts.browserUrl) ?? DEFAULT_BROWSER_URL);
  const browserProfileArchiveEnv =
    trimToValue(opts.browserProfileArchiveEnv) ??
    trimToValue(env.OPENCLAW_MANTIS_BROWSER_PROFILE_ARCHIVE_ENV) ??
    BROWSER_PROFILE_ARCHIVE_ENV;
  assertSafeEnvName(browserProfileArchiveEnv, "Mantis browser profile archive env");
  const browserProfileDir =
    trimToValue(opts.browserProfileDir) ?? trimToValue(env[BROWSER_PROFILE_DIR_ENV]);
  if (browserProfileDir) {
    assertSafeRemoteProfileDir(browserProfileDir, "Mantis browser profile dir");
  }
  const videoDurationSeconds = Math.max(
    1,
    Math.floor(opts.videoDurationSeconds ?? DEFAULT_VIDEO_DURATION_SECONDS),
  );
  const runner = opts.commandRunner ?? defaultCommandRunner;
  const explicitLeaseId = trimToValue(opts.leaseId) ?? trimToValue(env[CRABBOX_LEASE_ID_ENV]);
  const keepLease = opts.keepLease ?? isTruthyOptIn(env[CRABBOX_KEEP_ENV]);
  const createdLease = explicitLeaseId === undefined;
  const remoteOutputDir = `/tmp/openclaw-mantis-desktop-${startedAt
    .toISOString()
    .replace(/[^0-9A-Za-z]/gu, "-")}`;
  let leaseId = explicitLeaseId;
  let inspected: CrabboxInspect | undefined;
  let errorMessage: string | undefined;
  const result: MantisDesktopBrowserSmokeResult = {
    outputDir,
    reportPath,
    status: "fail",
    summaryPath,
  };

  try {
    if (initialCleanupError) {
      throw initialCleanupError;
    }
    leaseId =
      leaseId ??
      (await warmupCrabbox({
        crabboxBin,
        cwd: repoRoot,
        env,
        idleTimeout,
        machineClass,
        provider,
        runner,
        ttl,
      }));
    inspected = await inspectCrabbox({
      crabboxBin,
      cwd: repoRoot,
      env,
      leaseId,
      provider,
      runner,
    });
    await runCommand({
      command: crabboxBin,
      args: [
        "run",
        "--provider",
        provider,
        "--id",
        leaseId,
        "--desktop",
        "--browser",
        "--no-sync",
        "--shell",
        "--",
        renderRemoteScript({
          browserProfileArchiveEnv,
          browserProfileDir,
          browserUrl,
          htmlBase64,
          remoteOutputDir,
          videoDurationSeconds,
        }),
      ],
      cwd: repoRoot,
      env,
      runner,
      stdio: "inherit",
    });
    try {
      await copyCrabboxArtifacts({
        cwd: repoRoot,
        env,
        exclude: ["chrome-profile/**"],
        inspect: inspected,
        outputDir,
        remoteOutputDir,
        runner,
      });
    } catch (error) {
      const cleanupError = artifactFailure(await clearArtifacts(visualPaths));
      throw cleanupError
        ? new Error(
            `${formatErrorMessage(error)}; artifact cleanup failed: ${cleanupError.message}`,
            { cause: error },
          )
        : error;
    }
    // Settle both inspections/cleanups before rejecting either capture; video is optional.
    const inspections = await Promise.allSettled(visualPaths.map(inspectVisualArtifact));
    const inspectionError = artifactFailure(inspections);
    if (inspectionError) {
      throw inspectionError;
    }
    const [screenshotPath, videoPath] = inspections.map((entry) =>
      entry.status === "fulfilled" ? entry.value : undefined,
    );
    if (!screenshotPath) {
      throw new Error(
        "Desktop browser screenshot copied from Crabbox is missing, empty, or not a regular file.",
      );
    }
    Object.assign(result, { screenshotPath, status: "pass", videoPath });
  } catch (error) {
    errorMessage = formatErrorMessage(error);
    await fs.writeFile(errorPath, `${errorMessage}\n`, "utf8");
  } finally {
    const summary: MantisDesktopBrowserSmokeSummary = {
      artifacts: {
        reportPath,
        summaryPath,
        screenshotPath: result.screenshotPath,
        videoPath: result.videoPath,
      },
      browserUrl,
      htmlFile,
      crabbox: {
        bin: crabboxBin,
        createdLease,
        id: leaseId ?? "unallocated",
        provider,
        ...(result.status === "pass" ? { slug: inspected?.slug, state: inspected?.state } : {}),
        vncCommand: leaseId
          ? `${crabboxBin} vnc --provider ${provider} --id ${leaseId} --open`
          : "unallocated",
      },
      error: errorMessage,
      finishedAt: new Date().toISOString(),
      outputDir,
      remoteOutputDir,
      startedAt: startedAt.toISOString(),
      status: result.status,
    };
    await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    await fs.writeFile(reportPath, renderReport(summary), "utf8");
    if (result.status === "pass" && createdLease && leaseId && !keepLease) {
      await stopCrabbox({ crabboxBin, cwd: repoRoot, env, leaseId, provider, runner });
    }
  }
  return result;
}
