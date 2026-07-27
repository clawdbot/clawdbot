// Control Ui I18N tests cover control ui i18n script behavior.
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  assertControlUiGeneratedArtifactsIsolated,
  resolveAllowedGeneratedMixBranch,
  shouldStrictControlUiI18n,
} from "../../scripts/ci-changed-scope.mjs";
import {
  analyzeControlUiCatalogs,
  flattenControlUiCatalog,
  formatControlUiCatalogFallbackDriftError,
} from "../../scripts/control-ui-i18n-verify.ts";
import {
  appendBoundedProcessOutput,
  assertNoControlUiFallbacks,
  buildBatchPrompt,
  filterPlaceholderCompatibleTranslations,
  parseTranslationBatchReply,
  runProcess,
  shouldReuseExistingTranslation,
} from "../../scripts/control-ui-i18n.ts";
import { collectControlUiRawCopyFromSource } from "../../scripts/lib/control-ui-i18n-raw-copy.ts";
import { createTempDirTracker } from "../helpers/temp-dir.js";

describe("control-ui-i18n generated ownership", () => {
  it("keeps generated locale snapshots out of source PRs", () => {
    expect(() =>
      assertControlUiGeneratedArtifactsIsolated([
        "ui/src/i18n/locales/en.ts",
        "ui/src/i18n/locales/de.ts",
        "ui/src/i18n/.i18n/de.meta.json",
      ]),
    ).toThrow("Control UI generated locale artifacts must be isolated from source changes");

    expect(() =>
      assertControlUiGeneratedArtifactsIsolated([
        "ui/src/i18n/locales/de.ts",
        "ui/src/i18n/.i18n/catalog-fallbacks.json",
        "ui/src/i18n/.i18n/de.meta.json",
        "ui/src/i18n/.i18n/de.tm.jsonl",
      ]),
    ).not.toThrow();

    expect(() =>
      assertControlUiGeneratedArtifactsIsolated([
        "ui/src/i18n/locales/de.ts",
        "ui/src/i18n/.i18n/glossary.de.json",
      ]),
    ).toThrow("Control UI generated locale artifacts must be isolated from source changes");

    expect(() =>
      assertControlUiGeneratedArtifactsIsolated([
        "ui/src/i18n/.i18n/catalog-fallbacks.json",
        "ui/src/i18n/.i18n/raw-copy-baseline.json",
      ]),
    ).toThrow("Control UI generated locale artifacts must be isolated from source changes");

    expect(() =>
      assertControlUiGeneratedArtifactsIsolated([
        "ui/src/i18n/locales/en.ts",
        "ui/src/i18n/.i18n/raw-copy-baseline.json",
      ]),
    ).not.toThrow();

    expect(() =>
      assertControlUiGeneratedArtifactsIsolated(
        ["package.json", "ui/src/i18n/locales/de.ts"],
        "release/2026.7.3",
      ),
    ).not.toThrow();
    expect(() =>
      assertControlUiGeneratedArtifactsIsolated(
        ["package.json", "ui/src/i18n/locales/de.ts"],
        "main",
      ),
    ).not.toThrow();

    expect(shouldStrictControlUiI18n(["ui/src/i18n/locales/de.ts"])).toBe(true);
    expect(shouldStrictControlUiI18n(["ui/src/i18n/locales/en.ts"])).toBe(false);
    expect(shouldStrictControlUiI18n(null)).toBe(true);
  });

  it("allows generated release output on trusted release and main runs only", () => {
    const trustedActions = {
      GITHUB_ACTIONS: "true",
      OPENCLAW_ALLOW_RELEASE_GENERATED_MIX: "true",
    };

    expect(
      resolveAllowedGeneratedMixBranch(
        {
          ...trustedActions,
          GITHUB_EVENT_NAME: "push",
          GITHUB_REF: "refs/heads/main",
        },
        "main",
      ),
    ).toBe("main");
    expect(
      resolveAllowedGeneratedMixBranch(
        {
          ...trustedActions,
          GITHUB_EVENT_NAME: "pull_request",
          GITHUB_REF: "refs/pull/1/merge",
        },
        "main",
      ),
    ).toBe("");
    expect(resolveAllowedGeneratedMixBranch(trustedActions, "release/2026.7.3")).toBe(
      "release/2026.7.3",
    );
    expect(resolveAllowedGeneratedMixBranch({ GITHUB_ACTIONS: "true" }, "release/2026.7.3")).toBe(
      "",
    );
  });
});

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitForProcessExit(pid: number, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error(`process ${pid} was still alive after ${timeoutMs}ms`);
}

