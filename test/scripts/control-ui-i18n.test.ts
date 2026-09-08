// Control Ui I18N tests cover control ui i18n script behavior.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import type { AssistantMessage } from "@openclaw/ai";
import * as ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertControlUiGeneratedArtifactsIsolated,
  resolveAllowedGeneratedMixBranch,
  shouldStrictControlUiI18n,
} from "../../scripts/ci-changed-scope.mjs";
import {
  analyzeControlUiCatalogs,
  flattenControlUiCatalog,
  formatControlUiCatalogFallbackDriftError,
  verifyControlUiReferencedKeys,
} from "../../scripts/control-ui-i18n-verify.ts";
import {
  appendBoundedProcessOutput,
  assertNoControlUiFallbacks,
  buildBatchPrompt,
  filterPlaceholderCompatibleTranslations,
  parseTranslationBatchReply,
  runProcess,
  translateNativeEntries,
} from "../../scripts/control-ui-i18n.ts";
import { collectControlUiRawCopyFromSource } from "../../scripts/lib/control-ui-i18n-raw-copy.ts";
import { registerTranscriptsEnglish } from "../../ui/src/i18n/locales/en-transcripts.ts";
import { waitForChildClose, waitForPidFile } from "../helpers/process-wait.js";
import { createTempDirTracker } from "../helpers/temp-dir.js";

vi.mock("../../scripts/lib/sleep.mjs", () => ({ sleep: async () => {} }));
const llm = vi.hoisted(() => ({ completeSimple: vi.fn() }));
vi.mock("@openclaw/ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openclaw/ai")>();
  return {
    ...actual,
    createLlmRuntime: () => ({ ...actual.createLlmRuntime(), completeSimple: llm.completeSimple }),
  };
});

