// QA evidence for the real Gateway support-export CLI and zip privacy boundary.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import JSZip from "jszip";
import { formatErrorMessage } from "../../../../src/infra/errors.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../helpers/openclaw-test-instance.js";
import { createQaScriptEvidenceWriter } from "./script-evidence.js";

const SOURCE_PATH = "test/e2e/qa-lab/runtime/gateway-support-export-runtime.ts";
const SCENARIO_ID = "gateway-support-export";

export type GatewaySupportExportRuntimeOptions = {
  artifactBase: string;
  repoRoot: string;
};

type DiagnosticsExportResult = {
  path: string;
  bytes: number;
  manifest: {
    contents: Array<{ path: string; bytes: number; mediaType: string }>;
    privacy: {
      payloadFree: boolean;
      rawLogsIncluded: boolean;
      notes: string[];
    };
  };
};

type GatewaySupportExportSummary = {
  archive: string;
  bytes: number;
  entries: string[];
  payloadFree: boolean;
  privateMode: boolean;
  rawLogsIncluded: boolean;
};

function parseOptions(
  argv: string[],
  repoRoot = process.cwd(),
): GatewaySupportExportRuntimeOptions {
  let artifactBase: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    const value = argv[index + 1];
    if (option !== "--artifact-base") {
      throw new Error(`unknown argument: ${option}`);
    }
    if (!value || value.startsWith("--")) {
      throw new Error("--artifact-base requires a value");
    }
    artifactBase = value;
    index += 1;
  }
  if (!artifactBase) {
    throw new Error("--artifact-base is required");
  }
  return { artifactBase: path.resolve(repoRoot, artifactBase), repoRoot };
}

