// Produces standalone QA Lab UX Matrix fixture artifacts for gallery and evidence tests.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { toRepoRelativePath } from "../../extensions/qa-lab/src/cli-paths.js";
import { resolveQaEvidenceEnvironment } from "../../extensions/qa-lab/src/evidence-environment.js";
import {
  QA_EVIDENCE_FILENAME,
  QA_EVIDENCE_SUMMARY_KIND,
  QA_EVIDENCE_SUMMARY_SCHEMA_VERSION,
  validateQaEvidenceSummaryJson,
  type QaEvidenceStatus,
  type QaEvidenceSummaryEntry,
  type QaEvidenceSummaryJson,
} from "../../extensions/qa-lab/src/evidence-summary.js";
import {
  ensurePlaywrightChromium,
  resolveSystemChromiumExecutablePath,
} from "../ensure-playwright-chromium.mjs";

const execFileAsync = promisify(execFile);
const SOURCE_PATH = "scripts/qa/ux-matrix-evidence-producer.ts";

type MatrixCell = {
  artifacts: Array<{ kind: string; path: string }>;
  failureReason?: string;
  stage: string;
  status: QaEvidenceStatus;
  surface: string;
  title: string;
  wallMs: number;
};

type ChromiumLauncher = Awaited<typeof import("playwright")>["chromium"];
type ChromiumBrowser = Awaited<ReturnType<ChromiumLauncher["launch"]>>;

type ProducerOptions = {
  artifactBase: string;
  repoRoot: string;
  skipVisualProof: boolean;
};

function usage() {
  return `Usage: node --import tsx scripts/qa/ux-matrix-evidence-producer.ts --artifact-base <dir> [options]

Produces a QA Lab UX Matrix evidence bundle.

Options:
  --artifact-base <dir>  Evidence artifact directory
  --repo-root <dir>      Repository root
  --skip-visual-proof    Use fixture visual evidence instead of Playwright screenshots
  -h, --help             Show this help
`;
}

function readOptionValue(argv: readonly string[], index: number, arg: string) {
  const value = argv[index + 1] ?? "";
  if (!value || value.startsWith("-")) {
    throw new Error(`${arg} requires a value`);
  }
  return value;
}

function isHelpRequest(argv: readonly string[]) {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact-base" || arg === "--repo-root") {
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      return true;
    }
  }
  return false;
}

function parseOptions(argv: readonly string[]): ProducerOptions {
  let artifactBase = "";
  let repoRoot = process.cwd();
  let skipVisualProof = false;
  const seen = new Set<string>();
  const recordOnce = (flag: string) => {
    if (seen.has(flag)) {
      throw new Error(`${flag} was provided more than once`);
    }
    seen.add(flag);
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact-base") {
      const value = readOptionValue(argv, index, arg);
      recordOnce(arg);
      artifactBase = value;
      index += 1;
      continue;
    }
    if (arg === "--repo-root") {
      const value = readOptionValue(argv, index, arg);
      recordOnce(arg);
      repoRoot = value;
      index += 1;
      continue;
    }
    if (arg === "--skip-visual-proof") {
      recordOnce(arg);
      skipVisualProof = true;
      continue;
    }
    throw new Error(`unsupported UX Matrix producer arg: ${arg}`);
  }
  if (!artifactBase.trim()) {
    throw new Error("--artifact-base is required");
  }
  if (!repoRoot.trim()) {
    throw new Error("--repo-root must not be empty");
  }
  return {
    artifactBase: path.resolve(repoRoot, artifactBase),
    repoRoot: path.resolve(repoRoot),
    skipVisualProof,
  };
}

type ProducerCliOutput = {
  error: (message: string) => void;
  log: (message: string) => void;
};