describe("translation provider privacy and fallback", () => {
  const primary = "private-primary-fixture";
  const fallback = "private-fallback-fixture";
  const entries = Array.from({ length: 21 }, (_, index) => ({
    id: `label${index}`,
    source: "Open",
    sourcePath: "fixture.ts",
  }));
  const response = (overrides: Partial<AssistantMessage> = {}): AssistantMessage => ({
    role: "assistant",
    content: [
      {
        type: "text",
        text: JSON.stringify(Object.fromEntries(entries.map((entry) => [entry.id, "Ouvrir"]))),
      },
    ],
    api: "openai-responses",
    provider: "openai",
    model: primary,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
    ...overrides,
  });
  beforeEach(() => {
    llm.completeSimple.mockReset();
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    vi.stubEnv("OPENCLAW_CONTROL_UI_I18N_PROVIDER", "openai");
    vi.stubEnv("OPENCLAW_CONTROL_UI_I18N_MODEL", primary);
    vi.stubEnv("OPENCLAW_I18N_FALLBACK_MODEL", fallback);
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("reports CLI failures without disclosing configured model or key values", async () => {
    const result = await runProcess(process.execPath, [
      "--import",
      "./scripts/tsx.mjs",
      "scripts/control-ui-i18n.ts",
      "sync",
      "--locale",
      `${primary.toUpperCase()}/${fallback}/test-key`,
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr.trim()).toBe("unknown locale: [redacted]/[redacted]/[redacted]");
  });

  it("translates outside the Gateway runtime without state access or model diagnostics", async () => {
    const temp = createTempDirTracker();
    const stateDir = path.join(temp.make("openclaw-translation-runtime-"), "state");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    try {
      const scriptUrl = pathToFileURL(path.resolve("scripts/control-ui-i18n.ts")).href;
      const code = `
        import assert from "node:assert/strict";
        import net from "node:net";
        import { syncBuiltinESMExports } from "node:module";
        const rejectNetwork = () => { throw new Error("Unexpected network connection"); };
        net.connect = net.createConnection = net.Socket.prototype.connect = rejectNetwork;
        syncBuiltinESMExports();
        let requests = 0;
        globalThis.fetch = async () => {
          requests += 1;
          const item = { id: "message", type: "message", role: "assistant", content: [] };
          const text = JSON.stringify({ connect: "Connecter" });
          const events = [
            { type: "response.created", response: { id: "response" } },
            { type: "response.output_item.added", output_index: 0, item },
            { type: "response.content_part.added", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
            { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text },
            { type: "response.output_item.done", output_index: 0, item: { ...item, content: [{ type: "output_text", text, annotations: [] }] } },
            { type: "response.completed", response: { id: "response", status: "completed" } },
          ];
          return new Response(events.map(event => "data: " + JSON.stringify(event) + "\\n\\n").join(""), { headers: { "Content-Type": "text/event-stream" } });
        };
        const { translateNativeEntries } = await import(${JSON.stringify(scriptUrl)});
        const result = await translateNativeEntries([{ id: "connect", source: "Connect", sourcePath: "fixture" }], "fr");
        assert.equal(result.get("connect"), "Connecter");
        assert.equal(requests, 1);
        console.log("isolated-runtime-ok");
      `;
      const result = await runProcess(process.execPath, [
        "--import",
        "./scripts/tsx.mjs",
        "--input-type=module",
        "-e",
        code,
      ]);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain("isolated-runtime-ok");
      expect(result.stdout + result.stderr).not.toContain(primary);
      expect(result.stdout + result.stderr).not.toContain("[model-fetch]");
      expect(existsSync(stateDir)).toBe(false);
    } finally {
      temp.cleanup();
    }
  });

  it("switches only an unavailable model and keeps the fallback for later batches", async () => {
    const complete = vi
      .spyOn(llm, "completeSimple")
      .mockResolvedValueOnce(
        response({
          stopReason: "error",
          errorCode: "model_not_found",
          errorMessage: `Cannot use ${primary}`,
        }),
      )
      .mockResolvedValue(response());
    expect((await translateNativeEntries(entries, "fr")).size).toBe(entries.length);
    expect(complete.mock.calls.map(([model]) => model.id)).toEqual([primary, fallback, fallback]);
    const log = vi.mocked(process.stdout).write.mock.calls.flat().join("");
    expect(log).toContain("primary model unavailable");
    expect(log).not.toContain(primary);
    expect(log).not.toContain(fallback);
  });

  it.each(["401", "403", "404", "429", "insufficient_quota", "ECONNRESET"])(
    "keeps %s failures private without changing models",
    async (errorCode) => {
      const complete = vi.spyOn(llm, "completeSimple").mockResolvedValue(
        response({
          stopReason: "error",
          errorCode,
          errorMessage: `${errorCode}: ${primary} unavailable; try ${fallback}`,
        }),
      );
      await expect(translateNativeEntries(entries.slice(0, 1), "fr")).rejects.toThrow(
        "translation provider failed",
      );
      expect(complete.mock.calls.every(([model]) => model.id === primary)).toBe(true);
      const log = vi.mocked(process.stdout).write.mock.calls.flat().join("");
      expect(log).not.toContain(primary);
      expect(log).not.toContain(fallback);
    },
  );

  it("does not expose rejected provider errors or escaped model echoes", async () => {
    const complete = vi
      .spyOn(llm, "completeSimple")
      .mockRejectedValue(new Error(`Transport for ${primary}`));
    await expect(translateNativeEntries(entries.slice(0, 1), "fr")).rejects.toThrow(
      "provider_error",
    );
    complete.mockResolvedValue(
      response({ content: [{ type: "text", text: '{"label0":"private-\\u0070rimary-fixture"}' }] }),
    );
    await expect(translateNativeEntries(entries.slice(0, 1), "fr")).rejects.toThrow(
      "provider_error",
    );
    expect(vi.mocked(process.stdout).write.mock.calls.flat().join("")).not.toContain(primary);
  });
});

describe("control-ui-i18n generated ownership", () => {
  it("includes lazy transcript copy and shared search labels in the generator catalog", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "./scripts/tsx.mjs",
        "--input-type=module",
        "--eval",
        [
          'import { loadControlUiSourceCatalog } from "./scripts/lib/control-ui-i18n-catalog.ts";',
          "const catalog = loadControlUiSourceCatalog();",
          "console.log(JSON.stringify(catalog));",
        ].join("\n"),
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    const catalog: unknown = JSON.parse(result.stdout);
    const source = flattenControlUiCatalog(catalog, "en");
    const lazyCopy = flattenControlUiCatalog(registerTranscriptsEnglish.catalog, "transcripts");
    for (const [key, value] of lazyCopy) {
      expect(source.get(key), key).toBe(value);
    }
    expect(source.get("meetingCapture.title")).toBe("Meeting capture");
    expect(source.get("meetingCapture.sources")).toBe("Auto-start sources");
  });

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
    ).not.toThrow();

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

    expect(shouldStrictControlUiI18n(["ui/src/i18n/locales/de.ts"])).toBe(false);
    expect(shouldStrictControlUiI18n(["ui/src/i18n/.i18n/de.tm.jsonl"])).toBe(true);
    expect(shouldStrictControlUiI18n(["ui/src/i18n/locales/en.ts"])).toBe(false);
    expect(shouldStrictControlUiI18n(null)).toBe(true);
  });

  it("allows only a complete canonical translation-memory ownership migration", () => {
    const locales = readdirSync(path.resolve("ui/src/i18n/.i18n"))
      .filter((fileName) => fileName.endsWith(".tm.jsonl"))
      .map((fileName) => fileName.slice(0, -".tm.jsonl".length));
    const owners = [
      ".gitattributes",
      "scripts/ci-changed-scope.mjs",
      "scripts/control-ui-i18n.ts",
      "scripts/control-ui-i18n-verify.ts",
      "scripts/lib/control-ui-i18n-catalog.ts",
      "scripts/lib/control-ui-i18n-sync-plan.ts",
      "ui/AGENTS.md",
      "ui/config/control-ui-locales.ts",
      "ui/vite.config.ts",
    ];
    const adapters = locales.map((locale) => `ui/src/i18n/locales/${locale}.ts`);
    const generated = [
      "ui/src/i18n/.i18n/catalog-fallbacks.json",
      ...locales.flatMap((locale) => [
        `ui/src/i18n/.i18n/${locale}.tm.jsonl`,
        `ui/src/i18n/.i18n/${locale}.meta.json`,
      ]),
    ];
    const migration = [...owners, ...adapters, ...generated];

    expect(() => assertControlUiGeneratedArtifactsIsolated(migration)).not.toThrow();
    expect(() => assertControlUiGeneratedArtifactsIsolated(migration.slice(1))).toThrow(
      "Control UI generated locale artifacts must be isolated",
    );
    expect(() =>
      assertControlUiGeneratedArtifactsIsolated(
        migration.filter((filePath) => filePath !== generated[1]),
      ),
    ).toThrow("Control UI generated locale artifacts must be isolated");
    expect(() =>
      assertControlUiGeneratedArtifactsIsolated([...migration, "ui/src/i18n/.i18n/other.tm.jsonl"]),
    ).toThrow("Control UI generated locale artifacts must be isolated");
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

  it("rejects literal keys and template prefixes missing from the English catalog", () => {
    const source = flattenControlUiCatalog(
      { common: { ok: "OK" }, workboard: { status: { ready: "Ready" } } },
      "en",
    );
    const content = [
      't("common.ok");',
      't("common.missing");',
      "t(`workboard.status.${status}`);",
      "t(`workboard.missing.${status}`);",
    ].join("\n");

    expect(() =>
      verifyControlUiReferencedKeys(source, [{ content, relativeFile: "ui/src/pages/example.ts" }]),
    ).toThrowError(
      [
        "control-ui referenced translation key verification failed.",
        'ui/src/pages/example.ts:2: missing English catalog key "common.missing"',
        'ui/src/pages/example.ts:4: missing English catalog subtree "workboard.missing."',
      ].join("\n"),
    );
  });

  it("finds raw text and attributes split by template interpolation", () => {
    const source =
      'const jsx = <button aria-label="Archive" />; const view = html`<button title="Delete ${name}">Delete ${name}</button>`; const image = html`<img alt="Preview" />`; menu.setAttribute("aria-label", "Selection actions"); reply.setAttribute("aria-label", `Reply to ${name}`); file.setAttribute("title", "Open " + fileName);';
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
      { kind: "html-attribute", text: "Preview" },
      { kind: "html-attribute", text: "Delete" },
      { kind: "html-text", text: "Delete" },
      { kind: "html-attribute", text: "Selection actions" },
      { kind: "html-attribute", text: "Reply to" },
      { kind: "html-attribute", text: "Open" },
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

  it("runs an optional result validator before accepting a batch reply", () => {
    const items = [
      {
        cacheKey: "cache-key",
        key: "native.apple.progress",
        text: "Processed %lld of %@",
        textHash: "text-hash",
      },
    ];

    expect(() =>
      parseTranslationBatchReply(
        JSON.stringify({ "native.apple.progress": "Bearbetade %@" }),
        items,
        "sv",
        (source, translated, key, locale) => {
          if (source.includes("%lld") && !translated.includes("%lld")) {
            throw new Error(`invalid structural tokens for ${locale}:${key}`);
          }
        },
      ),
    ).toThrow("invalid structural tokens for sv:native.apple.progress");
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

  it("keeps a bounded process output tail", () => {
    const first = appendBoundedProcessOutput({ text: "", truncatedChars: 0 }, "abcdef", 5);
    const second = appendBoundedProcessOutput(first, "ghij", 5);

    expect(first).toEqual({ text: "bcdef", truncatedChars: 1 });
    expect(second).toEqual({ text: "fghij", truncatedChars: 5 });
  });

  it("does not split a UTF-16 surrogate pair at the tail boundary", () => {
    // "ab😀cdef" is 8 UTF-16 code units: a, b, <high>, <low>, c, d, e, f.
    // maxChars = 5 forces a tail slice whose boundary lands inside the surrogate pair.
    // The raw `slice(-5)` would return "<low>cdef" (leading dangling low surrogate).
    // sliceUtf16Safe advances past the low surrogate, retaining "cdef" (4 units);
    // truncatedChars must reflect the 4 actually-dropped units, not maxChars.
    const result = appendBoundedProcessOutput({ text: "", truncatedChars: 0 }, "ab😀cdef", 5);
    expect(result.text.length).toBeLessThanOrEqual(5);
    // No dangling surrogate (high 0xd800-0xdbff or low 0xdc00-0xdfff) at either edge.
    expect(result.text.charCodeAt(0)).toBeLessThan(0xd800);
    expect(result.text.charCodeAt(result.text.length - 1)).toBeLessThan(0xd800);
    expect(result.text).toBe("cdef");
    expect(result.truncatedChars).toBe(4);
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

        const grandchildPid = await waitForPidFile(markerPath, 1_000);
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
          grandchildPid = await waitForPidFile(grandchildPidPath, 30_000);
          let fastReady = false;
          while (Date.now() < deadline) {
            try {
              fastReady = readFileSync(fastReadyPath, "utf8") === "ready";
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

          await expect(waitForChildClose(runner, 2_000)).resolves.toEqual({
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