function parseCliJson<T>(
  label: string,
  result: Awaited<ReturnType<OpenClawTestInstance["cli"]>>,
  parse: (value: unknown) => T = (value) => value as T,
): T {
  if (result.code !== 0) {
    throw new Error(
      `${label} failed with exit ${String(result.code)}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  try {
    return parse(JSON.parse(result.stdout) as unknown);
  } catch (error) {
    throw new Error(
      `${label} returned invalid JSON: ${formatErrorMessage(error)}\n${result.stdout}`,
      { cause: error },
    );
  }
}

async function readZipEntries(file: string): Promise<Record<string, string>> {
  const zip = await JSZip.loadAsync(await fs.readFile(file));
  const entries: Record<string, string> = {};
  for (const [name, entry] of Object.entries(zip.files)) {
    if (!entry.dir) {
      entries[name] = await entry.async("string");
    }
  }
  return entries;
}

function assertSafeArchiveEntries(entries: readonly string[]): void {
  for (const entry of entries) {
    assert.ok(entry.length > 0, "support zip entry must not be empty");
    assert.equal(path.posix.isAbsolute(entry), false, `absolute support zip entry: ${entry}`);
    assert.equal(
      entry.split("/").some((part) => part === "" || part === "." || part === ".."),
      false,
      `unsafe support zip entry: ${entry}`,
    );
  }
}

function createWriter(options: GatewaySupportExportRuntimeOptions) {
  return createQaScriptEvidenceWriter({
    artifactBase: options.artifactBase,
    logFileName: "gateway-support-export.log",
    primaryModel: "gateway/diagnostics-export",
    providerMode: "mock-openai",
    repoRoot: options.repoRoot,
    target: {
      id: SCENARIO_ID,
      title: "Gateway support diagnostics export",
      sourcePath: SOURCE_PATH,
      docsRefs: ["docs/gateway/diagnostics.md", "docs/cli/gateway.md"],
      codeRefs: [
        SOURCE_PATH,
        "src/cli/gateway-cli/register.ts",
        "src/logging/diagnostic-support-export.ts",
        "src/logging/diagnostic-support-bundle.ts",
      ],
    },
  });
}

export async function runGatewaySupportExportRuntime(options: GatewaySupportExportRuntimeOptions) {
  await fs.mkdir(options.artifactBase, { recursive: true });
  const writer = createWriter(options);
  const startedAt = Date.now();
  let instance: OpenClawTestInstance | undefined;
  try {
    instance = await createOpenClawTestInstance({
      name: "qa-gateway-support-export",
      config: {
        diagnostics: { enabled: true },
      },
      env: {
        OPENCLAW_TEST_FILE_LOG: "1",
      },
    });
    await instance.startGateway();

    const outputPath = path.join(options.artifactBase, "gateway-support-export.zip");
    const result = parseCliJson<DiagnosticsExportResult>(
      "gateway diagnostics export",
      await instance.cli(
        [
          "gateway",
          "diagnostics",
          "export",
          "--output",
          outputPath,
          "--log-lines",
          "7",
          "--log-bytes",
          "4096",
          "--url",
          instance.url,
          "--token",
          instance.gatewayToken,
          "--timeout",
          "10000",
          "--json",
        ],
        { timeoutMs: 120_000 },
      ),
    );

    assert.equal(path.resolve(result.path), path.resolve(outputPath));
    assert.ok(result.bytes > 0, "diagnostics export must be nonempty");
    assert.equal(result.manifest.privacy.payloadFree, true);
    assert.equal(result.manifest.privacy.rawLogsIncluded, false);

    const entries = await readZipEntries(outputPath);
    const entryNames = Object.keys(entries).toSorted();
    assertSafeArchiveEntries(entryNames);
    for (const required of [
      "config/sanitized.json",
      "config/shape.json",
      "diagnostics.json",
      "health/gateway-health.json",
      "logs/openclaw-sanitized.jsonl",
      "manifest.json",
      "status/gateway-status.json",
      "summary.md",
    ]) {
      assert.ok(entryNames.includes(required), `support zip missing ${required}`);
    }

    const combined = Object.values(entries).join("\n");
    for (const [label, privateValue] of [
      ["Gateway token", instance.gatewayToken],
      ["hook token", instance.hookToken],
      ["home directory", instance.homeDir],
      ["state directory", instance.stateDir],
    ] as const) {
      assert.equal(combined.includes(privateValue), false, `support zip leaked ${label}`);
    }
    assert.match(combined, /payload[- ]free/iu);
    assert.match(combined, /sanitized/iu);

    const mode = (await fs.stat(outputPath)).mode & 0o777;
    const privateMode = process.platform === "win32" || mode === 0o600;
    assert.equal(privateMode, true, `support zip mode must be 0600, got ${mode.toString(8)}`);

    const summary: GatewaySupportExportSummary = {
      archive: path.basename(outputPath),
      bytes: result.bytes,
      entries: entryNames,
      payloadFree: result.manifest.privacy.payloadFree,
      privateMode,
      rawLogsIncluded: result.manifest.privacy.rawLogsIncluded,
    };
    const summaryPath = path.join(options.artifactBase, "gateway-support-export-summary.json");
    await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    writer.appendLog(
      `gateway-support-export: files=${entryNames.length} bytes=${result.bytes} privateMode=${String(privateMode)}\n`,
    );
    return await writer.write({
      artifacts: [
        { kind: "summary", filePath: summaryPath },
        { kind: "archive", filePath: outputPath },
      ],
      details: `real CLI wrote ${entryNames.length} sanitized files in a private payload-free zip`,
      durationMs: Math.max(1, Date.now() - startedAt),
      status: "pass",
    });
  } catch (error) {
    const details = formatErrorMessage(error);
    writer.appendLog(`gateway-support-export: ${details}\n`);
    return await writer.write({
      details,
      durationMs: Math.max(1, Date.now() - startedAt),
      status: "fail",
    });
  } finally {
    await instance?.cleanup();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runGatewaySupportExportRuntime(parseOptions(process.argv.slice(2)))
    .then((evidence) => {
      const status = evidence.entries[0]?.result.status;
      process.stdout.write(`gateway-support-export: ${status}\n`);
      process.exitCode = status === "pass" ? 0 : 1;
    })
    .catch((error: unknown) => {
      process.stderr.write(`gateway-support-export: ${formatErrorMessage(error)}\n`);
      process.exitCode = 1;
    });
}