export async function runUxMatrixEvidenceProducerCli(
  argv: readonly string[],
  output: ProducerCliOutput = console,
): Promise<number> {
  try {
    if (isHelpRequest(argv)) {
      output.log(usage());
      return 0;
    }
    const result = await runUxMatrixEvidenceProducer(parseOptions(argv));
    output.log(`UX Matrix evidence: ${path.join(result.artifactBase, QA_EVIDENCE_FILENAME)}`);
    output.log(`UX Matrix entries: ${result.evidence.entries.length}`);
    return 0;
  } catch (error) {
    output.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function writeJson(filePath: string, value: unknown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeText(filePath: string, value: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, value, "utf8");
}

function cellDir(artifactBase: string, cell: Pick<MatrixCell, "stage" | "surface">) {
  return path.join(artifactBase, "surfaces", cell.surface, "stages", cell.stage);
}

function relativeToArtifactBase(artifactBase: string, filePath: string) {
  return path.relative(artifactBase, filePath).split(path.sep).join("/");
}

function sanitizeArtifactText(
  value: string,
  params: {
    artifactBase?: string;
    repoRoot: string;
  },
) {
  const roots = [
    { from: path.resolve(params.repoRoot), to: "<repo-root>" },
    { from: pathToFileURL(path.resolve(params.repoRoot)).href, to: "file://<repo-root>" },
    ...(params.artifactBase
      ? [
          { from: path.resolve(params.artifactBase), to: "<artifact-base>" },
          {
            from: pathToFileURL(path.resolve(params.artifactBase)).href,
            to: "file://<artifact-base>",
          },
        ]
      : []),
    { from: os.homedir(), to: "<home>" },
    { from: pathToFileURL(os.homedir()).href, to: "file://<home>" },
  ].filter((entry) => entry.from && entry.from !== path.parse(entry.from).root);
  return roots
    .toSorted((a, b) => b.from.length - a.from.length)
    .reduce((text, entry) => text.replaceAll(entry.from, entry.to), value);
}

function buildExecution(params: {
  artifacts: MatrixCell["artifacts"];
  repoRoot: string;
  source: string;
}): QaEvidenceSummaryEntry["execution"] {
  return {
    runner: "ux-matrix-script-producer",
    environment: resolveQaEvidenceEnvironment({
      env: process.env,
      repoRoot: params.repoRoot,
    }),
    provider: {
      id: "ux-matrix",
      live: false,
      model: {
        name: null,
        ref: null,
      },
      fixture: "local-qa-lab-script-producer",
    },
    packageSource: {
      kind: "source-checkout",
    },
    artifacts: params.artifacts.map((artifact) => ({
      ...artifact,
      source: params.source,
    })),
  };
}

function buildEvidenceEntry(cell: MatrixCell, repoRoot: string): QaEvidenceSummaryEntry {
  const source = `ux-matrix:${cell.surface}:${cell.stage}`;
  return {
    test: {
      kind: "ux-matrix-cell",
      id: `ux-matrix.${cell.surface}.${cell.stage}`,
      title: cell.title,
      source: { path: SOURCE_PATH },
    },
    // These entries prove the evidence/gallery infrastructure, not product taxonomy behavior.
    coverage: [],
    refs: [
      { kind: "code", path: SOURCE_PATH },
      { kind: "docs", path: "docs/concepts/qa-e2e-automation.md" },
    ],
    execution: buildExecution({
      artifacts: cell.artifacts,
      repoRoot,
      source,
    }),
    result: {
      status: cell.status,
      ...(cell.status === "pass"
        ? {}
        : {
            failure: {
              class: cell.status,
              reason: cell.failureReason ?? `${cell.status} UX Matrix cell`,
            },
          }),
      timing: {
        wallMs: Math.max(1, cell.wallMs),
      },
    },
  };
}

function buildEvidenceSummary(params: {
  cells: readonly MatrixCell[];
  generatedAt: string;
  repoRoot: string;
}): QaEvidenceSummaryJson {
  return validateQaEvidenceSummaryJson({
    kind: QA_EVIDENCE_SUMMARY_KIND,
    schemaVersion: QA_EVIDENCE_SUMMARY_SCHEMA_VERSION,
    generatedAt: params.generatedAt,
    evidenceMode: "full",
    entries: params.cells.map((cell) => buildEvidenceEntry(cell, params.repoRoot)),
  });
}

async function runCommandForCell(params: {
  args: string[];
  artifactBase: string;
  command: string;
  cwd: string;
  logPath: string;
  timeoutMs: number;
}) {
  const startedAt = Date.now();
  const commandLine = [params.command, ...params.args].join(" ");
  try {
    const { stdout, stderr } = await execFileAsync(params.command, params.args, {
      cwd: params.cwd,
      timeout: params.timeoutMs,
      env: process.env,
      maxBuffer: 1024 * 1024,
    });
    await writeText(
      params.logPath,
      sanitizeArtifactText(`$ ${commandLine}\n${stdout}${stderr}`, {
        artifactBase: params.artifactBase,
        repoRoot: params.cwd,
      }),
    );
    return {
      status: "pass" as const,
      wallMs: Date.now() - startedAt,
    };
  } catch (error) {
    const details = sanitizeArtifactText(error instanceof Error ? error.message : String(error), {
      artifactBase: params.artifactBase,
      repoRoot: params.cwd,
    });
    await writeText(params.logPath, `$ ${commandLine}\nblocked: ${details}\n`);
    return {
      failureReason: details,
      status: "blocked" as const,
      wallMs: Date.now() - startedAt,
    };
  }
}

async function writePreflight(artifactBase: string) {
  await writeText(
    path.join(artifactBase, "preflight", "runtime.txt"),
    [
      `platform=${process.platform}`,
      `arch=${process.arch}`,
      `node=${process.version}`,
      `freeMemoryBytes=${os.freemem()}`,
      `totalMemoryBytes=${os.totalmem()}`,
    ].join("\n") + "\n",
  );
}

async function writeSkippedVisualProof(logPath: string) {
  const startedAt = Date.now();
  await writeText(logPath, "blocked: --skip-visual-proof was set\n");
  return {
    failureReason: "--skip-visual-proof was set",
    status: "blocked" as const,
    wallMs: Date.now() - startedAt,
  };
}

function isMissingManagedPlaywrightBrowser(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("Executable doesn't exist") &&
    message.includes(".cache/ms-playwright") &&
    message.includes("playwright install")
  );
}

export async function launchUxMatrixChromium(params?: {
  chromium?: Pick<ChromiumLauncher, "launch">;
  systemExecutablePath?: string;
}): Promise<{ browser: ChromiumBrowser; usedSystemExecutablePath?: string }> {
  const chromium = params?.chromium ?? (await import("playwright")).chromium;
  try {
    return { browser: await chromium.launch() };
  } catch (error) {
    if (!isMissingManagedPlaywrightBrowser(error)) {
      throw error;
    }
    const executablePath = params?.systemExecutablePath ?? resolveSystemChromiumExecutablePath();
    if (!executablePath) {
      throw error;
    }
    return {
      browser: await chromium.launch({ executablePath }),
      usedSystemExecutablePath: executablePath,
    };
  }
}

export function ensureUxMatrixVideoDependencies(params: {
  ensureChromium?: typeof ensurePlaywrightChromium;
  usedSystemExecutablePath?: string;
}) {
  if (!params.usedSystemExecutablePath) {
    return;
  }
  const ensureChromium = params.ensureChromium ?? ensurePlaywrightChromium;
  const status = ensureChromium({
    ensureFfmpeg: true,
    systemExecutablePath: params.usedSystemExecutablePath,
  });
  if (status !== 0) {
    throw new Error(`Playwright ffmpeg install failed with status ${status}`);
  }
}

async function captureControlUiScreenshot(params: {
  artifactBase: string;
  htmlPath: string;
  logPath: string;
  repoRoot: string;
  screenshotPath: string;
  skipVisualProof: boolean;
}) {
  if (params.skipVisualProof) {
    return writeSkippedVisualProof(params.logPath);
  }
  const startedAt = Date.now();
  try {
    const { browser } = await launchUxMatrixChromium();
    try {
      const page = await browser.newPage({ viewport: { width: 1024, height: 720 } });
      await page.goto(pathToFileURL(params.htmlPath).href);
      await page.screenshot({ path: params.screenshotPath, fullPage: true });
    } finally {
      await browser.close();
    }
    await writeText(
      params.logPath,
      `Captured ${relativeToArtifactBase(params.artifactBase, params.screenshotPath)}\n`,
    );
    return {
      status: "pass" as const,
      wallMs: Date.now() - startedAt,
    };
  } catch (error) {
    const details = sanitizeArtifactText(error instanceof Error ? error.message : String(error), {
      artifactBase: params.artifactBase,
      repoRoot: params.repoRoot,
    });
    await writeText(params.logPath, `blocked: ${details}\n`);
    return {
      failureReason: details,
      status: "blocked" as const,
      wallMs: Date.now() - startedAt,
    };
  }
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function writeProducerArtifactFixtureHtml(params: {
  artifactBase: string;
  evidence: QaEvidenceSummaryJson;
  htmlPath: string;
  logPreview: string;
}) {
  const previewArtifacts = params.evidence.entries
    .filter((entry) => entry.test.id !== "ux-matrix.qa-lab.producer-artifact-fixture")
    .flatMap((entry) => entry.execution?.artifacts ?? []);
  const screenshotArtifact = previewArtifacts.find((artifact) => artifact.kind === "screenshot");
  const logArtifact = previewArtifacts.find((artifact) => artifact.kind === "log");
  const screenshotPath = screenshotArtifact
    ? relativeToArtifactBase(
        path.dirname(params.htmlPath),
        path.join(params.artifactBase, screenshotArtifact.path),
      )
    : "";
  const entryRows = params.evidence.entries
    .map(
      (entry) =>
        `<li><strong>${escapeHtml(entry.test.id)}</strong> - ${escapeHtml(
          entry.result.status,
        )} - ${entry.coverage.map((coverage) => escapeHtml(coverage.id)).join(", ")}</li>`,
    )
    .join("");
  await writeText(
    params.htmlPath,
    `<!doctype html>
<meta charset="utf-8">
<title>UX Matrix producer artifact fixture</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; background: #f6f7f9; color: #121417; }
  main { max-width: 980px; margin: 0 auto; padding: 28px; }
  h1 { font-size: 30px; margin: 0 0 8px; }
  .panel { background: white; border: 1px solid #d9dee7; border-radius: 8px; padding: 18px; margin-top: 18px; }
  .toolbar { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 12px; }
  button { border: 1px solid #8c98aa; background: #fff; border-radius: 6px; padding: 8px 12px; font: inherit; cursor: pointer; }
  button:focus { outline: 3px solid #91c5ff; }
  img { max-width: 100%; border: 1px solid #ccd3dd; border-radius: 6px; background: #fff; }
  pre { white-space: pre-wrap; background: #111827; color: #f9fafb; padding: 14px; border-radius: 6px; overflow: auto; }
  .meta { color: #526070; }
</style>
<main>
  <h1>UX Matrix Producer Artifact Fixture</h1>
  <p class="meta">Standalone script-produced ${escapeHtml(
    QA_EVIDENCE_FILENAME,
  )}; this fixture is not the QA Lab Evidence Archive UI or product-behavior proof.</p>
  <section class="panel">
    <h2>UX Matrix entries</h2>
    <ul>${entryRows}</ul>
  </section>
  <section class="panel">
    <h2>Artifact preview</h2>
    <p class="meta">${escapeHtml(logArtifact?.path ?? "no log")} - ${escapeHtml(
      screenshotArtifact?.path ?? "no screenshot",
    )}</p>
    <div class="toolbar">
      <button id="preview-screenshot" type="button">Preview screenshot artifact</button>
      <button id="preview-log" type="button">Preview log artifact</button>
    </div>
    <div id="preview" class="panel" aria-live="polite">Choose an artifact to preview.</div>
  </section>
</main>
<script>
  const preview = document.querySelector("#preview");
  document.querySelector("#preview-screenshot").addEventListener("click", () => {
    preview.innerHTML = ${JSON.stringify(
      screenshotPath
        ? `<img alt="UX Matrix screenshot artifact" src="${escapeHtml(screenshotPath)}">`
        : "<p>No screenshot artifact was produced.</p>",
    )};
  });
  document.querySelector("#preview-log").addEventListener("click", () => {
    preview.innerHTML = ${JSON.stringify(`<pre>${escapeHtml(params.logPreview)}</pre>`)};
  });
</script>
`,
  );
}

async function captureProducerArtifactFixtureProof(params: {
  artifactBase: string;
  htmlPath: string;
  logPath: string;
  repoRoot: string;
  screenshotPath: string;
  skipVisualProof: boolean;
  videoPath: string;
}) {
  if (params.skipVisualProof) {
    return writeSkippedVisualProof(params.logPath);
  }
  const startedAt = Date.now();
  try {
    const videoDir = path.join(path.dirname(params.videoPath), "recording");
    await fs.mkdir(videoDir, { recursive: true });
    const { browser, usedSystemExecutablePath } = await launchUxMatrixChromium();
    let recordedVideo: string | undefined;
    try {
      ensureUxMatrixVideoDependencies({ usedSystemExecutablePath });
      const context = await browser.newContext({
        viewport: { width: 1280, height: 820 },
        recordVideo: {
          dir: videoDir,
          size: { width: 1280, height: 820 },
        },
      });
      const page = await context.newPage();
      const video = page.video();
      await page.goto(pathToFileURL(params.htmlPath).href);
      await page.locator("#preview-screenshot").click();
      await page.locator("#preview img").waitFor({ state: "visible", timeout: 5_000 });
      await page.screenshot({ path: params.screenshotPath, fullPage: true });
      await page.waitForTimeout(350);
      await page.locator("#preview-log").click();
      await page.waitForTimeout(350);
      await context.close();
      recordedVideo = await video?.path();
    } finally {
      await browser.close();
    }
    if (!recordedVideo) {
      throw new Error("Playwright did not provide a recording path");
    }
    await fs.mkdir(path.dirname(params.videoPath), { recursive: true });
    await fs.copyFile(recordedVideo, params.videoPath);
    await writeText(
      params.logPath,
      [
        `Captured screenshot ${path.basename(params.screenshotPath)}`,
        `Captured recording ${path.basename(params.videoPath)}`,
      ].join("\n") + "\n",
    );
    return {
      status: "pass" as const,
      wallMs: Date.now() - startedAt,
    };
  } catch (error) {
    const details = sanitizeArtifactText(error instanceof Error ? error.message : String(error), {
      artifactBase: params.artifactBase,
      repoRoot: params.repoRoot,
    });
    await writeText(params.logPath, `blocked: ${details}\n`);
    return {
      failureReason: details,
      status: "blocked" as const,
      wallMs: Date.now() - startedAt,
    };
  }
}

async function writeProducerMetadata(params: {
  artifactBase: string;
  cells: readonly MatrixCell[];
  repoRoot: string;
}) {
  const counts = params.cells.reduce<Record<string, number>>((acc, cell) => {
    acc[cell.status] = (acc[cell.status] ?? 0) + 1;
    return acc;
  }, {});
  await writeJson(path.join(params.artifactBase, "manifest.json"), {
    kind: "openclaw.qa.ux-matrix",
    run: {
      status: counts.fail ? "fail" : counts.blocked ? "blocked" : "pass",
    },
  });
  await writeJson(path.join(params.artifactBase, "matrix.json"), {
    cells: params.cells.map((cell) => ({
      coverageIds: [],
      stage: cell.stage,
      status: cell.status,
      surface: cell.surface,
    })),
    counts,
  });
  await writeJson(path.join(params.artifactBase, "release-ledger.json"), {
    entries: params.cells.map((cell) => ({
      coverageIds: [],
      stage: cell.stage,
      status: cell.status,
      surface: cell.surface,
    })),
    kind: "openclaw.qa.ux-matrix.release-ledger",
  });
  await writeText(
    path.join(params.artifactBase, "commands.txt"),
    `node --import tsx ${SOURCE_PATH} --artifact-base ${toRepoRelativePath(
      params.repoRoot,
      params.artifactBase,
    )}\n`,
  );
  await writeText(
    path.join(params.artifactBase, "scorecard.md"),
    ["# UX Matrix", "", ...Object.entries(counts).map(([status, count]) => `- ${status}: ${count}`)]
      .join("\n")
      .trimEnd() + "\n",
  );
}

async function runUxMatrixEvidenceProducer(options: ProducerOptions) {
  await fs.mkdir(options.artifactBase, { recursive: true });
  await writePreflight(options.artifactBase);

  const cliLogPath = path.join(
    cellDir(options.artifactBase, { surface: "cli", stage: "entrypoint-help" }),
    "logs.txt",
  );
  const cliResult = await runCommandForCell({
    args: ["openclaw.mjs", "--help"],
    artifactBase: options.artifactBase,
    command: process.execPath,
    cwd: options.repoRoot,
    logPath: cliLogPath,
    timeoutMs: 30_000,
  });

  const screenshotCellDir = cellDir(options.artifactBase, {
    surface: "control-ui",
    stage: "screenshot-artifact",
  });
  const matrixHtmlPath = path.join(screenshotCellDir, "matrix-preview.html");
  await writeText(
    matrixHtmlPath,
    '<!doctype html><meta charset="utf-8"><title>UX Matrix</title><h1>UX Matrix</h1><p>Control UI artifact preview fixture generated by the scenario.</p>',
  );
  const matrixScreenshotPath = path.join(screenshotCellDir, "screenshot.png");
  const matrixScreenshotResult = await captureControlUiScreenshot({
    artifactBase: options.artifactBase,
    htmlPath: matrixHtmlPath,
    logPath: path.join(screenshotCellDir, "logs.txt"),
    repoRoot: options.repoRoot,
    screenshotPath: matrixScreenshotPath,
    skipVisualProof: options.skipVisualProof,
  });

  const initialCells: MatrixCell[] = [
    {
      artifacts: [
        {
          kind: "log",
          path: relativeToArtifactBase(
            options.artifactBase,
            path.join(screenshotCellDir, "logs.txt"),
          ),
        },
        ...(matrixScreenshotResult.status === "pass"
          ? [
              {
                kind: "screenshot",
                path: relativeToArtifactBase(options.artifactBase, matrixScreenshotPath),
              },
            ]
          : []),
      ],
      failureReason:
        "failureReason" in matrixScreenshotResult
          ? matrixScreenshotResult.failureReason
          : undefined,
      stage: "screenshot-artifact",
      status: matrixScreenshotResult.status,
      surface: "control-ui",
      title: "UX Matrix: screenshot artifact",
      wallMs: matrixScreenshotResult.wallMs,
    },
    {
      artifacts: [{ kind: "log", path: relativeToArtifactBase(options.artifactBase, cliLogPath) }],
      failureReason: cliResult.failureReason,
      stage: "entrypoint-help",
      status: cliResult.status,
      surface: "cli",
      title: "UX Matrix: CLI entrypoint help",
      wallMs: cliResult.wallMs,
    },
  ];

  const fixtureProofDir = cellDir(options.artifactBase, {
    surface: "qa-lab",
    stage: "producer-artifact-fixture",
  });
  const fixtureHtmlPath = path.join(fixtureProofDir, "producer-artifact-fixture.html");
  const previewEvidence = buildEvidenceSummary({
    cells: initialCells,
    generatedAt: new Date().toISOString(),
    repoRoot: options.repoRoot,
  });
  const screenshotLog = await fs.readFile(path.join(screenshotCellDir, "logs.txt"), "utf8");
  await writeProducerArtifactFixtureHtml({
    artifactBase: options.artifactBase,
    evidence: previewEvidence,
    htmlPath: fixtureHtmlPath,
    logPreview: screenshotLog,
  });

  const fixtureProofResult = await captureProducerArtifactFixtureProof({
    artifactBase: options.artifactBase,
    htmlPath: fixtureHtmlPath,
    logPath: path.join(fixtureProofDir, "logs.txt"),
    repoRoot: options.repoRoot,
    screenshotPath: path.join(fixtureProofDir, "producer-artifact-fixture.png"),
    skipVisualProof: options.skipVisualProof,
    videoPath: path.join(fixtureProofDir, "producer-artifact-fixture.webm"),
  });

  const cells: MatrixCell[] = [
    {
      artifacts: [
        { kind: "html", path: relativeToArtifactBase(options.artifactBase, fixtureHtmlPath) },
        {
          kind: "log",
          path: relativeToArtifactBase(
            options.artifactBase,
            path.join(fixtureProofDir, "logs.txt"),
          ),
        },
        ...(fixtureProofResult.status === "pass"
          ? [
              {
                kind: "screenshot",
                path: relativeToArtifactBase(
                  options.artifactBase,
                  path.join(fixtureProofDir, "producer-artifact-fixture.png"),
                ),
              },
              {
                kind: "video",
                path: relativeToArtifactBase(
                  options.artifactBase,
                  path.join(fixtureProofDir, "producer-artifact-fixture.webm"),
                ),
              },
            ]
          : []),
      ],
      failureReason:
        "failureReason" in fixtureProofResult ? fixtureProofResult.failureReason : undefined,
      stage: "producer-artifact-fixture",
      status: fixtureProofResult.status,
      surface: "qa-lab",
      title: "UX Matrix: producer artifact fixture",
      wallMs: fixtureProofResult.wallMs,
    },
    ...initialCells,
  ];

  const evidence = buildEvidenceSummary({
    cells,
    generatedAt: new Date().toISOString(),
    repoRoot: options.repoRoot,
  });
  await writeProducerArtifactFixtureHtml({
    artifactBase: options.artifactBase,
    evidence,
    htmlPath: fixtureHtmlPath,
    logPreview: screenshotLog,
  });
  await writeJson(path.join(options.artifactBase, QA_EVIDENCE_FILENAME), evidence);
  await writeJson(path.join(options.artifactBase, "latest-run.json"), {
    qaEvidence: QA_EVIDENCE_FILENAME,
  });
  await writeProducerMetadata({
    artifactBase: options.artifactBase,
    cells,
    repoRoot: options.repoRoot,
  });
  return {
    artifactBase: options.artifactBase,
    evidence,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await runUxMatrixEvidenceProducerCli(process.argv.slice(2));
}
