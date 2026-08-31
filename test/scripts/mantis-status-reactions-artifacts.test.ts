import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { loadEvidenceManifest } from "../../scripts/mantis/publish-pr-evidence.mjs";

const scenario = "discord-status-reactions-tool-only";
const rootRelative = ".artifacts/qa-e2e/mantis/discord-status-reactions";
const tempDirs: string[] = [];
const workflow = parse(
  readFileSync(".github/workflows/mantis-discord-status-reactions.yml", "utf8"),
) as {
  jobs: Record<string, { steps: { id?: string; run?: string }[] }>;
};
const runScript = Object.values(workflow.jobs)
  .flatMap((job) => job.steps ?? [])
  .find((step) => step.id === "run_mantis")?.run;
if (!runScript) throw new Error("Missing Mantis run step");

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Replace only external capture/provider/preview commands; run the actual workflow's
// copy, cleanup, status, report, and jq manifest production against real local files.
const controlledCommands = String.raw`
pnpm() { return 0; }
ffmpeg() { return 0; }
ffprobe() { return 0; }
sudo() { echo "unexpected package installation" >&2; return 97; }
crabbox() {
  if [[ "$1" == warmup ]]; then echo cbx_117239; return 0; fi
  if [[ "$1" == stop ]]; then return 0; fi
  [[ "$1" == media && "$2" == preview ]] || return 98
  shift 2
  local input="" output="" clip=""
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --input) input="$2"; shift 2 ;;
      --output) output="$2"; shift 2 ;;
      --trimmed-video-output) clip="$2"; shift 2 ;;
      --json) shift ;;
      *) return 99 ;;
    esac
  done
  printf '%s\n' "$input" >> preview-calls.txt
  printf 'preview' > "$output"
  printf 'clip' > "$clip"
  printf '{}\n'
  if [[ -n "$FAIL_PREVIEW_LANE" && "$input" == */"$FAIL_PREVIEW_LANE"/* ]]; then return 1; fi
}
`;

function runWorkflow(videos: readonly string[], failedPreview = "", missingScreenshot = "") {
  const dir = mkdtempSync(path.join(tmpdir(), "mantis-status-artifacts-"));
  tempDirs.push(dir);
  for (const lane of ["baseline", "candidate"]) {
    const seed = path.join(dir, `${rootRelative}-worktrees`, lane, rootRelative, lane);
    mkdirSync(path.join(seed, "desktop-browser"), { recursive: true });
    writeFileSync(path.join(seed, `${scenario}-timeline.html`), "<h1>Synthetic timeline</h1>");
    writeFileSync(path.join(seed, `${scenario}-timeline.png`), "timeline fixture");
    writeFileSync(
      path.join(seed, "qa-evidence.json"),
      JSON.stringify({ entries: [{ result: { status: lane === "baseline" ? "fail" : "pass" } }] }),
    );
    if (missingScreenshot !== lane) {
      writeFileSync(
        path.join(seed, "desktop-browser", "desktop-browser-smoke.png"),
        "capture fixture",
      );
    }
    if (videos.includes(lane)) {
      writeFileSync(
        path.join(seed, "desktop-browser", "desktop-browser-smoke.mp4"),
        "video fixture",
      );
    }
  }
  const result = spawnSync(
    "bash",
    ["-c", controlledCommands + runScript.replace(/\$\{\{[^}]+\}\}/gu, "fixture-revision")],
    {
      cwd: dir,
      encoding: "utf8",
      timeout: 10_000,
      env: {
        PATH: process.env.PATH,
        OPENAI_API_KEY: "unused-fixture",
        OPENCLAW_QA_CONVEX_SITE_URL: "unused-fixture",
        OPENCLAW_QA_CONVEX_SECRET_CI: "unused-fixture",
        CRABBOX_COORDINATOR_TOKEN: "unused-fixture",
        FAIL_PREVIEW_LANE: failedPreview,
        GITHUB_OUTPUT: path.join(dir, "outputs.txt"),
        GITHUB_STEP_SUMMARY: path.join(dir, "summary.md"),
      },
    },
  );
  return { dir, result, root: path.join(dir, rootRelative) };
}

// The production workflow runs on Linux/Bash; this lane requires Bash and jq.
describe.skipIf(process.platform === "win32")("Mantis status-reactions artifact consumers", () => {
  it.each([
    { videos: [], failedPreview: "" },
    { videos: ["baseline"], failedPreview: "" },
    { videos: ["candidate"], failedPreview: "" },
    { videos: ["baseline", "candidate"], failedPreview: "" },
    { videos: ["baseline", "candidate"], failedPreview: "baseline" },
    { videos: ["baseline", "candidate"], failedPreview: "candidate" },
  ])(
    "publishes available videos $videos independently of failed preview $failedPreview",
    ({ videos, failedPreview }) => {
      const { dir, root, result } = runWorkflow(videos, failedPreview);
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      const manifest = loadEvidenceManifest(path.join(root, "mantis-evidence.json"));
      expect(manifest.comparison.pass).toBe(true);
      expect(manifest.artifacts.filter((entry) => entry.kind === "desktopScreenshot")).toHaveLength(
        2,
      );
      expect(
        manifest.artifacts.filter((entry) => entry.kind === "fullVideo").map((entry) => entry.lane),
      ).toEqual(videos);
      const previewLanes = videos.filter((lane) => lane !== failedPreview);
      for (const kind of ["motionPreview", "motionClip"]) {
        expect(
          manifest.artifacts.filter((entry) => entry.kind === kind).map((entry) => entry.lane),
        ).toEqual(previewLanes);
      }
      if (videos.length) {
        const calls = readFileSync(path.join(dir, "preview-calls.txt"), "utf8").trim().split("\n");
        expect(calls).toHaveLength(videos.length);
      } else {
        expect(() => readFileSync(path.join(dir, "preview-calls.txt"))).toThrow();
      }
      const report = readFileSync(path.join(root, "mantis-report.md"), "utf8");
      for (const lane of ["baseline", "candidate"]) {
        expect(report.includes(`${lane}/${scenario}-desktop.mp4`)).toBe(videos.includes(lane));
      }
      // Optional video must not weaken the publisher's required screenshot contract.
      rmSync(path.join(root, `baseline/${scenario}-desktop.png`));
      expect(() => loadEvidenceManifest(path.join(root, "mantis-evidence.json"))).toThrow(
        "Missing required artifact",
      );
    },
  );

  it("does not turn a missing screenshot into a successful screenshot-only capture", () => {
    const { result } = runWorkflow([], "", "baseline");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("desktop-browser-smoke.png");
  });

  it("keeps optional videos subject to the publisher's regular-file check", () => {
    const { root, result } = runWorkflow([]);
    expect(result.status, result.stderr).toBe(0);
    mkdirSync(path.join(root, `baseline/${scenario}-desktop.mp4`));
    expect(() => loadEvidenceManifest(path.join(root, "mantis-evidence.json"))).toThrow(
      "Artifact is not a file",
    );
  });
});