async function waitForChildClose(
  child: ReturnType<typeof spawn>,
  timeoutMs = 2_000,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("child did not close before timeout"));
    }, timeoutMs);
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
}

describe("control-ui-i18n process runner", () => {
  it("points strict catalog drift at the generated release repair", () => {
    const message = formatControlUiCatalogFallbackDriftError();

    expect(message).toContain("pnpm ui:i18n:sync");
    expect(message).toContain("pnpm release:prep");
    expect(message).not.toContain("pnpm ui:i18n:baseline");
  });

  it("builds a deterministic fallback list without accepting catalog drift", () => {
    const source = flattenControlUiCatalog(
      { group: { first: "First {count}", second: "Second" } },
      "en",
    );
    const missingAnalysis = analyzeControlUiCatalogs(
      source,
      new Map([
        ["de", new Map([["group.first", "Erste {count}"]])],
        ["fr", new Map([["group.first", "Premiere {count}"]])],
      ]),
    );

    expect(missingAnalysis).toEqual({
      errors: [],
      fallbacks: { "group.second": ["de", "fr"] },
    });

    const driftAnalysis = analyzeControlUiCatalogs(
      source,
      new Map([
        [
          "fr",
          new Map([
            ["group.second", "Deuxieme"],
            ["group.first", "Premiere"],
            ["group.orphan", "Orpheline"],
          ]),
        ],
      ]),
    );
    expect(driftAnalysis.errors).toEqual([
      "fr: orphan keys: group.orphan",
      "fr: keys are not in English catalog order",
      "fr:group.first expected {count} got {}",
    ]);
    expect(driftAnalysis.fallbacks).toEqual({});
  });

  it("rejects invalid catalog leaf values", () => {
    expect(() => flattenControlUiCatalog({ group: { title: 42 } }, "fr")).toThrow(
      "fr:group.title must be a string or object",
    );
  });

  it("finds raw text and attributes split by template interpolation", () => {
    const source =
      'const jsx = <button aria-label="Archive" />; const view = html`<button title="Delete ${name}">Delete ${name}</button>`;';
    const sourceFile = ts.createSourceFile(
      "ui/src/pages/example.ts",
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );

    expect(
      collectControlUiRawCopyFromSource({
        filePath: path.resolve("ui/src/pages/example.ts"),
        source,
        sourceFile,
      }).map(({ kind, text }) => ({ kind, text })),
    ).toEqual([
      { kind: "html-attribute", text: "Archive" },
      { kind: "html-attribute", text: "Delete" },
      { kind: "html-text", text: "Delete" },
    ]);
  });

  it("keeps verification keyless even when provider credentials exist", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/control-ui-i18n-verify.ts", "verify"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: "redacted",
          OPENAI_API_KEY: "redacted",
        },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("source:");
    expect(result.stdout).not.toContain("provider=openai");
    expect(result.stdout).not.toContain("provider=anthropic");
  });

  it("rejects placeholder-corrupt batch replies before they leave the retry loop", () => {
    const items = [
      {
        cacheKey: "cache-key",
        key: "configView.viewPendingChange",
        text: "View pending change ({count})",
        textHash: "text-hash",
      },
    ];

    expect(() =>
      parseTranslationBatchReply(
        JSON.stringify({ "configView.viewPendingChange": "Pending change" }),
        items,
        "ar",
      ),
    ).toThrow("ar:configView.viewPendingChange expected {count} got {}");
    expect(
      parseTranslationBatchReply(
        JSON.stringify({ "configView.viewPendingChange": "Pending change ({count})" }),
        items,
        "ar",
      ),
    ).toEqual(new Map([["configView.viewPendingChange", "Pending change ({count})"]]));
  });

  it("makes placeholder-incompatible existing copy pending for bot repair", () => {
    const reusable = filterPlaceholderCompatibleTranslations(
      new Map([
        ["changed", "Waiting for {total}"],
        ["same", "Waiting for {count}"],
      ]),
      new Map([
        ["changed", "Warten auf {count}"],
        ["same", "Warten auf {count}"],
      ]),
    );

    expect([...reusable]).toEqual([["same", "Warten auf {count}"]]);
  });

  it("feeds the exact validation failure back into a retry prompt", () => {
    const items = [
      {
        cacheKey: "cache-key",
        key: "configView.viewPendingChange",
        text: "View pending change ({count})",
        textHash: "text-hash",
      },
    ];
    const validationError = "ar:configView.viewPendingChange expected {count} got {}";

    expect(buildBatchPrompt(items, validationError)).toContain(
      `failed validation. Correct that exact failure in the new response:\n${validationError}`,
    );
  });

  it("ships no recorded English fallbacks", () => {
    const metaDir = path.resolve("ui/src/i18n/.i18n");
    const fallbacks = readdirSync(metaDir)
      .filter((fileName) => fileName.endsWith(".meta.json"))
      .flatMap((fileName) => {
        const meta = JSON.parse(readFileSync(path.join(metaDir, fileName), "utf8")) as {
          fallbackKeys?: string[];
          locale?: string;
        };
        return (meta.fallbackKeys ?? []).map((key) => `${meta.locale ?? fileName}:${key}`);
      });

    expect(fallbacks).toEqual([]);
  });

  it("makes the strict gate reject recorded English fallbacks", () => {
    expect(() =>
      assertNoControlUiFallbacks([
        { fallbackCount: 0, locale: "de" },
        { fallbackCount: 2, locale: "fr" },
      ]),
    ).toThrow("fr: 2 fallback keys");
    expect(() =>
      assertNoControlUiFallbacks([
        { fallbackCount: 0, locale: "de" },
        { fallbackCount: 0, locale: "fr" },
      ]),
    ).not.toThrow();
  });

  it("refreshes recorded fallback copy when sync is forced without a provider", () => {
    expect(
      shouldReuseExistingTranslation({
        allowTranslate: false,
        force: true,
        isFallback: true,
      }),
    ).toBe(false);
    expect(
      shouldReuseExistingTranslation({
        allowTranslate: false,
        force: false,
        isFallback: true,
      }),
    ).toBe(true);
  });

  it("keeps a bounded process output tail", () => {
    const first = appendBoundedProcessOutput({ text: "", truncatedChars: 0 }, "abcdef", 5);
    const second = appendBoundedProcessOutput(first, "ghij", 5);

    expect(first).toEqual({ text: "bcdef", truncatedChars: 1 });
    expect(second).toEqual({ text: "fghij", truncatedChars: 5 });
  });

  it("bounds failure diagnostics to the newest output", async () => {
    await expect(
      runProcess(
        process.execPath,
        [
          "-e",
          [
            "process.stderr.write('stderr-begin-' + 'x'.repeat(128) + '-stderr-end', () => process.exit(2));",
          ].join(" "),
        ],
        { maxOutputChars: 64, rejectOnFailure: true },
      ),
    ).rejects.toThrow(/output truncated[\s\S]*stderr-end/u);
  });

  it("rejects successful commands before returning truncated stdout", async () => {
    await expect(
      runProcess(
        process.execPath,
        ["-e", "process.stdout.write('x'.repeat(128), () => process.exit(0));"],
        {
          maxOutputChars: 12,
        },
      ),
    ).rejects.toThrow("produced more than 12 stdout chars");
  });

  it.runIf(process.platform !== "win32")(
    "kills descendant processes after the process timeout",
    async () => {
      const tempDirs = createTempDirTracker();
      const tempDir = tempDirs.make("openclaw-control-ui-i18n-timeout-");
      try {
        const markerPath = path.join(tempDir, "grandchild.pid");
        const grandchildScript = [
          "process.on('SIGTERM', () => {});",
          "setInterval(() => {}, 1000);",
        ].join("\n");
        const parentScript = [
          "const { spawn } = require('node:child_process');",
          "const { writeFileSync } = require('node:fs');",
          `const grandchild = spawn(process.execPath, ["-e", ${JSON.stringify(grandchildScript)}], { stdio: "ignore" });`,
          `writeFileSync(${JSON.stringify(markerPath)}, String(grandchild.pid));`,
          "process.on('SIGTERM', () => {});",
          "setInterval(() => {}, 1000);",
        ].join("\n");

        await expect(
          runProcess(process.execPath, ["-e", parentScript], {
            cwd: tempDir,
            killGraceMs: 25,
            timeoutMs: 500,
          }),
        ).rejects.toThrow(`timed out after 500ms`);

        const grandchildPid = Number(readFileSync(markerPath, "utf8"));
        await waitForProcessExit(grandchildPid);
      } finally {
        tempDirs.cleanup();
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "waits for all process groups before re-raising parent signals",
    async () => {
      const tempDirs = createTempDirTracker();
      const tempDir = tempDirs.make("openclaw-control-ui-i18n-signal-");
      const fastReadyPath = path.join(tempDir, "fast-ready");
      const fastCommandPath = path.join(tempDir, "fast-command.mjs");
      const commandPath = path.join(tempDir, "command.mjs");
      const runnerPath = path.join(tempDir, "runner.mjs");
      const grandchildPidPath = path.join(tempDir, "grandchild.pid");
      let grandchildPid = 0;

      try {
        const grandchildScript = [
          "process.on('SIGTERM', () => {});",
          "setInterval(() => {}, 1000);",
        ].join("\n");
        writeFileSync(
          fastCommandPath,
          [
            "import { writeFileSync } from 'node:fs';",
            `writeFileSync(${JSON.stringify(fastReadyPath)}, "ready");`,
            "process.on('SIGTERM', () => process.exit(0));",
            "setInterval(() => {}, 1000);",
          ].join("\n"),
          "utf8",
        );
        writeFileSync(
          commandPath,
          [
            "import { spawn } from 'node:child_process';",
            "import { writeFileSync } from 'node:fs';",
            `const grandchild = spawn(process.execPath, ["--eval", ${JSON.stringify(
              grandchildScript,
            )}], { stdio: "ignore" });`,
            `writeFileSync(${JSON.stringify(grandchildPidPath)}, String(grandchild.pid));`,
            "process.on('SIGTERM', () => process.exit(0));",
            "setInterval(() => {}, 1000);",
          ].join("\n"),
          "utf8",
        );
        writeFileSync(
          runnerPath,
          [
            `const { runProcess } = await import(${JSON.stringify(
              pathToFileURL(path.resolve("scripts/control-ui-i18n.ts")).href,
            )});`,
            "void runProcess(process.execPath,",
            `  [${JSON.stringify(fastCommandPath)}],`,
            "  { killGraceMs: 100, timeoutMs: 30_000 },",
            ").catch(() => undefined);",
            "void runProcess(process.execPath,",
            `  [${JSON.stringify(commandPath)}],`,
            "  { killGraceMs: 100, timeoutMs: 30_000 },",
            ").catch(() => undefined);",
          ].join("\n"),
          "utf8",
        );

        const runner = spawn(process.execPath, ["--import", "tsx", runnerPath], {
          cwd: process.cwd(),
          stdio: "ignore",
        });

        try {
          const deadline = Date.now() + 30_000;
          let fastReady = false;
          while (Date.now() < deadline) {
            try {
              fastReady = readFileSync(fastReadyPath, "utf8") === "ready";
            } catch {}
            try {
              grandchildPid = Number(readFileSync(grandchildPidPath, "utf8"));
            } catch {}
            if (fastReady && grandchildPid > 0 && processIsAlive(grandchildPid)) {
              break;
            }
            await new Promise((resolve) => {
              setTimeout(resolve, 10);
            });
          }
          expect(fastReady).toBe(true);
          expect(grandchildPid).toBeGreaterThan(0);
          expect(processIsAlive(grandchildPid)).toBe(true);

          runner.kill("SIGTERM");

          await expect(waitForChildClose(runner)).resolves.toEqual({
            code: null,
            signal: "SIGTERM",
          });
          await waitForProcessExit(grandchildPid, 2_000);
        } finally {
          if (runner.pid && processIsAlive(runner.pid)) {
            runner.kill("SIGKILL");
          }
          if (grandchildPid > 0 && processIsAlive(grandchildPid)) {
            process.kill(grandchildPid, "SIGKILL");
          }
        }
      } finally {
        tempDirs.cleanup();
      }
    },
  );
});
