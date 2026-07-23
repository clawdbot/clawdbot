// Database-first legacy-store guard tests cover runtime state-file regressions.
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectDatabaseFirstNativeLegacyStoreViolations,
  collectDatabaseFirstLegacyStoreSourceFiles,
  collectDatabaseFirstLegacyStoreViolations,
} from "../../scripts/check-database-first-legacy-stores.mjs";

type LegacyStoreViolations = ReturnType<typeof collectDatabaseFirstLegacyStoreViolations>;
type UnnamedViolationCase = {
  source: string;
  filename: string;
  expected: LegacyStoreViolations;
};

function sourceCase(source: TemplateStringsArray) {
  return (filename: string, expected: LegacyStoreViolations): UnnamedViolationCase => ({
    source: source.join(""),
    filename,
    expected,
  });
}

function namedCases(cases: Record<string, UnnamedViolationCase>) {
  return Object.entries(cases).map(([name, testCase]) => ({ name, ...testCase }));
}

describe("check-database-first-legacy-stores", () => {
  it("collects JavaScript runtime source files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-db-first-guard-"));
    try {
      await fs.mkdir(path.join(root, "src"), { recursive: true });
      await fs.writeFile(path.join(root, "src", "runtime.js"), "export {};\n");
      await fs.writeFile(path.join(root, "src", "worker.mjs"), "export {};\n");
      await fs.writeFile(path.join(root, "src", "types.ts"), "export {};\n");
      await fs.writeFile(path.join(root, "src", "runtime.test.js"), "export {};\n");
      await fs.writeFile(path.join(root, "src", "test-helpers.ts"), "export {};\n");
      await fs.writeFile(path.join(root, "src", "test-support.ts"), "export {};\n");
      await fs.writeFile(path.join(root, "src", "worker.test-helpers.ts"), "export {};\n");

      const files = await collectDatabaseFirstLegacyStoreSourceFiles([path.join(root, "src")]);
      const relativeFiles = files
        .map((file) => path.relative(root, file).replaceAll(path.sep, "/"))
        .toSorted();

      expect(relativeFiles).toEqual(["src/runtime.js", "src/types.ts", "src/worker.mjs"]);
    } finally {
      await fs.rm(root, { force: true, recursive: true });
    }
  });

  it("skips generated extension asset and dist bundles", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-db-first-guard-"));
    try {
      await fs.mkdir(path.join(root, "extensions", "diffs", "assets"), { recursive: true });
      await fs.mkdir(path.join(root, "extensions", "diffs", "dist", "assets"), {
        recursive: true,
      });
      await fs.mkdir(path.join(root, "extensions", "diffs", "src"), { recursive: true });
      await fs.mkdir(path.join(root, "packages", "plugin-sdk", "dist"), { recursive: true });
      await fs.mkdir(path.join(root, "packages", "plugin-sdk", "src"), { recursive: true });
      await fs.writeFile(
        path.join(root, "extensions", "diffs", "assets", "viewer-runtime.js"),
        "export const bundled = true;\n",
      );
      await fs.writeFile(
        path.join(root, "extensions", "diffs", "dist", "assets", "viewer-runtime.js"),
        "export const bundled = true;\n",
      );
      await fs.writeFile(
        path.join(root, "extensions", "diffs", "src", "runtime.js"),
        "export const runtime = true;\n",
      );
      await fs.writeFile(
        path.join(root, "packages", "plugin-sdk", "dist", "index.js"),
        "export const bundled = true;\n",
      );
      await fs.writeFile(
        path.join(root, "packages", "plugin-sdk", "src", "index.js"),
        "export const runtime = true;\n",
      );

      const files = await collectDatabaseFirstLegacyStoreSourceFiles([
        path.join(root, "extensions"),
        path.join(root, "packages"),
      ]);
      const relativeFiles = files
        .map((file) => path.relative(root, file).replaceAll(path.sep, "/"))
        .toSorted();

      expect(relativeFiles).toEqual([
        "extensions/diffs/src/runtime.js",
        "packages/plugin-sdk/src/index.js",
      ]);
    } finally {
      await fs.rm(root, { force: true, recursive: true });
    }
  });

  it("ignores deeply nested type-only syntax", () => {
    const nestedType = Array.from({ length: 600 }).reduce<string>(
      (type) => `Readonly<${type}>`,
      "string",
    );
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        type DeepRuntimeSchema = ${nestedType};
        export const ok: DeepRuntimeSchema | null = null;
      `,
      "src/runtime/deep-type-only-schema.ts",
    );

    expect(violations).toEqual([]);
  });

  // Core source analysis and initial legacy-store detection.
  it.each(
    namedCases({
      "terminates analysis for self-recursive helper wrappers": sourceCase`
        function normalize(value: unknown): unknown {
          if (Array.isArray(value)) {
            return value.map((entry) => normalize(entry));
          }
          return value;
        }
        normalize([]);
      `("src/runtime/self-recursive-helper.ts", []),
      "flags runtime writes to legacy sessions.json stores": sourceCase`
        import { promises as fs } from "node:fs";
        import path from "node:path";
        export async function save(dir: string) {
          await fs.writeFile(path.join(dir, "sessions.json"), "{}\\n", "utf8");
        }
      `("src/runtime/session-writer.ts", [{ kind: "legacy store filesystem write", line: 5 }]),
    }),
  )("$name", ({ source, filename, expected }) => {
    const violations = collectDatabaseFirstLegacyStoreViolations(source, filename);

    expect(violations).toEqual(expected);
  });

  it("keeps legacy restart sentinel filesystem access in its sole migration owner", () => {
    const runtimeViolations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { readFile } from "node:fs/promises";
        import path from "node:path";
        const legacyFilename = "restart-sentinel.json";
      `,
      "src/infra/restart-sentinel.ts",
    );
    const migrationViolations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { readFile } from "node:fs/promises";
        import path from "node:path";
        const legacyFilename = "restart-sentinel.json";
      `,
      "src/infra/state-migrations.restart-sentinel.ts",
    );

    expect(runtimeViolations).toEqual([
      { kind: "legacy restart sentinel filesystem import", line: 2 },
      { kind: "legacy restart sentinel filesystem import", line: 3 },
      { kind: "legacy restart sentinel reference", line: 4 },
    ]);
    expect(migrationViolations).toEqual([]);
  });

  // Legacy paths and literal propagation.
  it.each(
    namedCases({
      "flags legacy restart sentinel references outside the migration owner": sourceCase`
        const legacyPath = path.join(stateDir, "restart-sentinel.json");
        await readFile(legacyPath, "utf8");
      `("src/commands/doctor/state-migrations.ts", [
        { kind: "legacy restart sentinel reference", line: 2 },
      ]),
      "allows the CLI preflight to detect exact legacy restart sentinel inputs": sourceCase`
        [
          path.join(stateDir, "restart-sentinel.json"),
          path.join(stateDir, "restart-sentinel.json.doctor-importing"),
        ].some(fileOrDirExists);
      `("src/cli/program/config-guard.ts", []),
      "flags direct legacy restart sentinel reads from the CLI preflight": sourceCase`
        await readFile(path.join(stateDir, "restart-sentinel.json"), "utf8");
        await readFile(path.join(stateDir, "restart-sentinel.json.doctor-importing"), "utf8");
      `("src/cli/program/config-guard.ts", [
        { kind: "legacy restart sentinel reference", line: 2 },
        { kind: "legacy restart sentinel reference", line: 3 },
      ]),
      "flags nested restart sentinel paths disguised as CLI preflight detection": sourceCase`
        [path.join(stateDir, "archive/restart-sentinel.json")].some(fileOrDirExists);
      `("src/cli/program/config-guard.ts", [
        { kind: "legacy restart sentinel reference", line: 2 },
      ]),
      "flags retired Diffs viewer sidecar writes": sourceCase`
        import { promises as fs } from "node:fs";
        import path from "node:path";
        await fs.writeFile(path.join(root, id, "viewer.html"), html);
        await fs.writeFile(path.join(root, id, "meta.json"), metadata);
        await fs.writeFile(path.join(root, id, "file-meta.json"), metadata);
      `("extensions/diffs/src/legacy-store.ts", [
        { kind: "legacy store filesystem write", line: 4 },
        { kind: "legacy store filesystem write", line: 5 },
        { kind: "legacy store filesystem write", line: 6 },
      ]),
      "flags retired QMD file-lock sidecars": sourceCase`
        import { withFileLock } from "openclaw/plugin-sdk/file-lock";
        import path from "node:path";
        await withFileLock(path.join(stateDir, "qmd", "embed.lock"), options, task);
        await withFileLock(path.join(agentDir, "qmd-write.lock"), options, task);
      `("extensions/memory-core/src/memory/qmd-locks.ts", [
        { kind: "legacy store filesystem write", line: 4 },
        { kind: "legacy store filesystem write", line: 5 },
      ]),
      "flags writes through local variables initialized from legacy store paths": sourceCase`
        import { promises as fs } from "node:fs";
        import path from "node:path";
        export async function save(dir: string) {
          const storePath = path.join(dir, "sessions.json");
          await fs.writeFile(storePath, "{}\\n", "utf8");
        }
      `("src/runtime/session-writer.ts", [{ kind: "legacy store filesystem write", line: 6 }]),
      "flags writes through property access on legacy path variables": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        const storePath = "sessions.json";
        await writeTextAtomic(storePath.toString(), "{}\\n");
      `("src/runtime/legacy-path-property-access.ts", [
        { kind: "legacy store filesystem write", line: 4 },
      ]),
      "flags legacy paths split across path.join segments": sourceCase`
        import { promises as fs } from "node:fs";
        import path from "node:path";
        await fs.writeFile(path.join(stateDir, "cron", "jobs.json"), "{}\\n", "utf8");
        const sidecarPath = path.join(root, "plugin-state", "state.sqlite");
        await fs.writeFile(sidecarPath, "");
      `("src/runtime/legacy-state.ts", [
        { kind: "legacy store filesystem write", line: 4 },
        { kind: "legacy store filesystem write", line: 6 },
      ]),
      "flags runtime writes to the retired TUI last-session store": sourceCase`
        import { promises as fs } from "node:fs";
        import path from "node:path";
        await fs.writeFile(path.join(stateDir, "tui", "last-session.json"), "{}\\n");
      `("src/tui/last-session-writer.ts", [{ kind: "legacy store filesystem write", line: 4 }]),
      "flags runtime writes to the retired commitments JSON store": sourceCase`
        import { promises as fs } from "node:fs";
        import path from "node:path";
        await fs.writeFile(path.join(stateDir, "commitments", "commitments.json"), "{}\\n");
      `("src/commitments/file-store.ts", [{ kind: "legacy store filesystem write", line: 4 }]),
      "flags runtime writes to retired core audit JSONL stores": sourceCase`
        import { promises as fs } from "node:fs";
        import path from "node:path";
        await fs.appendFile(path.join(stateDir, "logs", "config-audit.jsonl"), "{}\\n");
        await fs.appendFile(path.join(stateDir, "audit", "system-agent.jsonl"), "{}\\n");
      `("src/infra/audit-writer.ts", [
        { kind: "legacy store filesystem write", line: 4 },
        { kind: "legacy store filesystem write", line: 5 },
      ]),
      "flags runtime writes to retired managed-image record JSON": sourceCase`
        import { promises as fs } from "node:fs";
        import path from "node:path";
        await fs.writeFile(path.join(stateDir, "media", "outgoing", "records", \`\${id}.json\`), "{}\n");
      `("src/gateway/managed-image-file-store.ts", [
        { kind: "legacy store filesystem write", line: 4 },
      ]),
      "flags runtime writes to retired Web Push JSON stores": sourceCase`
        import { promises as fs } from "node:fs";
        import path from "node:path";
        await fs.writeFile(path.join(stateDir, "push", "web-push-subscriptions.json"), "{}\n");
        await fs.writeFile(path.join(stateDir, "push", "vapid-keys.json"), "{}\n");
      `("src/infra/push-web-file-store.ts", [
        { kind: "legacy store filesystem write", line: 4 },
        { kind: "legacy store filesystem write", line: 6 },
      ]),
      "flags runtime writes to the retired APNs registration store": sourceCase`
        import { promises as fs } from "node:fs";
        import path from "node:path";
        await fs.writeFile(path.join(stateDir, "push", "apns-registrations.json"), "{}\n");
      `("src/infra/push-apns-file-store.ts", [{ kind: "legacy store filesystem write", line: 4 }]),
      "flags runtime writes to the retired node-host JSON config": sourceCase`
        import { promises as fs } from "node:fs";
        import path from "node:path";
        await fs.writeFile(path.join(stateDir, "node.json"), "{}\n");
      `("src/node-host/config-file-store.ts", [{ kind: "legacy store filesystem write", line: 4 }]),
      "flags runtime writes to retired workspace setup and attestation sidecars": sourceCase`
        import { promises as fs } from "node:fs";
        import path from "node:path";
        await fs.writeFile(path.join(workspaceDir, "openclaw-workspace-state.json"), "{}\\n");
        await fs.writeFile(path.join(workspaceDir, ".openclaw", "workspace-state.json"), "{}\\n");
        await fs.writeFile(path.join(stateDir, "workspace-attestations", \`\${workspaceKey}.attested\`), "ok\\n");
        await fs.writeFile(\`\${workspaceDir}.attested\`, "ok\\n");
      `("src/agents/workspace-sidecar-store.ts", [
        { kind: "legacy store filesystem write", line: 4 },
        { kind: "legacy store filesystem write", line: 5 },
        { kind: "legacy store filesystem write", line: 6 },
        { kind: "legacy store filesystem write", line: 7 },
      ]),
      "flags runtime writes to the retired native hook relay JSON registry": sourceCase`
        import { promises as fs } from "node:fs";
        import path from "node:path";
        await fs.writeFile(path.join("/tmp", "openclaw-native-hook-relays-501", "relay.json"), "{}\n");
      `("src/agents/harness/native-hook-relay-file-store.ts", [
        { kind: "legacy store filesystem write", line: 4 },
      ]),
      "flags runtime writes to the retired subagent JSON registry": sourceCase`
        import { promises as fs } from "node:fs";
        import path from "node:path";
        await fs.writeFile(path.join(stateDir, "subagents", "runs.json"), "{}\n");
      `("src/agents/subagent-registry-file-store.ts", [
        { kind: "legacy store filesystem write", line: 4 },
      ]),
      "flags runtime writes to retired skill-upload staging": sourceCase`
        import { promises as fs } from "node:fs";
        import path from "node:path";
        await fs.writeFile(path.join(stateDir, "tmp", "skill-uploads", uploadId, "metadata.json"), "{}\n");
      `("src/skills/lifecycle/upload-file-store.ts", [
        { kind: "legacy store filesystem write", line: 4 },
      ]),
      "flags runtime writes to retired system-agent rescue approval stores": sourceCase`
        import { promises as fs } from "node:fs";
        import path from "node:path";
        await fs.writeFile(path.join(stateDir, "openclaw", "rescue-pending", \`\${key}.json\`), "{}\\n");
        await fs.writeFile(path.join(stateDir, "crestodian", "rescue-pending", "old.json"), "{}\\n");
      `("src/system-agent/rescue-writer.ts", [
        { kind: "legacy store filesystem write", line: 4 },
        { kind: "legacy store filesystem write", line: 5 },
      ]),
      "flags legacy paths with dynamic agent id segments": sourceCase`
        import { promises as fs } from "node:fs";
        import path from "node:path";
        await fs.writeFile(path.join(stateDir, "agents", agentId, "agent", "auth.json"), "{}\\n");
      `("src/runtime/dynamic-agent-auth.ts", [{ kind: "legacy store filesystem write", line: 4 }]),
      "flags legacy paths with dynamic segments and constant filenames": sourceCase`
        import { promises as fs } from "node:fs";
        import path from "node:path";
        const AUTH_FILE = "auth.json";
        await fs.writeFile(path.join(stateDir, "agents", agentId, "agent", AUTH_FILE), "{}\\n");
      `("src/runtime/dynamic-agent-auth-constant.ts", [
        { kind: "legacy store filesystem write", line: 5 },
      ]),
      "flags legacy JSONL paths with dynamic template filenames": sourceCase`
        import { promises as fs } from "node:fs";
        import path from "node:path";
        await fs.appendFile(path.join(stateDir, "cron", "runs", \`\${runId}.jsonl\`), "{}\\n");
      `("src/runtime/dynamic-cron-run.ts", [{ kind: "legacy store filesystem write", line: 4 }]),
      "flags legacy paths assembled from filename constants": sourceCase`
        import { promises as fs } from "node:fs";
        import path from "node:path";
        const STORE_FILE = "sessions.json";
        const JOBS_FILE = "jobs.json";
        const SQLITE_FILE = "state.sqlite";
        const storePath = path.join(dir, STORE_FILE);
        await fs.writeFile(storePath, "{}\\n", "utf8");
        await fs.writeFile(path.join(stateDir, "cron", JOBS_FILE), "{}\\n");
        await fs.writeFile(path.join(stateDir, "plugin-state", SQLITE_FILE), "");
      `("src/runtime/constant-session-store.ts", [
        { kind: "legacy store filesystem write", line: 8 },
        { kind: "legacy store filesystem write", line: 9 },
        { kind: "legacy store filesystem write", line: 10 },
      ]),
      "flags legacy paths assembled from template literal constants": sourceCase`
        import { promises as fs } from "node:fs";
        const sessionBase = "sessions";
        const cronRuns = "cron/runs";
        await fs.writeFile(\`\${sessionBase}.json\`, "{}\\n");
        await fs.appendFile(\`\${cronRuns}/job.jsonl\`, "{}\\n");
      `("src/runtime/template-constant-legacy-store.ts", [
        { kind: "legacy store filesystem write", line: 5 },
        { kind: "legacy store filesystem write", line: 6 },
      ]),
      "does not leak conditional literal path constants": sourceCase`
        import { promises as fs } from "node:fs";
        import path from "node:path";
        const JOBS_FILE = "current.json";
        if (debug) {
          const JOBS_FILE = "jobs.json";
          console.log(JOBS_FILE);
        }
        await fs.writeFile(path.join(stateDir, "cron", JOBS_FILE), "{}\\n");
      `("src/runtime/conditional-literal-shadow.ts", []),
      "keeps conditional literal reassignment candidates": sourceCase`
        import { promises as fs } from "node:fs";
        import path from "node:path";
        let JOBS_FILE = "current.json";
        if (debug) {
          JOBS_FILE = "jobs.json";
        }
        await fs.writeFile(path.join(stateDir, "cron", JOBS_FILE), "{}\\n");
      `("src/runtime/conditional-literal-reassignment.ts", [
        { kind: "legacy store filesystem write", line: 8 },
      ]),
      "keeps known literal candidates when conditional reassignment is dynamic": sourceCase`
        import { promises as fs } from "node:fs";
        import path from "node:path";
        let JOBS_FILE = "jobs.json";
        if (debug) {
          JOBS_FILE = getJobsFile();
        }
        await fs.writeFile(path.join(stateDir, "cron", JOBS_FILE), "{}\\n");
      `("src/runtime/conditional-dynamic-literal-reassignment.ts", [
        { kind: "legacy store filesystem write", line: 8 },
      ]),
      "drops stale literal candidates after exhaustive branch reassignment": sourceCase`
        import { promises as fs } from "node:fs";
        import path from "node:path";
        let JOBS_FILE = "jobs.json";
        if (debug) {
          JOBS_FILE = "current.json";
        } else {
          JOBS_FILE = "active.json";
        }
        await fs.writeFile(path.join(stateDir, "cron", JOBS_FILE), "{}\\n");
      `("src/runtime/exhaustive-literal-reassignment.ts", []),
      "keeps known literal candidates after exhaustive dynamic branch reassignment": sourceCase`
        import { promises as fs } from "node:fs";
        import path from "node:path";
        let JOBS_FILE = "current.json";
        if (debug) {
          JOBS_FILE = "jobs.json";
        } else {
          JOBS_FILE = getJobsFile();
        }
        await fs.writeFile(path.join(stateDir, "cron", JOBS_FILE), "{}\\n");
      `("src/runtime/exhaustive-dynamic-literal-reassignment.ts", [
        { kind: "legacy store filesystem write", line: 10 },
      ]),
      "drops stale literal candidates after exhaustive dynamic branch reassignment": sourceCase`
        import { promises as fs } from "node:fs";
        import path from "node:path";
        let JOBS_FILE = "jobs.json";
        if (debug) {
          JOBS_FILE = "current.json";
        } else {
          JOBS_FILE = getJobsFile();
        }
        await fs.writeFile(path.join(stateDir, "cron", JOBS_FILE), "{}\\n");
      `("src/runtime/exhaustive-dynamic-stale-literal-reassignment.ts", []),
    }),
  )("$name", ({ source, filename, expected }) => {
    const violations = collectDatabaseFirstLegacyStoreViolations(source, filename);

    expect(violations).toEqual(expected);
  });

  // Filesystem bindings, aliases, and helper writes.
  it.each(
    namedCases({
      "flags imported and destructured fs write aliases": sourceCase`
        import fs, { writeFile as persist } from "node:fs/promises";
        const { appendFile: append } = fs;
        await persist("sessions.json", "{}\\n", "utf8");
        await append("cron/runs/job.jsonl", "{}\\n");
      `("src/runtime/aliased-fs.ts", [
        { kind: "legacy store filesystem write", line: 4 },
        { kind: "legacy store filesystem write", line: 5 },
      ]),
      "flags helper writes through namespace imports": sourceCase`
        import * as jsonFiles from "../infra/json-files.js";
        await jsonFiles.writeJson("sessions.json", {});
      `("src/runtime/helper-namespace-write.ts", [
        { kind: "legacy store filesystem write", line: 3 },
      ]),
      "flags private file store writes to legacy paths": sourceCase`
        import { privateFileStore } from "openclaw/plugin-sdk/security-runtime";
        await privateFileStore(stateDir).writeJson("thread-bindings.json", {});
      `("src/runtime/private-file-store-write.ts", [
        { kind: "legacy store filesystem write", line: 3 },
      ]),
      "flags fs-safe factory aliases writing legacy paths": sourceCase`
        import { privateFileStore } from "openclaw/plugin-sdk/security-runtime";
        import * as fsSafe from "openclaw/plugin-sdk/security-runtime";
        const makePrivateStore = privateFileStore;
        const makeRoot = fsSafe.root;
        const { privateFileStore: makeFromNamespace } = fsSafe;
        await makePrivateStore(stateDir).writeJson("thread-bindings.json", {});
        await (await makeRoot(stateDir)).writeJson("plugin-binding-approvals.json", {});
        await makeFromNamespace(stateDir).writeJson("gateway-restart-intent.json", {});
      `("src/runtime/fs-safe-factory-alias-write.ts", [
        { kind: "legacy store filesystem write", line: 7 },
        { kind: "legacy store filesystem write", line: 8 },
        { kind: "legacy store filesystem write", line: 9 },
      ]),
      "flags fs-safe root writes to legacy paths": sourceCase`
        import { root } from "openclaw/plugin-sdk/security-runtime";
        const state = await root(stateDir);
        await state.writeJson("plugin-binding-approvals.json", {});
        await (await root(stateDir)).writeJson("thread-bindings.json", {});
      `("src/runtime/fs-safe-root-write.ts", [
        { kind: "legacy store filesystem write", line: 4 },
        { kind: "legacy store filesystem write", line: 5 },
      ]),
      "flags bare fs-safe package root writes to legacy paths": sourceCase`
        import { root } from "@openclaw/fs-safe";
        const state = await root(stateDir);
        await state.writeJson("thread-bindings.json", {});
      `("src/runtime/bare-fs-safe-root-write.ts", [
        { kind: "legacy store filesystem write", line: 4 },
      ]),
      "flags file access runtime root writes to legacy paths": sourceCase`
        import { root } from "openclaw/plugin-sdk/file-access-runtime";
        const state = await root(stateDir);
        await state.writeJson("thread-bindings.json", {});
      `("extensions/example/src/runtime/file-access-root-write.ts", [
        { kind: "legacy store filesystem write", line: 4 },
      ]),
      "flags fs-safe store root writes to legacy paths": sourceCase`
        import { privateFileStore } from "openclaw/plugin-sdk/security-runtime";
        const state = await privateFileStore(stateDir).root();
        await state.writeJson("thread-bindings.json", {});
        await (await privateFileStore(stateDir).root()).writeJson("plugin-binding-approvals.json", {});
      `("src/runtime/fs-safe-store-root-write.ts", [
        { kind: "legacy store filesystem write", line: 4 },
        { kind: "legacy store filesystem write", line: 5 },
      ]),
      "allows fs-safe store reads from legacy paths": sourceCase`
        import { privateFileStore } from "openclaw/plugin-sdk/security-runtime";
        const store = privateFileStore(stateDir);
        await store.readJson("thread-bindings.json");
      `("src/runtime/private-file-store-read.ts", []),
      "flags fs-safe JSON store writes to legacy paths": sourceCase`
        import { privateFileStore } from "openclaw/plugin-sdk/security-runtime";
        await privateFileStore(stateDir).json("thread-bindings.json").write({});
        const bindings = privateFileStore(stateDir).json("plugin-binding-approvals.json");
        await bindings.update((current) => current ?? {});
        await privateFileStore(stateDir).json("gateway-restart-intent.json").updateOr({}, (current) => current);
      `("src/runtime/private-file-json-store-write.ts", [
        { kind: "legacy store filesystem write", line: 3 },
        { kind: "legacy store filesystem write", line: 5 },
        { kind: "legacy store filesystem write", line: 6 },
      ]),
      "flags direct fs-safe package store writes to legacy paths": sourceCase`
        import { fileStore, jsonStore } from "@openclaw/fs-safe/store";
        await fileStore({ rootDir: stateDir }).writeJson("thread-bindings.json", {});
        const options = { filePath: "plugin-binding-approvals.json" };
        await jsonStore(options).write({});
        await jsonStore({ filePath: "gateway-restart-intent.json" }).update((current) => current ?? {});
      `("src/runtime/direct-fs-safe-store-write.ts", [
        { kind: "legacy store filesystem write", line: 3 },
        { kind: "legacy store filesystem write", line: 5 },
        { kind: "legacy store filesystem write", line: 6 },
      ]),
      "flags fs-safe store object aliases writing legacy paths": sourceCase`
        import { privateFileStore } from "openclaw/plugin-sdk/security-runtime";
        const jsonBindings = privateFileStore(stateDir).json("plugin-binding-approvals.json");
        const stores = {
          state: privateFileStore(stateDir),
          bindings: jsonBindings,
        };
        await stores.state.writeJson("thread-bindings.json", {});
        await stores.bindings.write({});
        stores.state = customStore;
        stores.bindings = privateFileStore(stateDir).json("gateway-restart-intent.json");
        await stores.state.writeJson("thread-bindings.json", {});
        await stores.bindings.update((current) => current ?? {});
      `("src/runtime/fs-safe-store-object-alias-write.ts", [
        { kind: "legacy store filesystem write", line: 8 },
        { kind: "legacy store filesystem write", line: 9 },
        { kind: "legacy store filesystem write", line: 13 },
      ]),
      "flags fs-safe store object aliases copied through spreads and nested objects": sourceCase`
        import { privateFileStore } from "openclaw/plugin-sdk/security-runtime";
        const base = { state: privateFileStore(stateDir) };
        const stores = { ...base };
        const nested = { inner: { bindings: privateFileStore(stateDir).json("plugin-binding-approvals.json") } };
        await stores.state.writeJson("thread-bindings.json", {});
        await nested.inner.bindings.write({});
      `("src/runtime/fs-safe-store-spread-object-alias-write.ts", [
        { kind: "legacy store filesystem write", line: 6 },
        { kind: "legacy store filesystem write", line: 7 },
      ]),
      "flags fs-safe store object aliases assigned through nested object properties": sourceCase`
        import { privateFileStore } from "openclaw/plugin-sdk/security-runtime";
        const stores = {};
        stores.inner = { bindings: privateFileStore(stateDir).json("thread-bindings.json") };
        await stores.inner.bindings.write({});
      `("src/runtime/assigned-nested-fs-safe-store-object-alias.ts", [
        { kind: "legacy store filesystem write", line: 5 },
      ]),
      "flags fs-safe store object aliases copied through destructuring": sourceCase`
        import { privateFileStore } from "openclaw/plugin-sdk/security-runtime";
        const stores = { state: privateFileStore(stateDir) };
        const nested = { inner: { bindings: privateFileStore(stateDir).json("plugin-binding-approvals.json") } };
        const { state } = stores;
        const { inner: { bindings } } = nested;
        await state.writeJson("thread-bindings.json", {});
        await bindings.write({});
      `("src/runtime/fs-safe-store-destructured-object-alias-write.ts", [
        { kind: "legacy store filesystem write", line: 7 },
        { kind: "legacy store filesystem write", line: 8 },
      ]),
      "clears fs-safe store object aliases after exhaustive property reassignment": sourceCase`
        import { privateFileStore } from "openclaw/plugin-sdk/security-runtime";
        const stores = { state: privateFileStore(stateDir) };
        if (flag) {
          stores.state = customA;
        } else {
          stores.state = customB;
        }
        await stores.state.writeJson("thread-bindings.json", {});
      `("src/runtime/exhaustive-fs-safe-store-property-reassignment.ts", []),
      "clears nested fs-safe store object aliases after exhaustive property reassignment":
        sourceCase`
        import { privateFileStore } from "openclaw/plugin-sdk/security-runtime";
        const stores = { inner: { bindings: privateFileStore(stateDir).json("thread-bindings.json") } };
        if (flag) {
          stores.inner = { bindings: customA };
        } else {
          stores.inner = { bindings: customB };
        }
        await stores.inner.bindings.write({});
      `("src/runtime/exhaustive-nested-fs-safe-store-property-reassignment.ts", []),
      "keeps fs-safe store object aliases when one exhaustive property branch remains a store":
        sourceCase`
        import { privateFileStore } from "openclaw/plugin-sdk/security-runtime";
        const stores = { state: customStore };
        if (flag) {
          stores.state = customA;
        } else {
          stores.state = privateFileStore(stateDir);
        }
        await stores.state.writeJson("thread-bindings.json", {});
      `("src/runtime/exhaustive-fs-safe-store-property-partial-reassignment.ts", [
          { kind: "legacy store filesystem write", line: 9 },
        ]),
      "flags direct fs-safe package namespace store writes to legacy paths": sourceCase`
        import * as fsSafeStore from "@openclaw/fs-safe/store";
        const store = fsSafeStore.fileStoreSync({ rootDir: stateDir });
        store.writeJson("thread-bindings.json", {});
        const bindings = fsSafeStore.jsonStore({ filePath: "plugin-binding-approvals.json" });
        await bindings.write({});
      `("src/runtime/direct-fs-safe-store-namespace-write.ts", [
        { kind: "legacy store filesystem write", line: 4 },
        { kind: "legacy store filesystem write", line: 6 },
      ]),
      "allows fs-safe JSON store reads from legacy paths": sourceCase`
        import { privateFileStore } from "openclaw/plugin-sdk/security-runtime";
        const bindings = privateFileStore(stateDir).json("thread-bindings.json");
        await bindings.read();
        await privateFileStore(stateDir).json("plugin-binding-approvals.json").readOr({});
      `("src/runtime/private-file-json-store-read.ts", []),
      "clears fs-safe store aliases after exhaustive non-store reassignment": sourceCase`
        import { privateFileStore } from "openclaw/plugin-sdk/security-runtime";
        let store = privateFileStore(stateDir);
        if (flag) {
          store = customA;
        } else {
          store = customB;
        }
        await store.writeJson("thread-bindings.json", {});
      `("src/runtime/exhaustive-fs-safe-store-reassignment.ts", []),
      "keeps fs-safe store aliases when one exhaustive branch remains a store": sourceCase`
        import { privateFileStore } from "openclaw/plugin-sdk/security-runtime";
        let store = customStore;
        if (flag) {
          store = customA;
        } else {
          store = privateFileStore(stateDir);
        }
        await store.writeJson("thread-bindings.json", {});
      `("src/runtime/exhaustive-fs-safe-store-partial-reassignment.ts", [
        { kind: "legacy store filesystem write", line: 9 },
      ]),
      "clears fs-safe namespace factory aliases after shadowing": sourceCase`
        import * as fsSafe from "openclaw/plugin-sdk/security-runtime";
        async function save(fsSafe: { root(dir: string): Promise<{ writeJson(path: string): void }> }) {
          await (await fsSafe.root(stateDir)).writeJson("thread-bindings.json");
        }
      `("src/runtime/fs-safe-namespace-shadow.ts", []),
      "ignores helper-like namespace imports from unrelated modules": sourceCase`
        import * as runtime from "../runtime/json-output.js";
        runtime.writeJson("sessions.json", {});
      `("src/runtime/unrelated-helper-namespace.ts", []),
      "ignores helper-like named imports from unrelated modules": sourceCase`
        import { writeJson } from "../runtime/json-output.js";
        writeJson("sessions.json", {});
      `("src/runtime/unrelated-helper-named-import.ts", []),
      "clears namespace helper aliases after shadowing": sourceCase`
        import * as jsonFiles from "../infra/json-files.js";
        function save(jsonFiles: { writeJson(path: string, value: unknown): void }) {
          jsonFiles.writeJson("sessions.json", {});
        }
        save(customJsonFiles);
      `("src/runtime/helper-namespace-shadow.ts", []),
      "allows read-only fs open calls and flags write modes": sourceCase`
        import fs from "node:fs/promises";
        await fs.open("sessions.json");
        await fs.open("sessions.json", "r");
        await fs.open("sessions.json", "r+");
        await fs.open("sessions.json", "w");
      `("src/runtime/open-flags.ts", [
        { kind: "legacy store filesystem write", line: 5 },
        { kind: "legacy store filesystem write", line: 6 },
      ]),
      "flags fs copy calls writing legacy store paths": sourceCase`
        import fs from "node:fs/promises";
        import syncFs from "node:fs";
        await fs.cp("source.json", "sessions.json");
        syncFs.cpSync("source.json", "cron/jobs.json");
      `("src/runtime/fs-copy-legacy-store.ts", [
        { kind: "legacy store filesystem write", line: 4 },
        { kind: "legacy store filesystem write", line: 5 },
      ]),
      "allows fs copy calls reading from legacy store paths": sourceCase`
        import fs from "node:fs/promises";
        import syncFs from "node:fs";
        await fs.copyFile("sessions.json", "state/openclaw.sqlite.import");
        await fs.cp("cron/jobs.json", "state/openclaw.sqlite.import");
        syncFs.copyFileSync("auth-profiles.json", "state/openclaw.sqlite.import");
        syncFs.cpSync("cache/models.json", "state/openclaw.sqlite.import");
      `("src/runtime/fs-copy-legacy-store-source.ts", []),
      "flags fs removal calls targeting legacy store paths": sourceCase`
        import fs from "node:fs/promises";
        import syncFs from "node:fs";
        await fs.rm("sessions.json", { force: true });
        syncFs.unlinkSync("cron/jobs.json");
      `("src/runtime/fs-remove-legacy-store.ts", [
        { kind: "legacy store filesystem write", line: 4 },
        { kind: "legacy store filesystem write", line: 5 },
      ]),
      "flags legacy paths destructured from for-of tuple entries": sourceCase`
        import path from "node:path";
        import { root as fsRoot } from "openclaw/plugin-sdk/security-runtime";
        const CLAIMS_DIGEST_PATH = ".openclaw-wiki/cache/claims.jsonl";
        const claimsDigestPath = path.join(rootDir, CLAIMS_DIGEST_PATH);
        for (const [filePath, content] of [[claimsDigestPath, claimsDigest]]) {
          const relativePath = path.relative(rootDir, filePath);
          const root = await fsRoot(rootDir);
          await root.write(relativePath, content);
        }
      `("src/runtime/for-of-destructured-legacy-path.ts", [
        { kind: "legacy store filesystem write", line: 9 },
      ]),
      "applies open write-mode checks inside wrappers": sourceCase`
        import fs from "node:fs/promises";
        function read(path: string) {
          return fs.open(path, "r");
        }
        function write(path: string) {
          return fs.open(path, "w");
        }
        await read("sessions.json");
        await write("sessions.json");
      `("src/runtime/open-wrapper-flags.ts", [{ kind: "legacy store filesystem write", line: 10 }]),
      "flags string-literal fs write aliases from destructuring": sourceCase`
        import fs from "node:fs/promises";
        const { "writeFile": persist } = fs;
        await persist("sessions.json", "{}\\n", "utf8");
      `("src/runtime/string-literal-fs-alias.ts", [
        { kind: "legacy store filesystem write", line: 4 },
      ]),
      "flags CommonJS fs write aliases": sourceCase`
        const fs = require("node:fs");
        const { appendFileSync } = require("node:fs");
        fs.writeFileSync("sessions.json", "{}\\n");
        appendFileSync("cron/runs/job.jsonl", "{}\\n");
      `("src/runtime/commonjs-fs-aliases.ts", [
        { kind: "legacy store filesystem write", line: 4 },
        { kind: "legacy store filesystem write", line: 5 },
      ]),
      "does not treat local require bindings as CommonJS fs": sourceCase`
        function save(require: (specifier: string) => { writeFileSync(path: string, value: string): void }) {
          const fs = require("node:fs");
          fs.writeFileSync("sessions.json", "");
        }
        save(customRequire);
      `("src/runtime/local-require-binding.ts", []),
      "flags createRequire-backed CommonJS fs writes": sourceCase`
        import { createRequire } from "node:module";
        const require = createRequire(import.meta.url);
        const fs = require("node:fs");
        fs.writeFileSync("sessions.json", "{}\\n");
      `("src/runtime/create-require-fs.ts", [{ kind: "legacy store filesystem write", line: 5 }]),
      "flags createRequire alias-backed CommonJS fs writes": sourceCase`
        import { createRequire } from "node:module";
        const req = createRequire(import.meta.url);
        const fs = req("node:fs");
        fs.writeFileSync("sessions.json", "{}\\n");
      `("src/runtime/create-require-alias-fs.ts", [
        { kind: "legacy store filesystem write", line: 5 },
      ]),
      "flags copied createRequire alias-backed CommonJS fs writes": sourceCase`
        import { createRequire } from "node:module";
        const req = createRequire(import.meta.url);
        const req2 = req;
        const fs = req2("node:fs");
        fs.writeFileSync("sessions.json", "{}\\n");
      `("src/runtime/copied-create-require-alias-fs.ts", [
        { kind: "legacy store filesystem write", line: 6 },
      ]),
      "flags reassigned createRequire alias-backed CommonJS fs writes": sourceCase`
        import { createRequire } from "node:module";
        let req;
        req = createRequire(import.meta.url);
        const fs = req("node:fs");
        fs.writeFileSync("sessions.json", "{}\\n");
      `("src/runtime/reassigned-create-require-alias-fs.ts", [
        { kind: "legacy store filesystem write", line: 6 },
      ]),
      "flags reassigned createRequire aliases named require": sourceCase`
        import { createRequire } from "node:module";
        let require;
        require = createRequire(import.meta.url);
        const fs = require("node:fs");
        fs.writeFileSync("sessions.json", "{}\\n");
      `("src/runtime/reassigned-create-require-name.ts", [
        { kind: "legacy store filesystem write", line: 6 },
      ]),
      "refreshes hoisted wrappers after createRequire alias reassignment": sourceCase`
        import { createRequire } from "node:module";
        let req;
        function persist(filePath: string) {
          const fs = req("node:fs");
          fs.writeFileSync(filePath, "{}\\n");
        }
        req = createRequire(import.meta.url);
        persist("sessions.json");
      `("src/runtime/hoisted-wrapper-reassigned-create-require-alias.ts", [
        { kind: "legacy store filesystem write", line: 9 },
      ]),
      "refreshes hoisted wrappers after nested createRequire alias reassignment": sourceCase`
        import { createRequire } from "node:module";
        let req;
        function persist(filePath: string) {
          const fs = req("node:fs");
          fs.writeFileSync(filePath, "{}\\n");
        }
        {
          req = createRequire(import.meta.url);
        }
        persist("sessions.json");
      `("src/runtime/hoisted-wrapper-nested-create-require-alias.ts", [
        { kind: "legacy store filesystem write", line: 11 },
      ]),
      "refreshes block-scoped wrappers after nested outer createRequire alias reassignment":
        sourceCase`
        import { createRequire } from "node:module";
        let req;
        {
          function persist(filePath: string) {
            const fs = req("node:fs");
            fs.writeFileSync(filePath, "{}\\n");
          }
          {
            req = createRequire(import.meta.url);
          }
          persist("sessions.json");
        }
      `("src/runtime/block-wrapper-nested-create-require-alias.ts", [
          { kind: "legacy store filesystem write", line: 12 },
        ]),
      "refreshes escaped wrappers after outer createRequire alias reassignment": sourceCase`
        import { createRequire } from "node:module";
        let req;
        let persist;
        {
          function inner(filePath: string) {
            const fs = req("node:fs");
            fs.writeFileSync(filePath, "{}\\n");
          }
          persist = inner;
        }
        req = createRequire(import.meta.url);
        persist("sessions.json");
      `("src/runtime/escaped-wrapper-create-require-alias.ts", [
        { kind: "legacy store filesystem write", line: 13 },
      ]),
      "keeps escaped wrapper local require shadows after outer createRequire alias reassignment":
        sourceCase`
        import { createRequire } from "node:module";
        let req;
        let persist;
        {
          let req;
          function inner(filePath: string) {
            const fs = req("node:fs");
            fs.writeFileSync(filePath, "{}\\n");
          }
          persist = inner;
        }
        req = createRequire(import.meta.url);
        persist("sessions.json");
      `("src/runtime/escaped-wrapper-local-require-shadow.ts", []),
      "does not treat parameter shadows as createRequire aliases": sourceCase`
        import { createRequire } from "node:module";
        const req = createRequire(import.meta.url);
        function save(req: (specifier: string) => { writeFileSync(path: string, value: string): void }) {
          const fs = req("node:fs");
          fs.writeFileSync("sessions.json", "");
        }
        save(customRequire);
      `("src/runtime/create-require-parameter-shadow.ts", []),
      "does not treat shadowed createRequire bindings as Node require": sourceCase`
        import { createRequire } from "node:module";
        function save(createRequire: (url: string) => (specifier: string) => { writeFileSync(path: string, value: string): void }) {
          const require = createRequire("custom");
          const fs = require("node:fs");
          fs.writeFileSync("sessions.json", "");
        }
        save(customCreateRequire);
      `("src/runtime/shadowed-create-require.ts", []),
      "does not treat hoisted function createRequire shadows as Node require": sourceCase`
        import { createRequire } from "node:module";
        function run() {
          function createRequire(url: string) {
            return customRequire(url);
          }
          const req = createRequire(import.meta.url);
          const fs = req("node:fs");
          fs.writeFileSync("sessions.json", "{}\\n");
        }
        run();
      `("src/runtime/hoisted-create-require-shadow.ts", []),
      "flags CommonJS fs promises aliases": sourceCase`
        const { promises: fs } = require("node:fs");
        const { promises } = require("node:fs");
        await fs.writeFile("sessions.json", "{}\\n");
        await promises.appendFile("cron/runs/job.jsonl", "{}\\n");
      `("src/runtime/commonjs-fs-promises-aliases.ts", [
        { kind: "legacy store filesystem write", line: 4 },
        { kind: "legacy store filesystem write", line: 5 },
      ]),
      "flags nested CommonJS fs promises write aliases": sourceCase`
        const { promises: { writeFile } } = require("node:fs");
        await writeFile("sessions.json", "{}\\n");
      `("src/runtime/nested-commonjs-fs-promises-alias.ts", [
        { kind: "legacy store filesystem write", line: 3 },
      ]),
      "flags inline CommonJS fs writes": sourceCase`
        require("node:fs").writeFileSync("sessions.json", "{}\\n");
        require("node:fs").promises.writeFile("cron/jobs.json", "{}\\n");
      `("src/runtime/inline-commonjs-fs-write.ts", [
        { kind: "legacy store filesystem write", line: 2 },
        { kind: "legacy store filesystem write", line: 3 },
      ]),
      "flags bracketed fs writes": sourceCase`
        import fs from "node:fs";
        await fs["writeFile"]("sessions.json", "{}\\n");
        await fs.promises["writeFile"]("cron/runs/job.jsonl", "{}\\n");
        require("node:fs")["writeFileSync"]("sessions.json", "{}\\n");
      `("src/runtime/bracketed-fs-writes.ts", [
        { kind: "legacy store filesystem write", line: 3 },
        { kind: "legacy store filesystem write", line: 4 },
        { kind: "legacy store filesystem write", line: 5 },
      ]),
      "flags dynamic fs import writes": sourceCase`
        const fs = await import("node:fs/promises");
        const nodeFs = await import("node:fs");
        await fs.writeFile("sessions.json", "{}\\n");
        await nodeFs.promises.appendFile("cron/runs/job.jsonl", "{}\\n");
      `("src/runtime/dynamic-fs-import-write.ts", [
        { kind: "legacy store filesystem write", line: 4 },
        { kind: "legacy store filesystem write", line: 5 },
      ]),
      "flags dynamic fs import write aliases": sourceCase`
        const { writeFile } = await import("node:fs/promises");
        const { promises } = await import("node:fs");
        await writeFile("sessions.json", "{}\\n");
        await promises.appendFile("cron/runs/job.jsonl", "{}\\n");
      `("src/runtime/dynamic-fs-import-aliases.ts", [
        { kind: "legacy store filesystem write", line: 4 },
        { kind: "legacy store filesystem write", line: 5 },
      ]),
      "flags dynamic fs import promise callback writes": sourceCase`
        await import("node:fs/promises").then((fs) =>
          fs.writeFile("sessions.json", "{}\\n"),
        );
      `("src/runtime/dynamic-fs-import-promise-callback.ts", [
        { kind: "legacy store filesystem write", line: 3 },
      ]),
      "flags destructured dynamic fs import promise callback writes": sourceCase`
        await import("node:fs/promises").then(({ writeFile }) =>
          writeFile("sessions.json", "{}\\n"),
        );
        await import("node:fs").then(({ promises }) =>
          promises.appendFile("cron/runs/job.jsonl", "{}\\n"),
        );
        await import("node:fs").then(({ promises: { writeFile: persist } }) =>
          persist("sessions.json", "{}\\n"),
        );
      `("src/runtime/destructured-dynamic-fs-import-promise-callback.ts", [
        { kind: "legacy store filesystem write", line: 3 },
        { kind: "legacy store filesystem write", line: 6 },
        { kind: "legacy store filesystem write", line: 9 },
      ]),
      "flags write aliases destructured from fs.promises": sourceCase`
        import * as fs from "node:fs";
        const { writeFile: persist } = fs.promises;
        const fsp = fs.promises;
        const { appendFile } = fsp;
        await persist("sessions.json", "{}\\n", "utf8");
        await appendFile("cron/runs/job.jsonl", "{}\\n");
      `("src/runtime/fs-promises-aliases.ts", [
        { kind: "legacy store filesystem write", line: 6 },
        { kind: "legacy store filesystem write", line: 7 },
      ]),
      "flags fs write method aliases": sourceCase`
        import fs from "node:fs/promises";
        const persist = fs.writeFile;
        await persist("sessions.json", "{}\\n");
      `("src/runtime/fs-write-method-alias.ts", [
        { kind: "legacy store filesystem write", line: 4 },
      ]),
      "flags write aliases destructured from local fs module aliases": sourceCase`
        import fs from "node:fs/promises";
        {
          const storage = fs;
          const { writeFile } = storage;
          await writeFile("sessions.json", "{}\\n");
        }
      `("src/runtime/local-fs-module-alias.ts", [
        { kind: "legacy store filesystem write", line: 6 },
      ]),
      "flags nested write aliases destructured from local fs module aliases": sourceCase`
        const nodeFs = require("node:fs");
        const { promises: { writeFile } } = nodeFs;
        await writeFile("sessions.json", "{}\\n");
      `("src/runtime/nested-local-fs-module-alias.ts", [
        { kind: "legacy store filesystem write", line: 4 },
      ]),
      "clears fs module aliases after reassignment": sourceCase`
        import fs from "node:fs/promises";
        let writer = fs;
        writer = customWriter;
        await writer.writeFile("sessions.json", "{}\\n");
      `("src/runtime/reassigned-fs-module-alias.ts", []),
      "uses branch-local fs module aliases after conditional assignment": sourceCase`
        import fs from "node:fs/promises";
        let writer;
        if (ready) {
          writer = fs;
          await writer.writeFile("sessions.json", "{}\\n");
        }
      `("src/runtime/conditional-fs-module-alias.ts", [
        { kind: "legacy store filesystem write", line: 6 },
      ]),
      "keeps fs module aliases after conditional assignment": sourceCase`
        import fs from "node:fs/promises";
        let writer;
        if (ready) {
          writer = fs;
        }
        await writer.writeFile("sessions.json", "{}\\n");
      `("src/runtime/conditional-retained-fs-module-alias.ts", [
        { kind: "legacy store filesystem write", line: 7 },
      ]),
      "keeps fs write aliases after conditional assignment": sourceCase`
        import fs from "node:fs/promises";
        let persist;
        if (ready) {
          persist = fs.writeFile;
        }
        await persist("sessions.json", "{}\\n");
      `("src/runtime/conditional-retained-fs-write-alias.ts", [
        { kind: "legacy store filesystem write", line: 7 },
      ]),
      "clears fs module aliases after exhaustive conditional reassignment": sourceCase`
        import fs from "node:fs/promises";
        let writer = fs;
        if (ready) {
          writer = customWriter;
        } else {
          writer = otherWriter;
        }
        await writer.writeFile("sessions.json", "{}\\n");
      `("src/runtime/exhaustive-reassigned-fs-module-alias.ts", []),
      "keeps uninitialized fs aliases assigned from nested blocks": sourceCase`
        import fs from "node:fs/promises";
        let writer;
        let persist;
        {
          writer = fs;
          persist = fs.writeFile;
        }
        await writer.writeFile("sessions.json", "{}\\n");
        await persist("cron/jobs.json", "{}\\n");
      `("src/runtime/nested-assigned-uninitialized-fs-aliases.ts", [
        { kind: "legacy store filesystem write", line: 9 },
        { kind: "legacy store filesystem write", line: 10 },
      ]),
      "flags fs write aliases stored on object properties": sourceCase`
        import fs from "node:fs/promises";
        const writer = { writeFile: fs.writeFile };
        await writer.writeFile("sessions.json", "{}\\n");
      `("src/runtime/object-fs-write-alias.ts", [
        { kind: "legacy store filesystem write", line: 4 },
      ]),
      "flags fs module handles stored on object properties": sourceCase`
        import fs from "node:fs/promises";
        const deps = { fs };
        const io = { storage: fs };
        await deps.fs.writeFile("sessions.json", "{}\\n");
        await io.storage.appendFile("cron/runs/job.jsonl", "{}\\n");
      `("src/runtime/object-fs-module-alias.ts", [
        { kind: "legacy store filesystem write", line: 5 },
        { kind: "legacy store filesystem write", line: 6 },
      ]),
      "clears fs write object aliases after object reassignment": sourceCase`
        import fs from "node:fs/promises";
        let writer = { writeFile: fs.writeFile };
        writer = customWriter;
        await writer.writeFile("sessions.json", "{}\\n");
      `("src/runtime/reassigned-object-fs-write-alias.ts", []),
      "clears fs module object aliases after object reassignment": sourceCase`
        import fs from "node:fs/promises";
        let deps = { fs };
        deps = customDeps;
        await deps.fs.writeFile("sessions.json", "{}\\n");
      `("src/runtime/reassigned-object-fs-module-alias.ts", []),
      "flags fs write aliases assigned to object properties": sourceCase`
        import fs from "node:fs/promises";
        const writer: any = {};
        writer.writeFile = fs.writeFile;
        await writer.writeFile("sessions.json", "{}\\n");
      `("src/runtime/assigned-object-fs-write-alias.ts", [
        { kind: "legacy store filesystem write", line: 5 },
      ]),
      "flags fs module handles assigned to object properties": sourceCase`
        import fs from "node:fs/promises";
        const deps: any = {};
        deps.fs = fs;
        await deps.fs.writeFile("sessions.json", "{}\\n");
      `("src/runtime/assigned-object-fs-module-alias.ts", [
        { kind: "legacy store filesystem write", line: 5 },
      ]),
      "uses branch-local fs object aliases after conditional reassignment": sourceCase`
        import fs from "node:fs/promises";
        const writer = { writeFile: fs.writeFile };
        if (ready) {
          writer.writeFile = customSink;
          await writer.writeFile("sessions.json", "{}\\n");
        }
      `("src/runtime/conditional-object-fs-write-alias-reassignment.ts", []),
      "does not leak local fs module aliases outside their scope": sourceCase`
        import fs from "node:fs/promises";
        {
          const storage = fs;
          const { writeFile } = storage;
          await writeFile(currentSqlitePath, "{}\\n");
        }
        {
          const storage = customWriter;
          const { writeFile } = storage;
          await writeFile("sessions.json", "{}\\n");
        }
      `("src/runtime/local-fs-module-alias-scope.ts", []),
      "flags legacy paths written through regular-file helpers": sourceCase`
        import { appendRegularFile as appendSafe } from "openclaw/plugin-sdk/security-runtime";
        const filePath = "session.trajectory.jsonl";
        await appendSafe({ filePath, content: "{}\\n" });
      `("src/runtime/regular-file-helper.ts", [{ kind: "legacy store filesystem write", line: 4 }]),
      "flags legacy paths written through JSON and atomic helpers": sourceCase`
        import { writeJson, writeTextAtomic } from "../infra/json-files.js";
        import { replaceFileAtomicSync } from "../infra/replace-file.js";
        import { saveJsonFile, writeJsonFileAtomically } from "openclaw/plugin-sdk/json-store";
        await writeJson("restart-sentinel.json", {});
        await writeTextAtomic("gateway-restart-intent.json", "{}\\n");
        replaceFileAtomicSync({ filePath: "plugin-state/state.sqlite", content: "" });
        await writeJsonFileAtomically("thread-bindings.json", {});
        saveJsonFile("plugin-binding-approvals.json", {});
      `("src/runtime/write-helper-regressions.ts", [
        { kind: "legacy restart sentinel reference", line: 5 },
        { kind: "legacy store filesystem write", line: 5 },
        { kind: "legacy store filesystem write", line: 6 },
        { kind: "legacy store filesystem write", line: 7 },
        { kind: "legacy store filesystem write", line: 8 },
        { kind: "legacy store filesystem write", line: 9 },
      ]),
      "flags legacy paths passed through wrapper object properties": sourceCase`
        import path from "node:path";
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }) {
          return writeTextAtomic(params.filePath, "{}\\n");
        }
        const ledgerPath = path.join(stateDir, "acp", "event-ledger.json");
        await persist({ filePath: ledgerPath });
      `("src/runtime/object-property-wrapper.ts", [
        { kind: "legacy store filesystem write", line: 8 },
      ]),
      "flags wrapper paths written through createRequire aliases": sourceCase`
        import { createRequire } from "node:module";
        const req = createRequire(import.meta.url);
        function persist(filePath: string) {
          const fs = req("node:fs");
          fs.writeFileSync(filePath, "{}\\n");
        }
        persist("sessions.json");
      `("src/runtime/create-require-alias-wrapper.ts", [
        { kind: "legacy store filesystem write", line: 8 },
      ]),
      "flags wrapper-local createRequire alias writes": sourceCase`
        import { createRequire } from "node:module";
        function persist(filePath: string) {
          const req = createRequire(import.meta.url);
          const fs = req("node:fs");
          fs.writeFileSync(filePath, "{}\\n");
        }
        persist("sessions.json");
      `("src/runtime/wrapper-local-create-require-alias.ts", [
        { kind: "legacy store filesystem write", line: 8 },
      ]),
      "flags wrapper-local copied createRequire aliases": sourceCase`
        import { createRequire } from "node:module";
        function persist(filePath: string) {
          const req = createRequire(import.meta.url);
          const req2 = req;
          const fs = req2("node:fs");
          fs.writeFileSync(filePath, "{}\\n");
        }
        persist("sessions.json");
      `("src/runtime/wrapper-copied-create-require-alias.ts", [
        { kind: "legacy store filesystem write", line: 9 },
      ]),
      "flags wrapper-local createRequire aliases after local shadow reassignment": sourceCase`
        import { createRequire } from "node:module";
        const req = createRequire(import.meta.url);
        function persist(filePath: string) {
          let req;
          req = createRequire(import.meta.url);
          const fs = req("node:fs");
          fs.writeFileSync(filePath, "{}\\n");
        }
        persist("sessions.json");
      `("src/runtime/wrapper-shadowed-reassigned-create-require-alias.ts", [
        { kind: "legacy store filesystem write", line: 10 },
      ]),
      "flags wrapper-local reassigned createRequire aliases named require": sourceCase`
        import { createRequire } from "node:module";
        function persist(filePath: string) {
          let require;
          require = createRequire(import.meta.url);
          const fs = require("node:fs");
          fs.writeFileSync(filePath, "{}\\n");
        }
        persist("sessions.json");
      `("src/runtime/wrapper-reassigned-create-require-name.ts", [
        { kind: "legacy store filesystem write", line: 9 },
      ]),
      "flags wrapper-local createRequire alias assignments inside blocks": sourceCase`
        import { createRequire } from "node:module";
        function persist(filePath: string) {
          let req;
          {
            req = createRequire(import.meta.url);
          }
          const fs = req("node:fs");
          fs.writeFileSync(filePath, "{}\\n");
        }
        persist("sessions.json");
      `("src/runtime/wrapper-block-create-require-assignment.ts", [
        { kind: "legacy store filesystem write", line: 11 },
      ]),
      "does not treat wrapper-shadowed createRequire parameters as Node createRequire": sourceCase`
        function persist(
          filePath: string,
          createRequire: (url: string) => (specifier: string) => { writeFileSync(path: string, value: string): void },
        ) {
          const req = createRequire(import.meta.url);
          const fs = req("node:fs");
          fs.writeFileSync(filePath, "{}\\n");
        }
        persist("sessions.json", customCreateRequire);
      `("src/runtime/wrapper-shadowed-create-require.ts", []),
      "does not treat wrapper hoisted function createRequire shadows as Node createRequire":
        sourceCase`
        import { createRequire } from "node:module";
        function persist(filePath: string) {
          function createRequire(url: string) {
            return customRequire(url);
          }
          const req = createRequire(import.meta.url);
          const fs = req("node:fs");
          fs.writeFileSync(filePath, "{}\\n");
        }
        persist("sessions.json");
      `("src/runtime/wrapper-hoisted-create-require-shadow.ts", []),
      "keeps wrapper lexical createRequire aliases when call sites shadow them": sourceCase`
        import { createRequire } from "node:module";
        const req = createRequire(import.meta.url);
        function persist(filePath: string) {
          const fs = req("node:fs");
          fs.writeFileSync(filePath, "{}\\n");
        }
        {
          const req = customRequire;
          persist("sessions.json");
        }
      `("src/runtime/wrapper-lexical-create-require-alias.ts", [
        { kind: "legacy store filesystem write", line: 10 },
      ]),
      "keeps wrapper-local createRequire calls when call sites shadow createRequire": sourceCase`
        import { createRequire } from "node:module";
        function persist(filePath: string) {
          const req = createRequire(import.meta.url);
          const fs = req("node:fs");
          fs.writeFileSync(filePath, "{}\\n");
        }
        {
          const createRequire = customCreateRequire;
          persist("sessions.json");
        }
      `("src/runtime/wrapper-create-require-call-site-shadow.ts", [
        { kind: "legacy store filesystem write", line: 10 },
      ]),
      "flags exhaustive conditional createRequire alias assignments": sourceCase`
        import { createRequire } from "node:module";
        let req;
        if (condition) {
          req = createRequire(import.meta.url);
        } else {
          req = createRequire(import.meta.url);
        }
        const fs = req("node:fs");
        fs.writeFileSync("sessions.json", "{}\\n");
      `("src/runtime/conditional-create-require-alias.ts", [
        { kind: "legacy store filesystem write", line: 10 },
      ]),
      "refreshes hoisted wrappers after exhaustive createRequire alias branches": sourceCase`
        import { createRequire } from "node:module";
        let req;
        function persist(filePath: string) {
          const fs = req("node:fs");
          fs.writeFileSync(filePath, "{}\\n");
        }
        if (condition) {
          req = createRequire(import.meta.url);
        } else {
          req = createRequire(import.meta.url);
        }
        persist("sessions.json");
      `("src/runtime/hoisted-wrapper-conditional-create-require-alias.ts", [
        { kind: "legacy store filesystem write", line: 13 },
      ]),
      "keeps wrapper conditional createRequire alias branches": sourceCase`
        import { createRequire } from "node:module";
        function persist(filePath: string) {
          let req;
          if (condition) {
            req = createRequire(import.meta.url);
          } else {
            req = customRequire;
          }
          const fs = req("node:fs");
          fs.writeFileSync(filePath, "{}\\n");
        }
        persist("sessions.json");
      `("src/runtime/wrapper-conditional-create-require-alias.ts", [
        { kind: "legacy store filesystem write", line: 13 },
      ]),
    }),
  )("$name", ({ source, filename, expected }) => {
    const violations = collectDatabaseFirstLegacyStoreViolations(source, filename);

    expect(violations).toEqual(expected);
  });

  // Wrapper argument and default-value propagation.
  it.each(
    namedCases({
      "flags legacy paths passed through named wrapper options": sourceCase`
        import { writeJson } from "../infra/json-files.js";
        function persist(options: { store: string }) {
          return writeJson(options.store, {});
        }
        const store = "sessions.json";
        const params = { store };
        await persist(params);
      `("src/runtime/named-wrapper-options.ts", [
        { kind: "legacy store filesystem write", line: 8 },
      ]),
      "flags legacy paths read through chained wrapper option properties": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }) {
          return writeTextAtomic(params.filePath.toString(), "{}\\n");
        }
        const options = { filePath: "sessions.json" };
        await persist(options);
      `("src/runtime/chained-wrapper-option-path.ts", [
        { kind: "legacy store filesystem write", line: 7 },
      ]),
      "flags legacy paths passed through destructured wrapper options": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist({ filePath }: { filePath: string }) {
          return writeTextAtomic(filePath, "{}\\n");
        }
        await persist({ filePath: "sessions.json" });
      `("src/runtime/destructured-wrapper-options.ts", [
        { kind: "legacy store filesystem write", line: 6 },
      ]),
      "flags legacy paths passed through nested destructured wrapper options": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist({ paths: { filePath } }: { paths: { filePath: string } }) {
          return writeTextAtomic(filePath, "{}\\n");
        }
        await persist({ paths: { filePath: "sessions.json" } });
      `("src/runtime/nested-destructured-wrapper-options.ts", [
        { kind: "legacy store filesystem write", line: 6 },
      ]),
      "flags legacy paths from nested destructured wrapper option defaults": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist({ paths: { filePath = "sessions.json" } }: { paths: { filePath?: string } }) {
          return writeTextAtomic(filePath, "{}\\n");
        }
        await persist({ paths: {} });
      `("src/runtime/nested-destructured-wrapper-option-default.ts", [
        { kind: "legacy store filesystem write", line: 6 },
      ]),
      "flags nested parameter defaults from identifier-valued intermediate objects": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        const paths = { filePath: "sessions.json" };
        function persist({ paths: { filePath } }: { paths: { filePath: string } } = { paths }) {
          return writeTextAtomic(filePath, "{}\\n");
        }
        await persist();
      `("src/runtime/nested-parameter-default-identifier-intermediate.ts", [
        { kind: "legacy store filesystem write", line: 7 },
      ]),
      "flags nested destructuring defaults from identifier-valued intermediate objects": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        const paths = {};
        function persist({ paths: { filePath = "sessions.json" } }: { paths: { filePath?: string } } = { paths }) {
          return writeTextAtomic(filePath, "{}\\n");
        }
        await persist();
      `("src/runtime/nested-destructuring-default-identifier-intermediate.ts", [
        { kind: "legacy store filesystem write", line: 7 },
      ]),
      "flags nested destructuring defaults from aliased known object literals": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist({ paths: { filePath = "sessions.json" } }: { paths: { filePath?: string } }) {
          return writeTextAtomic(filePath, "{}\\n");
        }
        const source = { paths: {} };
        const options = source;
        await persist(options);
      `("src/runtime/nested-destructuring-default-aliased-known-object.ts", [
        { kind: "legacy store filesystem write", line: 8 },
      ]),
      "flags nested destructuring defaults from parent binding defaults": sourceCase`
        import { promises as fs } from "node:fs";
        function persist({ paths: { filePath } = { filePath: "sessions.json" } }) {
          return fs.writeFile(filePath, "{}\\n");
        }
        await persist({});
      `("src/runtime/nested-destructuring-parent-binding-default.ts", [
        { kind: "legacy store filesystem write", line: 6 },
      ]),
      "does not force nested destructured defaults for unknown intermediate properties": sourceCase`
        import { promises as fs } from "node:fs";
        declare function loadPaths(): { filePath?: string };
        function persist({ paths: { filePath = "sessions.json" } }: { paths: { filePath?: string } }) {
          return fs.writeFile(filePath, "{}\\n");
        }
        const options = { paths: loadPaths() };
        await persist(options);
      `("src/runtime/nested-destructured-wrapper-option-unknown-intermediate.ts", []),
      "flags defaults referencing earlier nested destructured identifier parameters": sourceCase`
        import { promises as fs } from "node:fs";
        function writePath({ paths: { filePath } }: { paths: { filePath: string } }, path = filePath) {
          return fs.writeFile(path, "{}\\n");
        }
        const options = { paths: { filePath: "sessions.json" } };
        await writePath(options);
      `("src/runtime/nested-destructured-wrapper-earlier-identifier-default.ts", [
        { kind: "legacy store filesystem write", line: 7 },
      ]),
      "flags defaults referencing earlier nested object parameter properties": sourceCase`
        import { promises as fs } from "node:fs";
        function writePath(options: { paths: { filePath: string } }, path = options.paths.filePath) {
          return fs.writeFile(path, "{}\\n");
        }
        const options = { paths: { filePath: "sessions.json" } };
        await writePath(options);
      `("src/runtime/nested-object-wrapper-earlier-property-default.ts", [
        { kind: "legacy store filesystem write", line: 7 },
      ]),
      "flags legacy paths passed through positional wrapper parameters": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(filePath: string) {
          return writeTextAtomic(filePath, "{}\\n");
        }
        await persist("sessions.json");
      `("src/runtime/positional-wrapper-path.ts", [
        { kind: "legacy store filesystem write", line: 6 },
      ]),
      "flags defaulted wrapper parameters after optional safe assignments": sourceCase`
        import { promises as fs } from "node:fs";
        let filePath;
        if (useDb) filePath = currentSqlitePath;
        function persist(path = "sessions.json") {
          return fs.writeFile(path, "{}\\n");
        }
        await persist(filePath);
      `("src/runtime/conditional-undefined-defaulted-wrapper-parameter.ts", [
        { kind: "legacy store filesystem write", line: 8 },
      ]),
      "flags legacy paths forwarded through nested wrapper helpers": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          function inner(nextPath: string) {
            return fs.writeFile(nextPath, "{}\\n");
          }
          return inner(filePath);
        }
        await persist("sessions.json");
      `("src/runtime/nested-wrapper-path.ts", [{ kind: "legacy store filesystem write", line: 9 }]),
      "flags legacy paths captured by nested wrapper helpers": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          function inner() {
            return fs.writeFile(filePath, "{}\\n");
          }
          return inner();
        }
        await persist("sessions.json");
      `("src/runtime/nested-wrapper-closed-over-path.ts", [
        { kind: "legacy store filesystem write", line: 9 },
      ]),
      "flags legacy paths captured by nested helpers and forwarded to outer wrappers": sourceCase`
        import { promises as fs } from "node:fs";
        function writePath(path: string) {
          return fs.writeFile(path, "{}\\n");
        }
        function persist(filePath: string) {
          function inner() {
            return writePath(filePath);
          }
          return inner();
        }
        await persist("sessions.json");
      `("src/runtime/nested-helper-forwarded-to-outer-wrapper.ts", [
        { kind: "legacy store filesystem write", line: 12 },
      ]),
      "keeps closed-over write aliases after loop-scoped shadows": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          const write = fs.writeFile;
          function inner() {
            for (const write of [async () => {}]) {}
            return write(filePath, "{}\\n");
          }
          return inner();
        }
        await persist("sessions.json");
      `("src/runtime/nested-wrapper-loop-shadowed-write-alias.ts", [
        { kind: "legacy store filesystem write", line: 11 },
      ]),
      "flags legacy paths forwarded through nested helper parameter defaults": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          function inner(nextPath = filePath) {
            return fs.writeFile(nextPath, "{}\\n");
          }
          return inner();
        }
        await persist("sessions.json");
      `("src/runtime/nested-helper-parameter-default.ts", [
        { kind: "legacy store filesystem write", line: 9 },
      ]),
      "flags legacy paths written by callable nested helper parameter defaults": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          function inner(save = () => fs.writeFile(filePath, "{}\\n")) {
            return save();
          }
          return inner();
        }
        await persist("sessions.json");
      `("src/runtime/nested-helper-callable-parameter-default.ts", [
        { kind: "legacy store filesystem write", line: 9 },
      ]),
      "does not use callable nested helper parameter defaults when callbacks are provided":
        sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          function inner(save = () => fs.writeFile(filePath, "{}\\n")) {
            return save();
          }
          return inner(async () => {});
        }
        await persist("sessions.json");
      `("src/runtime/nested-helper-callable-parameter-default-provided.ts", []),
      "flags legacy paths forwarded through undefined nested helper arguments": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          function inner(nextPath = filePath) {
            return fs.writeFile(nextPath, "{}\\n");
          }
          return inner(undefined);
        }
        await persist("sessions.json");
      `("src/runtime/nested-helper-undefined-parameter-default.ts", [
        { kind: "legacy store filesystem write", line: 9 },
      ]),
      "flags legacy paths forwarded through void nested helper arguments": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          function inner(nextPath = filePath) {
            return fs.writeFile(nextPath, "{}\\n");
          }
          return inner(void 0);
        }
        await persist("sessions.json");
      `("src/runtime/nested-helper-void-parameter-default.ts", [
        { kind: "legacy store filesystem write", line: 9 },
      ]),
      "resolves nested helper parameter defaults in the helper scope": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          function inner(filePath: string, nextPath = filePath) {
            return fs.writeFile(nextPath, "{}\\n");
          }
          return inner(currentSqlitePath);
        }
        await persist("sessions.json");
      `("src/runtime/nested-helper-default-parameter-shadow.ts", []),
      "does not resolve top-level helper parameter defaults in the caller scope": sourceCase`
        import { promises as fs } from "node:fs";
        const defaultPath = "current-state.json";
        function writePath(path = defaultPath) {
          return fs.writeFile(path, "{}\\n");
        }
        function persist(defaultPath: string) {
          return writePath();
        }
        await persist("sessions.json");
      `("src/runtime/top-level-helper-default-caller-shadow.ts", []),
      "does not resolve top-level helper object binding defaults in the caller scope": sourceCase`
        import { promises as fs } from "node:fs";
        const defaultPath = "current-state.json";
        function writePath({ path = defaultPath } = {}) {
          return fs.writeFile(path, "{}\\n");
        }
        function persist(defaultPath: string) {
          return writePath({});
        }
        await persist("sessions.json");
      `("src/runtime/top-level-helper-object-binding-default-caller-shadow.ts", []),
      "flags forwarded top-level helper object binding literal defaults": sourceCase`
        import { promises as fs } from "node:fs";
        function writePath({ path = "sessions.json" } = {}) {
          return fs.writeFile(path, "{}\\n");
        }
        function persist() {
          return writePath({});
        }
        await persist();
      `("src/runtime/top-level-helper-object-binding-literal-default.ts", [
        { kind: "legacy store filesystem write", line: 7 },
      ]),
      "does not resolve top-level helper expression defaults in the caller scope": sourceCase`
        import { promises as fs } from "node:fs";
        const fallback = "current-state.json";
        function writePath(path = filePath ?? fallback) {
          return fs.writeFile(path, "{}\\n");
        }
        function persist(filePath: string) {
          return writePath();
        }
        await persist("sessions.json");
      `("src/runtime/top-level-helper-expression-default-caller-shadow.ts", []),
      "flags top-level helper expression defaults derived from earlier parameters": sourceCase`
        import { promises as fs } from "node:fs";
        const fallback = "current-state.json";
        function writePath(filePath: string, path = filePath ?? fallback) {
          return fs.writeFile(path, "{}\\n");
        }
        function persist(filePath: string) {
          return writePath(filePath);
        }
        await persist("sessions.json");
      `("src/runtime/top-level-helper-earlier-parameter-expression-default.ts", [
        { kind: "legacy store filesystem write", line: 10 },
      ]),
      "flags direct top-level helper calls with defaults derived from earlier arguments":
        sourceCase`
        import { promises as fs } from "node:fs";
        const fallback = "current-state.json";
        function writePath(filePath: string, path = filePath ?? fallback) {
          return fs.writeFile(path, "{}\\n");
        }
        await writePath("sessions.json");
      `("src/runtime/top-level-helper-direct-earlier-parameter-default.ts", [
          { kind: "legacy store filesystem write", line: 7 },
        ]),
      "flags direct top-level helper calls with defaults from earlier destructured arguments":
        sourceCase`
        import { promises as fs } from "node:fs";
        function writePath({ filePath }: { filePath: string }, path = filePath) {
          return fs.writeFile(path, "{}\\n");
        }
        await writePath({ filePath: "sessions.json" });
      `("src/runtime/top-level-helper-direct-destructured-earlier-parameter-default.ts", [
          { kind: "legacy store filesystem write", line: 6 },
        ]),
      "flags direct top-level helper calls with defaults from nested destructured arguments":
        sourceCase`
        import { promises as fs } from "node:fs";
        function writePath(
          { paths: { filePath } }: { paths: { filePath: string } },
          path = filePath,
        ) {
          return fs.writeFile(path, "{}\\n");
        }
        await writePath({ paths: { filePath: "sessions.json" } });
      `("src/runtime/top-level-helper-direct-nested-destructured-earlier-parameter-default.ts", [
          { kind: "legacy store filesystem write", line: 9 },
        ]),
      "does not flag safe defaults that only inspect earlier legacy arguments": sourceCase`
        import { promises as fs } from "node:fs";
        function writePath(
          filePath: string,
          path = filePath ? "current-state.json" : "current-state.json",
        ) {
          return fs.writeFile(path, "{}\\n");
        }
        await writePath("sessions.json");
      `("src/runtime/top-level-helper-safe-conditional-default.ts", []),
      "flags direct top-level helper calls with method defaults from earlier arguments": sourceCase`
        import { promises as fs } from "node:fs";
        function writePath(filePath: string, path = filePath.replace(/\\.json$/, ".json")) {
          return fs.writeFile(path, "{}\\n");
        }
        await writePath("sessions.json");
      `("src/runtime/top-level-helper-direct-method-earlier-parameter-default.ts", [
        { kind: "legacy store filesystem write", line: 6 },
      ]),
      "flags direct top-level helper calls with comma defaults from earlier arguments": sourceCase`
        import { promises as fs } from "node:fs";
        const safePath = "current-state.json";
        function writePath(filePath: string, path = (safePath, filePath)) {
          return fs.writeFile(path, "{}\\n");
        }
        await writePath("sessions.json");
      `("src/runtime/top-level-helper-direct-comma-earlier-parameter-default.ts", [
        { kind: "legacy store filesystem write", line: 7 },
      ]),
      "flags direct top-level helper calls with assignment defaults from earlier arguments":
        sourceCase`
        import { promises as fs } from "node:fs";
        let cached = "current-state.json";
        function writePath(filePath: string, path = (cached = filePath)) {
          return fs.writeFile(path, "{}\\n");
        }
        await writePath("sessions.json");
      `("src/runtime/top-level-helper-direct-assignment-earlier-parameter-default.ts", [
          { kind: "legacy store filesystem write", line: 7 },
        ]),
      "flags top-level helper object binding expression defaults derived from earlier parameters":
        sourceCase`
        import { promises as fs } from "node:fs";
        const fallback = "current-state.json";
        function writePath(filePath: string, { path = filePath ?? fallback } = {}) {
          return fs.writeFile(path, "{}\\n");
        }
        function persist(filePath: string) {
          return writePath(filePath, {});
        }
        await persist("sessions.json");
      `("src/runtime/top-level-helper-object-binding-earlier-parameter-expression-default.ts", [
          { kind: "legacy store filesystem write", line: 10 },
        ]),
      "flags direct top-level helper calls with object binding defaults from earlier arguments":
        sourceCase`
        import { promises as fs } from "node:fs";
        const fallback = "current-state.json";
        function writePath(filePath: string, { path = filePath ?? fallback } = {}) {
          return fs.writeFile(path, "{}\\n");
        }
        await writePath("sessions.json");
      `("src/runtime/top-level-helper-direct-object-binding-earlier-parameter-default.ts", [
          { kind: "legacy store filesystem write", line: 7 },
        ]),
      "flags object binding defaults from missing properties on identifier arguments": sourceCase`
        import { promises as fs } from "node:fs";
        const options = {};
        function writePath(filePath: string, { path = filePath } = {}) {
          return fs.writeFile(path, "{}\\n");
        }
        await writePath("sessions.json", options);
      `("src/runtime/top-level-helper-object-binding-missing-identifier-default.ts", [
        { kind: "legacy store filesystem write", line: 7 },
      ]),
      "flags object binding defaults from undefined properties on identifier arguments": sourceCase`
        import { promises as fs } from "node:fs";
        const options = { path: undefined };
        function writePath(filePath: string, { path = filePath } = {}) {
          return fs.writeFile(path, "{}\\n");
        }
        await writePath("sessions.json", options);
      `("src/runtime/top-level-helper-object-binding-undefined-identifier-default.ts", [
        { kind: "legacy store filesystem write", line: 7 },
      ]),
      "flags object binding defaults from undefined properties in parameter defaults": sourceCase`
        import { promises as fs } from "node:fs";
        function writePath({ path = "sessions.json" } = { path: undefined }) {
          return fs.writeFile(path, "{}\\n");
        }
        await writePath();
      `("src/runtime/top-level-helper-object-binding-undefined-parameter-default.ts", [
        { kind: "legacy store filesystem write", line: 6 },
      ]),
      "uses explicit safe properties on identifier arguments before object binding defaults":
        sourceCase`
        import { promises as fs } from "node:fs";
        const options = { path: "current-state.json" };
        function writePath(filePath: string, { path = filePath } = {}) {
          return fs.writeFile(path, "{}\\n");
        }
        await writePath("sessions.json", options);
      `("src/runtime/top-level-helper-object-binding-safe-identifier-property.ts", []),
      "does not force object binding defaults for unknown identifier arguments": sourceCase`
        import { promises as fs } from "node:fs";
        declare function loadOptions(): { path?: string };
        const options = loadOptions();
        function writePath(filePath: string, { path = filePath } = {}) {
          return fs.writeFile(path, "{}\\n");
        }
        await writePath("sessions.json", options);
      `("src/runtime/top-level-helper-object-binding-unknown-identifier-default.ts", []),
      "does not force object binding defaults for identifier arguments with unknown spreads":
        sourceCase`
        import { promises as fs } from "node:fs";
        declare const defaults: { path?: string };
        const options = { ...defaults };
        function writePath(filePath: string, { path = filePath } = {}) {
          return fs.writeFile(path, "{}\\n");
        }
        await writePath("sessions.json", options);
      `("src/runtime/top-level-helper-object-binding-unknown-spread-default.ts", []),
      "keeps explicit undefined object properties after exhaustive branch merges": sourceCase`
        import { promises as fs } from "node:fs";
        function writePath(filePath: string, { path = filePath } = {}) {
          return fs.writeFile(path, "{}\\n");
        }
        const options = { path: "current-state.json" };
        if (Math.random() > 0.5) {
          options.path = undefined;
        } else {
          options.path = undefined;
        }
        await writePath("sessions.json", options);
      `("src/runtime/top-level-helper-object-binding-branch-undefined-default.ts", [
        { kind: "legacy store filesystem write", line: 12 },
      ]),
      "keeps maybe undefined object properties after exhaustive branch merges": sourceCase`
        import { promises as fs } from "node:fs";
        function writePath(filePath: string, { path = filePath } = {}) {
          return fs.writeFile(path, "{}\\n");
        }
        const options = { path: "current-state.json" };
        if (Math.random() > 0.5) {
          options.path = undefined;
        } else {
          options.path = "current-state.json";
        }
        await writePath("sessions.json", options);
      `("src/runtime/top-level-helper-object-binding-branch-maybe-undefined-default.ts", [
        { kind: "legacy store filesystem write", line: 12 },
      ]),
      "keeps known nested object literals after exhaustive branch merges": sourceCase`
        import { promises as fs } from "node:fs";
        function writePath({ paths: { filePath = "sessions.json" } = {} }) {
          return fs.writeFile(filePath, "{}\\n");
        }
        let options = { paths: { filePath: "current-state.json" } };
        if (Math.random() > 0.5) {
          options = { paths: {} };
        } else {
          options = { paths: {} };
        }
        await writePath(options);
      `("src/runtime/top-level-helper-object-binding-branch-known-nested-object.ts", [
        { kind: "legacy store filesystem write", line: 12 },
      ]),
      "does not force object binding defaults after exhaustive unknown object branch merges":
        sourceCase`
        import { promises as fs } from "node:fs";
        declare function loadOptions(): { path?: string };
        function writePath(filePath: string, { path = filePath } = {}) {
          return fs.writeFile(path, "{}\\n");
        }
        let options;
        if (Math.random() > 0.5) {
          options = { path: "current-state.json" };
        } else {
          options = loadOptions();
        }
        await writePath("sessions.json", options);
      `("src/runtime/top-level-helper-object-binding-branch-unknown-default.ts", []),
      "does not force object binding defaults after optional unknown object rewrites": sourceCase`
        import { promises as fs } from "node:fs";
        declare function loadOptions(): { path?: string };
        function writePath(filePath: string, { path = filePath } = {}) {
          return fs.writeFile(path, "{}\\n");
        }
        let options = loadOptions();
        if (Math.random() > 0.5) {
          options = {};
        }
        await writePath("sessions.json", options);
      `("src/runtime/top-level-helper-object-binding-optional-unknown-rewrite-default.ts", []),
      "keeps known-missing object properties after exhaustive branch merges": sourceCase`
        import { promises as fs } from "node:fs";
        function writePath(filePath: string, { path = filePath } = {}) {
          return fs.writeFile(path, "{}\\n");
        }
        let options;
        if (Math.random() > 0.5) {
          options = { path: "current-state.json" };
        } else {
          options = {};
        }
        await writePath("sessions.json", options);
      `("src/runtime/top-level-helper-object-binding-branch-known-missing-default.ts", [
        { kind: "legacy store filesystem write", line: 12 },
      ]),
      "flags object binding defaults from earlier destructured arguments": sourceCase`
        import { promises as fs } from "node:fs";
        function writePath({ filePath }: { filePath: string }, { path = filePath } = {}) {
          return fs.writeFile(path, "{}\\n");
        }
        await writePath({ filePath: "sessions.json" }, {});
      `("src/runtime/top-level-helper-object-binding-destructured-earlier-parameter-default.ts", [
        { kind: "legacy store filesystem write", line: 6 },
      ]),
      "flags object binding defaults from nested destructured arguments": sourceCase`
        import { promises as fs } from "node:fs";
        function writePath(
          { paths: { filePath } }: { paths: { filePath: string } },
          { path = filePath } = {},
        ) {
          return fs.writeFile(path, "{}\\n");
        }
        await writePath({ paths: { filePath: "sessions.json" } }, {});
      `(
        "src/runtime/top-level-helper-object-binding-nested-destructured-earlier-parameter-default.ts",
        [{ kind: "legacy store filesystem write", line: 9 }],
      ),
      "does not scan unrelated object properties for earlier property defaults": sourceCase`
        import { promises as fs } from "node:fs";
        function writePath(
          options: { currentPath: string; legacyPath: string },
          path = options.currentPath,
        ) {
          return fs.writeFile(path, "{}\\n");
        }
        await writePath({
          currentPath: "state/openclaw.sqlite",
          legacyPath: "sessions.json",
        });
      `("src/runtime/top-level-helper-property-default-unrelated-legacy-property.ts", []),
      "does not scan unrelated object properties for bracket defaults": sourceCase`
        import { promises as fs } from "node:fs";
        function writePath(
          options: { currentPath: string; legacyPath: string },
          path = options["currentPath"],
        ) {
          return fs.writeFile(path, "{}\\n");
        }
        await writePath({
          currentPath: "state/openclaw.sqlite",
          legacyPath: "sessions.json",
        });
      `("src/runtime/top-level-helper-bracket-default-unrelated-legacy-property.ts", []),
      "flags direct top-level helper calls with nested property defaults": sourceCase`
        import { promises as fs } from "node:fs";
        function writePath(
          options: { paths: { filePath: string } },
          path = options.paths.filePath,
        ) {
          return fs.writeFile(path, "{}\\n");
        }
        await writePath({
          paths: { filePath: "sessions.json" },
        });
      `("src/runtime/top-level-helper-nested-property-default.ts", [
        { kind: "legacy store filesystem write", line: 9 },
      ]),
      "flags direct top-level helper calls with nested bracket property defaults": sourceCase`
        import { promises as fs } from "node:fs";
        function writePath(
          options: { paths: { filePath: string } },
          path = options.paths["filePath"],
        ) {
          return fs.writeFile(path, "{}\\n");
        }
        await writePath({
          paths: { filePath: "sessions.json" },
        });
      `("src/runtime/top-level-helper-nested-bracket-property-default.ts", [
        { kind: "legacy store filesystem write", line: 9 },
      ]),
      "does not crash on unknown spreads in nested property defaults": sourceCase`
        import { promises as fs } from "node:fs";
        declare const defaults: { paths?: { filePath: string } };
        function writePath(
          options: { paths?: { filePath: string } },
          path = options.paths.filePath,
        ) {
          return fs.writeFile(path, "{}\\n");
        }
        await writePath({ ...defaults });
      `("src/runtime/top-level-helper-nested-property-default-unknown-spread.ts", []),
      "keeps nested legacy paths before unknown outer spreads": sourceCase`
        import { promises as fs } from "node:fs";
        declare const options: { paths?: { filePath: string } };
        function persist({ paths: { filePath } }: { paths: { filePath: string } }) {
          return fs.writeFile(filePath, "{}\\n");
        }
        await persist({ paths: { filePath: "sessions.json" }, ...options });
      `("src/runtime/nested-wrapper-path-before-unknown-spread.ts", [
        { kind: "legacy store filesystem write", line: 7 },
      ]),
      "flags nested legacy paths passed through shorthand options": sourceCase`
        import { promises as fs } from "node:fs";
        const paths = { filePath: "sessions.json" };
        function writePath(options: { paths: { filePath: string } }, path = options.paths.filePath) {
          return fs.writeFile(path, "{}\\n");
        }
        await writePath({ paths });
      `("src/runtime/top-level-helper-nested-shorthand-options.ts", [
        { kind: "legacy store filesystem write", line: 7 },
      ]),
      "flags nested legacy paths forwarded through identifier-valued object properties": sourceCase`
        import { promises as fs } from "node:fs";
        function persist({ paths: { filePath } }: { paths: { filePath: string } }) {
          return fs.writeFile(filePath, "{}\\n");
        }
        const paths = { filePath: "sessions.json" };
        const options = { paths };
        await persist(options);
      `("src/runtime/nested-wrapper-identifier-valued-object-property.ts", [
        { kind: "legacy store filesystem write", line: 8 },
      ]),
      "flags nested legacy paths hidden in intermediate option expressions": sourceCase`
        import { promises as fs } from "node:fs";
        declare function makePaths(filePath: string): { filePath: string };
        function persist({ paths: { filePath } }: { paths: { filePath: string } }) {
          return fs.writeFile(filePath, "{}\\n");
        }
        await persist({ paths: makePaths("sessions.json") });
      `("src/runtime/nested-wrapper-path-intermediate-expression.ts", [
        { kind: "legacy store filesystem write", line: 7 },
      ]),
      "flags direct top-level helper calls with chained literal parameter defaults": sourceCase`
        import { promises as fs } from "node:fs";
        function writePath(filePath = "sessions.json", path = filePath) {
          return fs.writeFile(path, "{}\\n");
        }
        await writePath();
      `("src/runtime/top-level-helper-chained-literal-parameter-default.ts", [
        { kind: "legacy store filesystem write", line: 6 },
      ]),
      "flags direct top-level helper calls with nested object literal parameter defaults":
        sourceCase`
        import { promises as fs } from "node:fs";
        function writePath(
          options = { paths: { filePath: "sessions.json" } },
          path = options.paths.filePath,
        ) {
          return fs.writeFile(path, "{}\\n");
        }
        await writePath();
      `("src/runtime/top-level-helper-nested-object-literal-parameter-default.ts", [
          { kind: "legacy store filesystem write", line: 9 },
        ]),
      "flags direct top-level helper calls with nested spread parameter defaults": sourceCase`
        import { promises as fs } from "node:fs";
        const defaults = { paths: { filePath: "sessions.json" } };
        function writePath(
          options = { ...defaults },
          path = options.paths.filePath,
        ) {
          return fs.writeFile(path, "{}\\n");
        }
        await writePath();
      `("src/runtime/top-level-helper-nested-spread-parameter-default.ts", [
        { kind: "legacy store filesystem write", line: 10 },
      ]),
      "does not resolve top-level helper nested spread defaults in the caller scope": sourceCase`
        import { promises as fs } from "node:fs";
        const defaults = { paths: { filePath: "current-state.json" } };
        function writePath(
          options = { ...defaults },
          path = options.paths.filePath,
        ) {
          return fs.writeFile(path, "{}\\n");
        }
        function persist() {
          const defaults = { paths: { filePath: "sessions.json" } };
          return writePath();
        }
        await persist();
      `("src/runtime/top-level-helper-nested-spread-default-caller-shadow.ts", []),
      "does not resolve omitted earlier helper parameters in the caller scope": sourceCase`
        import { promises as fs } from "node:fs";
        function writePath(filePath?: string, path = filePath) {
          return fs.writeFile(path, "{}\\n");
        }
        function persist(filePath: string) {
          return writePath();
        }
        await persist("sessions.json");
      `("src/runtime/top-level-helper-omitted-earlier-default.ts", []),
      "does not resolve omitted earlier helper parameters in object binding defaults": sourceCase`
        import { promises as fs } from "node:fs";
        function writePath(filePath?: string, { path = filePath } = {}) {
          return fs.writeFile(path, "{}\\n");
        }
        function persist(filePath: string) {
          return writePath(undefined, {});
        }
        await persist("sessions.json");
      `("src/runtime/top-level-helper-object-binding-omitted-earlier-default.ts", []),
      "flags default expressions that combine multiple earlier parameters": sourceCase`
        import { promises as fs } from "node:fs";
        function writePath(prefix: string, filePath: string, path = prefix + filePath) {
          return fs.writeFile(path, "{}\\n");
        }
        function persist(filePath: string) {
          return writePath("state/", filePath);
        }
        await persist("sessions.json");
      `("src/runtime/top-level-helper-multiple-earlier-parameter-default.ts", [
        { kind: "legacy store filesystem write", line: 9 },
      ]),
      "does not resolve top-level helper defaults in closed-over caller scope": sourceCase`
        import { promises as fs } from "node:fs";
        const defaultPath = "current-state.json";
        function writePath(path = defaultPath) {
          return fs.writeFile(path, "{}\\n");
        }
        function persist(defaultPath: string) {
          function inner() {
            return writePath();
          }
          return inner();
        }
        await persist("sessions.json");
      `("src/runtime/top-level-helper-default-closed-over-caller-shadow.ts", []),
      "does not treat top-level helper aliases as closed over nested helpers": sourceCase`
        import { promises as fs } from "node:fs";
        const filePath = "current-state.json";
        function writeCurrent() {
          return fs.writeFile(filePath, "{}\\n");
        }
        function persist(filePath: string) {
          function inner() {
            const save = writeCurrent;
            return save();
          }
          return inner();
        }
        await persist("sessions.json");
      `("src/runtime/top-level-helper-alias-module-path-shadow.ts", []),
      "does not resolve aliased top-level helper defaults in the caller scope": sourceCase`
        import { promises as fs } from "node:fs";
        const defaultPath = "current-state.json";
        function writePath(path = defaultPath) {
          return fs.writeFile(path, "{}\\n");
        }
        function persist(defaultPath: string) {
          const save = writePath;
          return save();
        }
        await persist("sessions.json");
      `("src/runtime/top-level-helper-alias-default-caller-shadow.ts", []),
    }),
  )("$name", ({ source, filename, expected }) => {
    const violations = collectDatabaseFirstLegacyStoreViolations(source, filename);

    expect(violations).toEqual(expected);
  });

  // Nested helper capture and wrapper propagation.
  it.each(
    namedCases({
      "flags legacy paths forwarded through nested helper object binding defaults": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          function inner({ path = filePath } = {}) {
            return fs.writeFile(path, "{}\\n");
          }
          return inner();
        }
        await persist("sessions.json");
      `("src/runtime/nested-helper-object-binding-default.ts", [
        { kind: "legacy store filesystem write", line: 9 },
      ]),
      "does not use nested helper object binding defaults when a spread may provide the property":
        sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          const options = getOptions();
          function inner({ path = filePath } = {}) {
            return fs.writeFile(path, "{}\\n");
          }
          return inner({ ...options });
        }
        await persist("sessions.json");
      `("src/runtime/nested-helper-object-binding-default-unknown-spread.ts", []),
      "flags nested helper object binding defaults after known-empty object spreads": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          const defaults = {};
          function inner({ path = filePath } = {}) {
            return fs.writeFile(path, "{}\\n");
          }
          return inner({ ...defaults, ...{} });
        }
        await persist("sessions.json");
      `("src/runtime/nested-helper-object-binding-default-known-empty-spread.ts", [
        { kind: "legacy store filesystem write", line: 10 },
      ]),
      "resolves nested helper object binding defaults in the helper scope": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          function inner(filePath: string, { path = filePath } = {}) {
            return fs.writeFile(path, "{}\\n");
          }
          return inner(currentSqlitePath, {});
        }
        await persist("sessions.json");
      `("src/runtime/nested-helper-object-binding-default-shadow.ts", []),
      "flags legacy paths forwarded through undefined nested helper object arguments": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          function inner({ path = filePath } = {}) {
            return fs.writeFile(path, "{}\\n");
          }
          return inner(undefined);
        }
        await persist("sessions.json");
      `("src/runtime/nested-helper-undefined-object-binding-default.ts", [
        { kind: "legacy store filesystem write", line: 9 },
      ]),
      "flags legacy paths forwarded through explicit undefined nested helper object properties":
        sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          function inner({ path = filePath } = {}) {
            return fs.writeFile(path, "{}\\n");
          }
          return inner({ path: undefined });
        }
        await persist("sessions.json");
      `("src/runtime/nested-helper-undefined-object-property-default.ts", [
          { kind: "legacy store filesystem write", line: 9 },
        ]),
      "flags legacy paths captured by nested helpers with local fs aliases": sourceCase`
        function persist(filePath: string) {
          function inner() {
            const fs = require("node:fs");
            return fs.writeFileSync(filePath, "{}\\n");
          }
          return inner();
        }
        persist("sessions.json");
      `("src/runtime/nested-wrapper-closed-over-local-fs.ts", [
        { kind: "legacy store filesystem write", line: 9 },
      ]),
      "does not treat named function expression self-bindings as captured write aliases":
        sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          const writeFile = fs.writeFile;
          const inner = function writeFile() {
            return writeFile(filePath);
          };
          return inner();
        }
        await persist("sessions.json");
      `("src/runtime/named-function-expression-write-alias-shadow.ts", []),
      "flags legacy paths captured by defaulted destructured nested helpers": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          const writer = {};
          function inner() {
            const { save = () => fs.writeFile(filePath, "{}\\n") } = writer;
            return save();
          }
          return inner();
        }
        await persist("sessions.json");
      `("src/runtime/defaulted-destructured-nested-helper.ts", [
        { kind: "legacy store filesystem write", line: 11 },
      ]),
      "does not use nested helper destructuring defaults when safe callbacks are present":
        sourceCase`
        import { promises as fs } from "node:fs";
        const noopParam = async (_path: string) => {};
        function persist(filePath: string) {
          function inner() {
            const writer = { save: noopParam };
            const { save = () => fs.writeFile(filePath, "{}\\n") } = writer;
            return save(filePath);
          }
          return inner();
        }
        await persist("sessions.json");
      `("src/runtime/present-safe-callback-nested-default.ts", []),
      "uses nested helper destructuring defaults when properties are explicitly undefined":
        sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          function inner() {
            const writer = { save: undefined };
            const { save = () => fs.writeFile(filePath, "{}\\n") } = writer;
            return save();
          }
          return inner();
        }
        await persist("sessions.json");
      `("src/runtime/undefined-callback-nested-default.ts", [
          { kind: "legacy store filesystem write", line: 11 },
        ]),
      "does not resolve outer object methods through local object shadows": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          const writer = {
            save() {
              return fs.writeFile(filePath, "{}\\n");
            },
          };
          function inner() {
            const writer = getWriter();
            const { save } = writer;
            return save();
          }
          return inner();
        }
        await persist("sessions.json");
      `("src/runtime/local-object-shadow-nested-method.ts", []),
      "keeps branch-only object methods inside closed-over nested helpers": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string, enabled: boolean) {
          function inner() {
            let writer = {};
            if (enabled) {
              writer = {
                save() {
                  return fs.writeFile(filePath, "{}\\n");
                },
              };
            } else {
              writer = {};
            }
            const { save } = writer;
            return save();
          }
          return inner();
        }
        await persist("sessions.json", true);
      `("src/runtime/branch-only-closed-over-object-method.ts", [
        { kind: "legacy store filesystem write", line: 20 },
      ]),
      "keeps branch-only property assigned methods inside closed-over nested helpers": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string, enabled: boolean) {
          function inner() {
            let writer = {};
            if (enabled) {
              writer.save = () => fs.writeFile(filePath, "{}\\n");
            } else {
              writer = {};
            }
            return writer.save?.();
          }
          return inner();
        }
        await persist("sessions.json", true);
      `("src/runtime/branch-only-property-closed-over-object-method.ts", [
        { kind: "legacy store filesystem write", line: 15 },
      ]),
      "flags legacy paths captured by nested helpers with branch-assigned write aliases":
        sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string, json: boolean) {
          function inner() {
            let write: typeof fs.writeFile;
            if (json) {
              write = fs.writeFile;
            } else {
              write = fs.writeFile;
            }
            return write(filePath, "{}\\n");
          }
          return inner();
        }
        await persist("sessions.json", true);
      `("src/runtime/nested-wrapper-branch-assigned-write-alias.ts", [
          { kind: "legacy store filesystem write", line: 15 },
        ]),
      "flags legacy paths captured by conditionally assigned nested helpers": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string, json: boolean) {
          function inner() {
            let save;
            if (json) {
              save = () => fs.writeFile(filePath, "{}\\n");
            } else {
              save = () => fs.writeFile(filePath, "{}\\n");
            }
            return save();
          }
          return inner();
        }
        await persist("sessions.json", true);
      `("src/runtime/conditionally-assigned-nested-helper.ts", [
        { kind: "legacy store filesystem write", line: 15 },
      ]),
      "keeps legacy nested helpers after braceless optional reassignment": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string, disabled: boolean) {
          function inner() {
            let save = () => fs.writeFile(filePath, "{}\\n");
            if (disabled) save = async () => {};
            return save();
          }
          return inner();
        }
        await persist("sessions.json", false);
      `("src/runtime/nested-wrapper-braceless-optional-reassignment.ts", [
        { kind: "legacy store filesystem write", line: 11 },
      ]),
      "flags legacy paths captured by nested helpers with destructured fs aliases": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          function inner() {
            const { writeFile } = fs;
            return writeFile(filePath, "{}\\n");
          }
          return inner();
        }
        await persist("sessions.json");
      `("src/runtime/nested-wrapper-closed-over-destructured-fs.ts", [
        { kind: "legacy store filesystem write", line: 10 },
      ]),
      "ignores nested helpers with shadowed local require aliases": sourceCase`
        function persist(filePath: string, customRequire: NodeRequire) {
          function inner() {
            const require = customRequire;
            const fs = require("node:fs");
            return fs.writeFileSync(filePath, "{}\\n");
          }
          return inner();
        }
        persist("sessions.json", customRequire);
      `("src/runtime/nested-wrapper-shadowed-require.ts", []),
      "uses nested helper createRequire shadows from the helper definition": sourceCase`
        import { createRequire } from "node:module";
        function persist(filePath: string, customCreateRequire: typeof createRequire) {
          function inner() {
            const req = createRequire(import.meta.url);
            const fs = req("node:fs");
            return fs.writeFileSync(filePath, "{}\\n");
          }
          {
            const createRequire = customCreateRequire;
            return inner();
          }
        }
        persist("sessions.json", customCreateRequire);
      `("src/runtime/nested-wrapper-create-require-definition-scope.ts", [
        { kind: "legacy store filesystem write", line: 14 },
      ]),
      "does not treat named nested function expressions as closed-over path parameters": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          const inner = function filePath() {
            return fs.writeFile(filePath, "{}\\n");
          };
          return inner();
        }
        await persist("sessions.json");
      `("src/runtime/nested-wrapper-named-function-expression.ts", []),
      "does not resolve locally shadowed nested helper calls to outer wrappers": sourceCase`
        import { promises as fs } from "node:fs";
        function helper(filePath: string) {
          return fs.writeFile(filePath, "{}\\n");
        }
        function persist(filePath: string) {
          function inner(helper: (path: string) => Promise<void>) {
            return helper(filePath);
          }
          return inner(async () => {});
        }
        await persist("sessions.json");
      `("src/runtime/nested-wrapper-shadowed-helper-call.ts", []),
      "flags legacy paths captured by branch-assigned nested helpers": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string, useJson: boolean) {
          let inner;
          if (useJson) {
            inner = () => fs.writeFile(filePath, "{}\\n");
          }
          return inner();
        }
        await persist("sessions.json", true);
      `("src/runtime/nested-wrapper-branch-assigned-closed-over-path.ts", [
        { kind: "legacy store filesystem write", line: 10 },
      ]),
      "flags legacy paths captured through nested helper chains": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          function inner() {
            function deeper() {
              return fs.writeFile(filePath, "{}\\n");
            }
            return deeper();
          }
          return inner();
        }
        await persist("sessions.json");
      `("src/runtime/nested-wrapper-helper-chain-closed-over-path.ts", [
        { kind: "legacy store filesystem write", line: 12 },
      ]),
      "flags legacy paths captured through hoisted nested helper chains": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          function inner() {
            return deeper();
            function deeper() {
              return fs.writeFile(filePath, "{}\\n");
            }
          }
          return inner();
        }
        await persist("sessions.json");
      `("src/runtime/nested-wrapper-hoisted-helper-chain-closed-over-path.ts", [
        { kind: "legacy store filesystem write", line: 12 },
      ]),
      "flags hoisted nested helpers that use write aliases declared later": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          function inner() {
            function deeper() {
              return write(filePath, "{}\\n");
            }
            const write = fs.writeFile;
            return deeper();
          }
          return inner();
        }
        await persist("sessions.json");
      `("src/runtime/nested-wrapper-hoisted-helper-late-alias.ts", [
        { kind: "legacy store filesystem write", line: 13 },
      ]),
      "flags escaped nested helpers that use write aliases declared later": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          let save;
          function configure() {
            save = () => write(filePath, "{}\\n");
            const write = fs.writeFile;
          }
          configure();
          return save?.();
        }
        await persist("sessions.json");
      `("src/runtime/nested-wrapper-escaped-late-write-alias.ts", [
        { kind: "legacy store filesystem write", line: 12 },
      ]),
      "flags block-escaped nested helpers that use block write aliases declared later": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          function inner() {
            let save;
            {
              save = () => write(filePath, "{}\\n");
              const write = fs.writeFile;
            }
            return save?.();
          }
          return inner();
        }
        await persist("sessions.json");
      `("src/runtime/nested-wrapper-block-escaped-late-write-alias.ts", [
        { kind: "legacy store filesystem write", line: 14 },
      ]),
      "flags var nested helpers declared in blocks": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          function inner() {
            {
              var save = () => fs.writeFile(filePath, "{}\\n");
            }
            return save();
          }
          return inner();
        }
        await persist("sessions.json");
      `("src/runtime/nested-wrapper-var-block-helper.ts", [
        { kind: "legacy store filesystem write", line: 12 },
      ]),
      "flags var nested helper object methods declared in blocks": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          function inner() {
            {
              var writer = {
                save() {
                  return fs.writeFile(filePath, "{}\\n");
                },
              };
            }
            return writer.save();
          }
          return inner();
        }
        await persist("sessions.json");
      `("src/runtime/nested-wrapper-var-block-helper-object-method.ts", [
        { kind: "legacy store filesystem write", line: 16 },
      ]),
      "flags nested helper defaults from object literal destructuring": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          const { save = () => fs.writeFile(filePath, "{}\\n") } = {};
          return save();
        }
        await persist("sessions.json");
      `("src/runtime/nested-wrapper-object-literal-destructuring-default.ts", [
        { kind: "legacy store filesystem write", line: 7 },
      ]),
      "uses the last object literal property before nested helper destructuring defaults":
        sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          const safe = () => undefined;
          const { save = () => fs.writeFile(filePath, "{}\\n") } = {
            save: safe,
            save: undefined,
          };
          return save?.();
        }
        await persist("sessions.json");
      `("src/runtime/nested-wrapper-object-literal-duplicate-default.ts", [
          { kind: "legacy store filesystem write", line: 11 },
        ]),
      "does not use nested helper destructuring defaults when the last duplicate is safe":
        sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          const safe = () => undefined;
          const { save = () => fs.writeFile(filePath, "{}\\n") } = {
            save: undefined,
            save: safe,
          };
          return save?.();
        }
        await persist("sessions.json");
      `("src/runtime/nested-wrapper-object-literal-duplicate-safe.ts", []),
      "does not use nested helper destructuring defaults when a spread may provide the property":
        sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          const safe = async () => {};
          const { save = () => fs.writeFile(filePath, "{}\\n") } = {
            ...{ save: safe },
          };
          return save();
        }
        await persist("sessions.json");
      `("src/runtime/nested-wrapper-object-literal-spread-safe.ts", []),
      "does not use nested helper destructuring defaults for untracked identifier spreads":
        sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          const defaults = getWriter();
          const { save = () => fs.writeFile(filePath, "{}\\n") } = {
            ...defaults,
          };
          return save?.();
        }
        await persist("sessions.json");
      `("src/runtime/nested-wrapper-object-literal-unknown-spread-default.ts", []),
      "keeps earlier wrapper properties through known-missing object spreads": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          const save = () => fs.writeFile(filePath, "{}\\n");
          const defaults = {};
          const { save: inner = async () => {} } = {
            save,
            ...defaults,
          };
          return inner();
        }
        await persist("sessions.json");
      `("src/runtime/nested-wrapper-object-literal-known-missing-spread.ts", [
        { kind: "legacy store filesystem write", line: 12 },
      ]),
      "uses nested helper destructuring defaults after known undefined object spreads": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          const defaults = { save: undefined };
          const { save = () => fs.writeFile(filePath, "{}\\n") } = {
            ...defaults,
          };
          return save();
        }
        await persist("sessions.json");
      `("src/runtime/nested-wrapper-object-literal-undefined-spread-default.ts", [
        { kind: "legacy store filesystem write", line: 10 },
      ]),
      "flags var nested wrappers declared in blocks": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          {
            var inner = (path: string) => fs.writeFile(path, "{}\\n");
          }
          return inner(filePath);
        }
        await persist("sessions.json");
      `("src/runtime/nested-wrapper-var-block-declaration.ts", [
        { kind: "legacy store filesystem write", line: 9 },
      ]),
      "merges var nested wrapper declarations inside exhaustive branches": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string, enabled: boolean) {
          if (enabled) {
            var inner = (path: string) => fs.writeFile(path, "{}\\n");
          } else {
            var inner = async (_path: string) => {};
          }
          return inner(filePath);
        }
        await persist("sessions.json", true);
      `("src/runtime/nested-wrapper-var-branch-declaration.ts", [
        { kind: "legacy store filesystem write", line: 11 },
      ]),
      "keeps prior var nested wrapper declarations after optional branch redeclarations":
        sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string, disabled: boolean) {
          var inner = (path: string) => fs.writeFile(path, "{}\\n");
          if (disabled) {
            var inner = async (_path: string) => {};
          }
          return inner(filePath);
        }
        await persist("sessions.json", false);
      `("src/runtime/nested-wrapper-var-optional-branch-declaration.ts", [
          { kind: "legacy store filesystem write", line: 10 },
        ]),
      "flags var nested wrapper destructuring defaults declared in blocks": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          {
            var { save = (path: string) => fs.writeFile(path, "{}\\n") } = {};
          }
          return save(filePath);
        }
        await persist("sessions.json");
      `("src/runtime/nested-wrapper-var-block-destructuring-default.ts", [
        { kind: "legacy store filesystem write", line: 9 },
      ]),
      "flags legacy paths captured through sibling nested helper calls": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          function save() {
            return fs.writeFile(filePath, "{}\\n");
          }
          function inner() {
            return save();
          }
          return inner();
        }
        await persist("sessions.json");
      `("src/runtime/nested-wrapper-sibling-helper-call-closed-over-path.ts", [
        { kind: "legacy store filesystem write", line: 12 },
      ]),
      "flags legacy paths forwarded through sibling nested helper parameters": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          function inner(nextPath: string) {
            return deeper(nextPath);
          }
          function deeper(nextPath: string) {
            return fs.writeFile(nextPath, "{}\\n");
          }
          return inner(filePath);
        }
        await persist("sessions.json");
      `("src/runtime/nested-wrapper-sibling-helper-forwarded-path.ts", [
        { kind: "legacy store filesystem write", line: 12 },
      ]),
      "flags legacy paths captured through nested arrow helper chains": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          const inner = () => {
            const deeper = () => fs.writeFile(filePath, "{}\\n");
            return deeper();
          };
          return inner();
        }
        await persist("sessions.json");
      `("src/runtime/nested-wrapper-arrow-helper-chain-closed-over-path.ts", [
        { kind: "legacy store filesystem write", line: 10 },
      ]),
      "flags legacy paths captured through nested helper aliases": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          function inner() {
            const deeper = () => fs.writeFile(filePath, "{}\\n");
            const save = deeper;
            return save();
          }
          return inner();
        }
        await persist("sessions.json");
      `("src/runtime/nested-wrapper-helper-alias-closed-over-path.ts", [
        { kind: "legacy store filesystem write", line: 11 },
      ]),
      "flags legacy paths captured through nested object helper methods": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          function inner() {
            const writer = {
              save() {
                return fs.writeFile(filePath, "{}\\n");
              },
            };
            return writer.save();
          }
          return inner();
        }
        await persist("sessions.json");
      `("src/runtime/nested-wrapper-object-helper-closed-over-path.ts", [
        { kind: "legacy store filesystem write", line: 14 },
      ]),
      "flags legacy paths captured through nested object helper aliases": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          function inner() {
            const save = () => fs.writeFile(filePath, "{}\\n");
            const writer = { save };
            return writer.save();
          }
          return inner();
        }
        await persist("sessions.json");
      `("src/runtime/nested-wrapper-object-helper-alias-closed-over-path.ts", [
        { kind: "legacy store filesystem write", line: 11 },
      ]),
      "does not treat nested function declaration shadows as captured write aliases": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          const write = fs.writeFile;
          function inner() {
            function write() {}
            return write(filePath);
          }
          return inner();
        }
        await persist("sessions.json");
      `("src/runtime/nested-wrapper-function-declaration-write-shadow.ts", []),
      "does not treat nested helper parameters as captured write aliases": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string, customWrite: (value: string) => void) {
          const writeFile = fs.writeFile;
          function inner(writeFile: (value: string) => void) {
            return writeFile(filePath);
          }
          return inner(customWrite);
        }
        await persist("sessions.json", customWrite);
      `("src/runtime/nested-wrapper-parameter-write-alias-shadow.ts", []),
      "flags legacy paths forwarded through nested arrow helpers": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          const inner = (nextPath: string) => fs.writeFile(nextPath, "{}\\n");
          return inner(filePath);
        }
        await persist("sessions.json");
      `("src/runtime/nested-arrow-wrapper-path.ts", [
        { kind: "legacy store filesystem write", line: 7 },
      ]),
      "flags legacy paths forwarded through nested object helper methods": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          const writer = {
            inner(nextPath: string) {
              return fs.writeFile(nextPath, "{}\\n");
            },
          };
          return writer.inner(filePath);
        }
        await persist("sessions.json");
      `("src/runtime/nested-object-wrapper-path.ts", [
        { kind: "legacy store filesystem write", line: 11 },
      ]),
      "flags legacy paths forwarded through nested helper aliases": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          function inner(nextPath: string) {
            return fs.writeFile(nextPath, "{}\\n");
          }
          const save = inner;
          return save(filePath);
        }
        await persist("sessions.json");
      `("src/runtime/nested-wrapper-alias-path.ts", [
        { kind: "legacy store filesystem write", line: 10 },
      ]),
      "flags legacy paths forwarded through assignment-defined nested helper aliases": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          function inner() {
            let save: () => Promise<void>;
            save = () => fs.writeFile(filePath, "{}\\n");
            return save();
          }
          return inner();
        }
        await persist("sessions.json");
      `("src/runtime/nested-wrapper-assigned-alias-closed-over-path.ts", [
        { kind: "legacy store filesystem write", line: 11 },
      ]),
      "flags enclosing helper assignments made inside nested helpers": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          let save;
          function configure() {
            save = () => fs.writeFile(filePath, "{}\\n");
          }
          configure();
          return save?.();
        }
        await persist("sessions.json");
      `("src/runtime/nested-wrapper-enclosing-assigned-helper.ts", [
        { kind: "legacy store filesystem write", line: 11 },
      ]),
      "flags legacy paths forwarded through extracted nested object helper methods": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          const writer = {
            inner(nextPath: string) {
              return fs.writeFile(nextPath, "{}\\n");
            },
          };
          const save = writer.inner;
          return save(filePath);
        }
        await persist("sessions.json");
      `("src/runtime/nested-object-wrapper-alias-path.ts", [
        { kind: "legacy store filesystem write", line: 12 },
      ]),
      "flags legacy paths forwarded through assignment-defined nested object helpers": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          function inner() {
            const writer: { save?: () => Promise<void> } = {};
            writer.save = () => fs.writeFile(filePath, "{}\\n");
            return writer.save?.();
          }
          return inner();
        }
        await persist("sessions.json");
      `("src/runtime/nested-object-wrapper-assigned-alias-closed-over-path.ts", [
        { kind: "legacy store filesystem write", line: 11 },
      ]),
      "merges closed-over var nested wrapper declarations inside exhaustive branches": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string, enabled: boolean) {
          function inner() {
            if (enabled) {
              var save = () => fs.writeFile(filePath, "{}\\n");
            } else {
              var save = async () => {};
            }
            return save();
          }
          return inner();
        }
        await persist("sessions.json", true);
      `("src/runtime/nested-wrapper-var-branch-declaration-closed-over-path.ts", [
        { kind: "legacy store filesystem write", line: 14 },
      ]),
      "merges closed-over var fs aliases declared inside optional branches": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string, enabled: boolean) {
          function inner() {
            if (enabled) {
              var write = fs.writeFile;
            }
            return write(filePath, "{}\\n");
          }
          return inner();
        }
        await persist("sessions.json", true);
      `("src/runtime/nested-wrapper-var-fs-alias-branch-closed-over-path.ts", [
        { kind: "legacy store filesystem write", line: 12 },
      ]),
      "flags enclosing object helper assignments made inside nested helpers": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          const writer: { save?: () => Promise<void> } = {};
          function configure() {
            writer.save = () => fs.writeFile(filePath, "{}\\n");
          }
          function inner() {
            configure();
            return writer.save?.();
          }
          return inner();
        }
        await persist("sessions.json");
      `("src/runtime/nested-object-wrapper-enclosing-assigned-helper.ts", [
        { kind: "legacy store filesystem write", line: 14 },
      ]),
      "flags legacy paths forwarded through local nested object helper aliases": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          function inner() {
            const writer = {
              save() {
                return fs.writeFile(filePath, "{}\\n");
              },
            };
            const save = writer.save;
            return save();
          }
          return inner();
        }
        await persist("sessions.json");
      `("src/runtime/nested-object-wrapper-local-method-alias-closed-over-path.ts", [
        { kind: "legacy store filesystem write", line: 15 },
      ]),
      "flags closed-over nested object helper methods copied through destructuring aliases":
        sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          function inner() {
            const writer = {
              nested: {
                save() {
                  return fs.writeFile(filePath, "{}\\n");
                },
              },
            };
            const { nested } = writer;
            return nested.save();
          }
          return inner();
        }
        await persist("sessions.json");
      `("src/runtime/nested-object-wrapper-destructured-alias-closed-over-path.ts", [
          { kind: "legacy store filesystem write", line: 17 },
        ]),
      "clears closed-over nested object helpers after exhaustive reassignment": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string, enabled: boolean) {
          function inner() {
            let writer = {
              save() {
                return fs.writeFile(filePath, "{}\\n");
              },
            };
            if (enabled) {
              writer = {};
            } else {
              writer = {};
            }
            return writer.save?.();
          }
          return inner();
        }
        await persist("sessions.json", true);
      `("src/runtime/nested-object-wrapper-exhaustive-reassigned-safe.ts", []),
      "keeps closed-over nested helpers after optional branch assignment": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string, enabled: boolean) {
          function inner() {
            let save;
            if (enabled) {
              save = () => fs.writeFile(filePath, "{}\\n");
            }
            return save?.();
          }
          return inner();
        }
        await persist("sessions.json", true);
      `("src/runtime/nested-wrapper-optional-branch-assigned-helper.ts", [
        { kind: "legacy store filesystem write", line: 13 },
      ]),
      "keeps closed-over nested helpers after loop assignment": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string, values: string[]) {
          function inner() {
            let save;
            for (const value of values) {
              save = () => fs.writeFile(filePath, value);
            }
            return save?.();
          }
          return inner();
        }
        await persist("sessions.json", ["{}\\n"]);
      `("src/runtime/nested-wrapper-loop-assigned-helper.ts", [
        { kind: "legacy store filesystem write", line: 13 },
      ]),
      "keeps closed-over nested helpers after optional while reassignment": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string, disabled: boolean) {
          function inner() {
            let save = () => fs.writeFile(filePath, "{}\\n");
            while (disabled) {
              save = async () => {};
            }
            return save();
          }
          return inner();
        }
        await persist("sessions.json", false);
      `("src/runtime/nested-wrapper-while-reassigned-helper.ts", [
        { kind: "legacy store filesystem write", line: 13 },
      ]),
      "keeps switch case closed-over nested helper shadows scoped": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string, mode: string) {
          function inner() {
            const save = () => fs.writeFile(filePath, "{}\\n");
            switch (mode) {
              case "off":
                const save = async () => {};
                break;
            }
            return save();
          }
          return inner();
        }
        await persist("sessions.json", "on");
      `("src/runtime/nested-wrapper-switch-case-shadow.ts", [
        { kind: "legacy store filesystem write", line: 15 },
      ]),
      "flags nested helper declarations inside switch cases": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string, mode: string) {
          switch (mode) {
            case "legacy":
              function inner(nextPath: string) {
                return fs.writeFile(nextPath, "{}\\n");
              }
              return inner(filePath);
          }
        }
        await persist("sessions.json", "legacy");
      `("src/runtime/nested-wrapper-switch-case-helper.ts", [
        { kind: "legacy store filesystem write", line: 12 },
      ]),
      "keeps closed-over nested helpers after try assignment": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          function inner() {
            let save;
            try {
              save = () => fs.writeFile(filePath, "{}\\n");
            } catch {}
            return save?.();
          }
          return inner();
        }
        await persist("sessions.json");
      `("src/runtime/nested-wrapper-try-assigned-helper.ts", [
        { kind: "legacy store filesystem write", line: 13 },
      ]),
      "flags closed-over nested helper aliases to outer wrappers": sourceCase`
        import { promises as fs } from "node:fs";
        function writePath(path: string) {
          return fs.writeFile(path, "{}\\n");
        }
        function persist(filePath: string) {
          function inner() {
            const save = writePath;
            return save(filePath);
          }
          return inner();
        }
        await persist("sessions.json");
      `("src/runtime/nested-wrapper-outer-wrapper-alias.ts", [
        { kind: "legacy store filesystem write", line: 13 },
      ]),
      "flags closed-over nested helper parameter default writes": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          function inner(_ = fs.writeFile(filePath, "{}\\n")) {
            return _;
          }
          return inner();
        }
        await persist("sessions.json");
      `("src/runtime/nested-wrapper-parameter-default-write.ts", [
        { kind: "legacy store filesystem write", line: 9 },
      ]),
      "does not use outer write aliases shadowed later in closed-over helpers": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          const write = fs.writeFile;
          function inner() {
            write(filePath, "{}\\n");
            const write = async () => {};
            return write;
          }
          return inner();
        }
        await persist("sessions.json");
      `("src/runtime/nested-wrapper-later-write-alias-shadow.ts", []),
      "flags closed-over aliases to top-level wrappers with local metadata": sourceCase`
        import { promises as fs } from "node:fs";
        function writePath(path: string) {
          let writer = {};
          writer.save = () => fs.writeFile(path, "{}\\n");
          return writer.save();
        }
        function persist(filePath: string) {
          function inner() {
            const save = writePath;
            return save(filePath);
          }
          return inner();
        }
        await persist("sessions.json");
      `("src/runtime/nested-wrapper-top-level-wrapper-alias.ts", [
        { kind: "legacy store filesystem write", line: 15 },
      ]),
      "flags closed-over aliases to top-level wrappers with module object metadata": sourceCase`
        import { promises as fs } from "node:fs";
        const writer = {};
        function writePath(path: string) {
          writer.save = () => fs.writeFile(path, "{}\\n");
          return writer.save();
        }
        function persist(filePath: string) {
          function inner() {
            const save = writePath;
            return save(filePath);
          }
          return inner();
        }
        await persist("sessions.json");
      `("src/runtime/nested-wrapper-top-level-object-wrapper-alias.ts", [
        { kind: "legacy store filesystem write", line: 15 },
      ]),
      "flags legacy paths forwarded through destructured local nested object helpers": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          function inner() {
            const writer = {
              save() {
                return fs.writeFile(filePath, "{}\\n");
              },
            };
            const { save } = writer;
            return save();
          }
          return inner();
        }
        await persist("sessions.json");
      `("src/runtime/nested-object-wrapper-local-method-destructure-closed-over-path.ts", [
        { kind: "legacy store filesystem write", line: 15 },
      ]),
      "flags legacy paths forwarded through destructured nested object helper methods": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          const writer = {
            inner(nextPath: string) {
              return fs.writeFile(nextPath, "{}\\n");
            },
          };
          const { inner } = writer;
          return inner(filePath);
        }
        await persist("sessions.json");
      `("src/runtime/nested-object-wrapper-destructure-path.ts", [
        { kind: "legacy store filesystem write", line: 12 },
      ]),
      "flags legacy paths forwarded through renamed nested object helper methods": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          const writer = {
            inner(nextPath: string) {
              return fs.writeFile(nextPath, "{}\\n");
            },
          };
          const { inner: save } = writer;
          return save(filePath);
        }
        await persist("sessions.json");
      `("src/runtime/nested-object-wrapper-renamed-destructure-path.ts", [
        { kind: "legacy store filesystem write", line: 12 },
      ]),
      "keeps nested wrapper assignments inside optional branches": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string, useJson: boolean) {
          let inner: (nextPath: string) => Promise<void>;
          if (useJson) {
            inner = (nextPath: string) => fs.writeFile(nextPath, "{}\\n");
          }
          return inner(filePath);
        }
        await persist("sessions.json", true);
      `("src/runtime/nested-wrapper-optional-branch-assignment.ts", [
        { kind: "legacy store filesystem write", line: 10 },
      ]),
      "keeps previous nested wrappers after optional safe reassignment": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string, disabled: boolean) {
          let inner = (nextPath: string) => fs.writeFile(nextPath, "{}\\n");
          if (disabled) {
            inner = async () => {};
          }
          return inner(filePath);
        }
        await persist("sessions.json", false);
      `("src/runtime/nested-wrapper-optional-safe-reassignment.ts", [
        { kind: "legacy store filesystem write", line: 10 },
      ]),
      "keeps nested object wrapper assignments inside optional branches": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string, useJson: boolean) {
          const writer: { inner?: (nextPath: string) => Promise<void> } = {};
          if (useJson) {
            writer.inner = (nextPath: string) => fs.writeFile(nextPath, "{}\\n");
          }
          return writer.inner?.(filePath);
        }
        await persist("sessions.json", true);
      `("src/runtime/nested-object-wrapper-optional-branch-assignment.ts", [
        { kind: "legacy store filesystem write", line: 10 },
      ]),
      "keeps nested object wrapper methods from optional whole-object assignments": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string, useJson: boolean) {
          let writer: { inner?: (nextPath: string) => Promise<void> } = {};
          if (useJson) {
            writer = {
              inner(nextPath: string) {
                return fs.writeFile(nextPath, "{}\\n");
              },
            };
          }
          return writer.inner?.(filePath);
        }
        await persist("sessions.json", true);
      `("src/runtime/nested-object-wrapper-optional-object-assignment.ts", [
        { kind: "legacy store filesystem write", line: 14 },
      ]),
      "flags legacy paths after exhaustive nested wrapper assignments": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string, useJson: boolean) {
          let inner: (nextPath: string) => Promise<void>;
          if (useJson) {
            inner = (nextPath: string) => fs.writeFile(nextPath, "{}\\n");
          } else {
            inner = (nextPath: string) => fs.writeFile(nextPath, "[]\\n");
          }
          return inner(filePath);
        }
        await persist("sessions.json", true);
      `("src/runtime/nested-wrapper-branch-assignment.ts", [
        { kind: "legacy store filesystem write", line: 12 },
      ]),
      "flags legacy paths after nested wrapper assignments inside plain blocks": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          let inner: (nextPath: string) => Promise<void>;
          {
            inner = (nextPath: string) => fs.writeFile(nextPath, "{}\\n");
          }
          return inner(filePath);
        }
        await persist("sessions.json");
      `("src/runtime/nested-wrapper-block-assignment.ts", [
        { kind: "legacy store filesystem write", line: 10 },
      ]),
      "keeps exhaustive nested wrapper assignments inside plain blocks": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string, useJson: boolean) {
          let inner: (nextPath: string) => Promise<void>;
          {
            if (useJson) {
              inner = (nextPath: string) => fs.writeFile(nextPath, "{}\\n");
            } else {
              inner = (nextPath: string) => fs.writeFile(nextPath, "[]\\n");
            }
          }
          return inner(filePath);
        }
        await persist("sessions.json", true);
      `("src/runtime/nested-wrapper-block-branch-assignment.ts", [
        { kind: "legacy store filesystem write", line: 14 },
      ]),
      "does not leak branch-local nested wrapper shadows after exhaustive branches": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string, useJson: boolean) {
          let inner = (_nextPath: string) => Promise.resolve();
          if (useJson) {
            {
              let inner: (nextPath: string) => Promise<void>;
              inner = (nextPath: string) => fs.writeFile(nextPath, "{}\\n");
            }
          } else {
            {
              let inner: (nextPath: string) => Promise<void>;
              inner = (nextPath: string) => fs.writeFile(nextPath, "[]\\n");
            }
          }
          return inner(filePath);
        }
        await persist("sessions.json", true);
      `("src/runtime/nested-wrapper-branch-local-shadow.ts", []),
      "refreshes block-local aliases for nested wrappers assigned to outer bindings": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          let inner: (nextPath: string) => Promise<void>;
          {
            inner = (nextPath: string) => write(nextPath, "{}\\n");
            const write = fs.writeFile;
          }
          return inner(filePath);
        }
        await persist("sessions.json");
      `("src/runtime/nested-wrapper-block-local-late-alias.ts", [
        { kind: "legacy store filesystem write", line: 11 },
      ]),
      "keeps escaped nested wrapper aliases isolated from sibling blocks": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          let inner: (nextPath: string) => Promise<void>;
          {
            const write = fs.writeFile;
            inner = (nextPath: string) => write(nextPath, "{}\\n");
          }
          {
            const write = async () => {};
          }
          return inner(filePath);
        }
        await persist("sessions.json");
      `("src/runtime/nested-wrapper-sibling-block-alias-shadow.ts", [
        { kind: "legacy store filesystem write", line: 14 },
      ]),
      "refreshes merged nested wrapper assignments after later aliases": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string, useJson: boolean) {
          let inner: (nextPath: string) => Promise<void>;
          if (useJson) {
            inner = (nextPath: string) => write(nextPath, "{}\\n");
          } else {
            inner = (nextPath: string) => write(nextPath, "[]\\n");
          }
          const write = fs.writeFile;
          return inner(filePath);
        }
        await persist("sessions.json", true);
      `("src/runtime/nested-wrapper-branch-late-alias.ts", [
        { kind: "legacy store filesystem write", line: 13 },
      ]),
      "refreshes branch-local aliases before merging nested wrapper assignments": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string, useJson: boolean) {
          let inner: (nextPath: string) => Promise<void>;
          if (useJson) {
            inner = (nextPath: string) => write(nextPath, "{}\\n");
            const write = fs.writeFile;
          } else {
            inner = (nextPath: string) => write(nextPath, "[]\\n");
            const write = fs.writeFile;
          }
          return inner(filePath);
        }
        await persist("sessions.json", true);
      `("src/runtime/nested-wrapper-branch-local-late-alias.ts", [
        { kind: "legacy store filesystem write", line: 14 },
      ]),
      "flags legacy paths after exhaustive nested object wrapper assignments": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string, useJson: boolean) {
          let writer: { inner(nextPath: string): Promise<void> };
          if (useJson) {
            writer = {
              inner(nextPath: string) {
                return fs.writeFile(nextPath, "{}\\n");
              },
            };
          } else {
            writer = {
              inner(nextPath: string) {
                return fs.writeFile(nextPath, "[]\\n");
              },
            };
          }
          return writer.inner(filePath);
        }
        await persist("sessions.json", true);
      `("src/runtime/nested-object-wrapper-branch-assignment.ts", [
        { kind: "legacy store filesystem write", line: 20 },
      ]),
      "clears stale nested object wrapper methods after exhaustive object reassignment": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string, useJson: boolean) {
          let writer = {
            inner(nextPath: string) {
              return fs.writeFile(nextPath, "{}\\n");
            },
          };
          if (useJson) {
            writer = {};
          } else {
            writer = {};
          }
          return writer.inner?.(filePath);
        }
        await persist("sessions.json", true);
      `("src/runtime/nested-object-wrapper-exhaustive-object-reassignment.ts", []),
      "flags legacy paths after exhaustive nested object wrapper parameter assignments": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(
          filePath: string,
          writer: { inner?: (nextPath: string) => Promise<void> },
          useJson: boolean,
        ) {
          if (useJson) {
            writer.inner = (nextPath: string) => fs.writeFile(nextPath, "{}\\n");
          } else {
            writer.inner = (nextPath: string) => fs.writeFile(nextPath, "[]\\n");
          }
          return writer.inner?.(filePath);
        }
        await persist("sessions.json", {}, true);
      `("src/runtime/nested-object-wrapper-parameter-branch-assignment.ts", [
        { kind: "legacy store filesystem write", line: 15 },
      ]),
      "keeps block-local nested wrapper shadows scoped to their block": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          function inner(nextPath: string) {
            return fs.writeFile(nextPath, "{}\\n");
          }
          {
            function inner(_: string) {}
          }
          return inner(filePath);
        }
        await persist("sessions.json");
      `("src/runtime/nested-wrapper-block-shadow.ts", [
        { kind: "legacy store filesystem write", line: 12 },
      ]),
      "does not use outer nested wrappers for destructured parameter shadows": sourceCase`
        import { promises as fs } from "node:fs";
        function helper(nextPath: string) {
          return fs.writeFile(nextPath, "{}\\n");
        }
        function persist({ helper }: { helper: (nextPath: string) => Promise<void> }, filePath: string) {
          return helper(filePath);
        }
        await persist({ helper: async () => {} }, "sessions.json");
      `("src/runtime/nested-wrapper-destructured-parameter-shadow.ts", []),
      "uses enclosing aliases when nested wrapper helpers are called": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          const write = fs.writeFile;
          function inner(nextPath: string) {
            return write(nextPath, "{}\\n");
          }
          return inner(filePath);
        }
        await persist("sessions.json");
      `("src/runtime/nested-wrapper-alias.ts", [
        { kind: "legacy store filesystem write", line: 10 },
      ]),
      "does not use caller block shadows for nested wrapper helper aliases": sourceCase`
        import { createRequire } from "node:module";
        const req = createRequire(import.meta.url);
        function persist(filePath: string, customRequire: NodeRequire) {
          function inner(nextPath: string) {
            const fs = req("node:fs");
            return fs.writeFileSync(nextPath, "{}\\n");
          }
          {
            const req = customRequire;
            return inner(filePath);
          }
        }
        await persist("sessions.json", require);
      `("src/runtime/nested-wrapper-call-shadow.ts", [
        { kind: "legacy store filesystem write", line: 14 },
      ]),
    }),
  )("$name", ({ source, filename, expected }) => {
    const violations = collectDatabaseFirstLegacyStoreViolations(source, filename);

    expect(violations).toEqual(expected);
  });

  // Wrapper parameter and body alias state.
  it.each(
    namedCases({
      "flags wrapper object binding defaults for explicit undefined forwarded properties":
        sourceCase`
        import { promises as fs } from "node:fs";
        function inner({ path }: { path: string }) {
          return fs.writeFile(path, "{}\\n");
        }
        function persist(filePath: string) {
          function forward({ path = filePath } = {}) {
            return inner({ path });
          }
          return forward({ path: undefined });
        }
        await persist("sessions.json");
      `("src/runtime/wrapper-forwarded-undefined-object-property-default.ts", [
          { kind: "legacy store filesystem write", line: 12 },
        ]),
      "flags legacy paths from defaulted wrapper parameters": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        function persistPath(filePath = "sessions.json") {
          return writeTextAtomic(filePath, "{}\\n");
        }
        function persistOptions(options: { filePath?: string } = { filePath: "cron/jobs.json" }) {
          return writeTextAtomic(options.filePath ?? currentSqlitePath, "{}\\n");
        }
        function persistDestructured({ filePath = "cron/runs/job.jsonl" }: { filePath?: string } = {}) {
          return writeTextAtomic(filePath, "{}\\n");
        }
        persistPath();
        persistPath(undefined);
        persistOptions();
        persistDestructured({});
        persistDestructured({ filePath: undefined });
        persistDestructured({ filePath: currentSqlitePath });
      `("src/runtime/defaulted-wrapper-paths.ts", [
        { kind: "legacy store filesystem write", line: 12 },
        { kind: "legacy store filesystem write", line: 13 },
        { kind: "legacy store filesystem write", line: 14 },
        { kind: "legacy store filesystem write", line: 15 },
        { kind: "legacy store filesystem write", line: 16 },
      ]),
      "does not treat ambient declarations as undefined wrapper arguments": sourceCase`
        import fs from "node:fs/promises";
        declare const provided: string;
        function persist(filePath = "sessions.json") {
          return fs.writeFile(filePath, "{}\\n");
        }
        await persist(provided);
      `("src/runtime/ambient-defaulted-wrapper-path.ts", []),
      "clears wrapper object parameter paths after reassignment": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }) {
          params = { filePath: currentSqlitePath };
          return writeTextAtomic(params.filePath, "{}\\n");
        }
        await persist({ filePath: "sessions.json" });
      `("src/runtime/reassigned-wrapper-object-options.ts", []),
      "clears wrapper object parameter paths after nested block reassignment": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }) {
          {
            params = { filePath: currentSqlitePath };
          }
          return writeTextAtomic(params.filePath, "{}\\n");
        }
        await persist({ filePath: "sessions.json" });
      `("src/runtime/nested-reassigned-wrapper-object-options.ts", []),
      "does not let block-local wrapper parameter shadows clear outer paths": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }) {
          {
            const params = { filePath: currentSqlitePath };
            await use(params);
          }
          return writeTextAtomic(params.filePath, "{}\\n");
        }
        await persist({ filePath: "sessions.json" });
      `("src/runtime/block-local-wrapper-object-options-shadow.ts", [
        { kind: "legacy store filesystem write", line: 10 },
      ]),
      "clears destructured wrapper option paths after reassignment": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist({ filePath }: { filePath: string }) {
          filePath = currentSqlitePath;
          return writeTextAtomic(filePath, "{}\\n");
        }
        await persist({ filePath: "sessions.json" });
      `("src/runtime/reassigned-destructured-wrapper-options.ts", []),
      "clears wrapper object property paths after reassignment": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }) {
          params.filePath = currentSqlitePath;
          return writeTextAtomic(params.filePath, "{}\\n");
        }
        await persist({ filePath: "sessions.json" });
      `("src/runtime/reassigned-wrapper-property-options.ts", []),
      "clears nested wrapper object property paths after reassignment": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(params: { paths: { filePath: string } }) {
          params.paths.filePath = currentSqlitePath;
          return fs.writeFile(params.paths.filePath, "{}\\n");
        }
        await persist({ paths: { filePath: "sessions.json" } });
      `("src/runtime/reassigned-nested-wrapper-property-options.ts", []),
      "updates wrapper object property paths after reassignment from another parameter": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }, legacy: { filePath: string }) {
          params.filePath = legacy.filePath;
          return writeTextAtomic(params.filePath, "{}\\n");
        }
        await persist({ filePath: currentSqlitePath }, { filePath: "sessions.json" });
      `("src/runtime/reassigned-wrapper-property-from-parameter.ts", [
        { kind: "legacy store filesystem write", line: 7 },
      ]),
      "keeps wrapper object property paths after conditional reassignment": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }) {
          if (ready) params.filePath = currentSqlitePath;
          return writeTextAtomic(params.filePath, "{}\\n");
        }
        await persist({ filePath: "sessions.json" });
      `("src/runtime/conditional-reassigned-wrapper-property-options.ts", [
        { kind: "legacy store filesystem write", line: 7 },
      ]),
      "keeps wrapper object parameter paths after conditional reassignment": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }) {
          if (ready) params = { filePath: currentSqlitePath };
          return writeTextAtomic(params.filePath, "{}\\n");
        }
        await persist({ filePath: "sessions.json" });
      `("src/runtime/conditional-reassigned-wrapper-object-options.ts", [
        { kind: "legacy store filesystem write", line: 7 },
      ]),
      "keeps wrapper object property paths after for-of reassignment": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }) {
          for (const item of items) {
            params.filePath = currentSqlitePath;
          }
          return writeTextAtomic(params.filePath, "{}\\n");
        }
        await persist({ filePath: "sessions.json" });
      `("src/runtime/for-of-reassigned-wrapper-property-options.ts", [
        { kind: "legacy store filesystem write", line: 9 },
      ]),
      "keeps wrapper object property paths after try-block reassignment": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }) {
          try {
            maybeThrow();
            params.filePath = currentSqlitePath;
          } catch {}
          return writeTextAtomic(params.filePath, "{}\\n");
        }
        await persist({ filePath: "sessions.json" });
      `("src/runtime/try-reassigned-wrapper-property-options.ts", [
        { kind: "legacy store filesystem write", line: 10 },
      ]),
      "clears wrapper object property paths after exhaustive current-path assignments": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }) {
          if (ready) params.filePath = currentSqlitePath;
          else params.filePath = currentSqlitePath;
          return writeTextAtomic(params.filePath, "{}\\n");
        }
        await persist({ filePath: "sessions.json" });
      `("src/runtime/exhaustive-current-wrapper-property-options.ts", []),
      "clears wrapper object parameter paths after exhaustive current-object assignments":
        sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }) {
          if (ready) params = { filePath: currentSqlitePath };
          else params = { filePath: currentSqlitePath };
          return writeTextAtomic(params.filePath, "{}\\n");
        }
        await persist({ filePath: "sessions.json" });
      `("src/runtime/exhaustive-current-wrapper-object-options.ts", []),
      "flags wrapper object property paths after mixed exhaustive assignments": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }, legacy: { filePath: string }) {
          if (ready) params.filePath = currentSqlitePath;
          else params.filePath = legacy.filePath;
          return writeTextAtomic(params.filePath, "{}\\n");
        }
        await persist({ filePath: currentSqlitePath }, { filePath: "sessions.json" });
      `("src/runtime/exhaustive-mixed-wrapper-property-options.ts", [
        { kind: "legacy store filesystem write", line: 8 },
      ]),
      "flags wrapper object property paths after conditional reassignment from another parameter":
        sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }, legacy: { filePath: string }) {
          if (ready) params.filePath = legacy.filePath;
          return writeTextAtomic(params.filePath, "{}\\n");
        }
        await persist({ filePath: currentSqlitePath }, { filePath: "sessions.json" });
      `("src/runtime/conditional-reassigned-wrapper-property-from-parameter.ts", [
          { kind: "legacy store filesystem write", line: 7 },
        ]),
      "flags wrapper object paths after conditional reassignment from another parameter":
        sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }, legacy: { filePath: string }) {
          if (ready) params = legacy;
          return writeTextAtomic(params.filePath, "{}\\n");
        }
        await persist({ filePath: currentSqlitePath }, { filePath: "sessions.json" });
      `("src/runtime/conditional-reassigned-wrapper-object-from-parameter.ts", [
          { kind: "legacy store filesystem write", line: 7 },
        ]),
      "flags destructured wrapper paths after conditional reassignment from another parameter":
        sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist({ filePath }: { filePath: string }, legacy: { filePath: string }) {
          if (ready) filePath = legacy.filePath;
          return writeTextAtomic(filePath, "{}\\n");
        }
        await persist({ filePath: currentSqlitePath }, { filePath: "sessions.json" });
      `("src/runtime/conditional-reassigned-destructured-wrapper-options.ts", [
          { kind: "legacy store filesystem write", line: 7 },
        ]),
      "flags legacy paths passed through locally destructured wrapper options": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }) {
          const { filePath } = params;
          return writeTextAtomic(filePath, "{}\\n");
        }
        await persist({ filePath: "sessions.json" });
      `("src/runtime/local-destructured-wrapper-options.ts", [
        { kind: "legacy store filesystem write", line: 7 },
      ]),
      "flags legacy paths passed through local wrapper property aliases": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }) {
          const filePath = params.filePath;
          return writeTextAtomic(filePath, "{}\\n");
        }
        await persist({ filePath: "sessions.json" });
      `("src/runtime/local-property-alias-wrapper-options.ts", [
        { kind: "legacy store filesystem write", line: 7 },
      ]),
      "flags legacy paths passed through local wrapper object aliases": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }) {
          const target = params;
          return writeTextAtomic(target.filePath, "{}\\n");
        }
        await persist({ filePath: "sessions.json" });
      `("src/runtime/local-object-alias-wrapper-options.ts", [
        { kind: "legacy store filesystem write", line: 7 },
      ]),
      "flags wrapper object paths after reassignment from another parameter": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }, legacy: { filePath: string }) {
          params = legacy;
          return writeTextAtomic(params.filePath, "{}\\n");
        }
        await persist({ filePath: currentSqlitePath }, { filePath: "sessions.json" });
      `("src/runtime/reassigned-wrapper-object-from-parameter.ts", [
        { kind: "legacy store filesystem write", line: 7 },
      ]),
      "flags wrapper object property paths after nested block reassignment from another parameter":
        sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }, legacy: { filePath: string }) {
          {
            params.filePath = legacy.filePath;
          }
          return writeTextAtomic(params.filePath, "{}\\n");
        }
        await persist({ filePath: currentSqlitePath }, { filePath: "sessions.json" });
      `("src/runtime/nested-block-reassigned-wrapper-property.ts", [
          { kind: "legacy store filesystem write", line: 9 },
        ]),
      "flags wrapper destructured paths after nested block reassignment from another parameter":
        sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist({ filePath }: { filePath: string }, legacy: { filePath: string }) {
          {
            filePath = legacy.filePath;
          }
          return writeTextAtomic(filePath, "{}\\n");
        }
        await persist({ filePath: currentSqlitePath }, { filePath: "sessions.json" });
      `("src/runtime/nested-block-reassigned-wrapper-destructured.ts", [
          { kind: "legacy store filesystem write", line: 9 },
        ]),
      "does not leak block-local wrapper path aliases into the parent block": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }) {
          const filePath = currentSqlitePath;
          {
            const filePath = params.filePath;
          }
          return writeTextAtomic(filePath, "{}\\n");
        }
        await persist({ filePath: "sessions.json" });
      `("src/runtime/block-local-wrapper-path-alias.ts", []),
      "flags wrapper option paths written through body-local fs aliases": sourceCase`
        import fs from "node:fs/promises";
        function persist(params: { filePath: string }) {
          const { writeFile } = fs;
          return writeFile(params.filePath, "{}\\n");
        }
        await persist({ filePath: "sessions.json" });
      `("src/runtime/body-local-fs-alias-wrapper.ts", [
        { kind: "legacy store filesystem write", line: 7 },
      ]),
      "flags wrapper option paths written through body-local fs method aliases": sourceCase`
        import fs from "node:fs/promises";
        function persist(params: { filePath: string }) {
          const save = fs.writeFile;
          return save(params.filePath, "{}\\n");
        }
        await persist({ filePath: "sessions.json" });
      `("src/runtime/wrapper-body-local-fs-method-alias.ts", [
        { kind: "legacy store filesystem write", line: 7 },
      ]),
      "flags wrapper option paths written through branch-assigned body-local fs aliases":
        sourceCase`
        import fs from "node:fs/promises";
        function persist(params: { filePath: string }, ready: boolean) {
          let write;
          if (ready) {
            write = fs.writeFile;
          } else {
            write = fs.writeFile;
          }
          return write(params.filePath, "{}\\n");
        }
        await persist({ filePath: "sessions.json" }, true);
      `("src/runtime/branch-assigned-body-local-fs-alias-wrapper.ts", [
          { kind: "legacy store filesystem write", line: 12 },
        ]),
      "flags nested wrapper helpers capturing branch-assigned body-local fs aliases": sourceCase`
        import fs from "node:fs/promises";
        function persist(params: { filePath: string }, ready: boolean) {
          let write;
          if (ready) {
            write = fs.writeFile;
          } else {
            write = fs.writeFile;
          }
          function inner() {
            return write(params.filePath, "{}\\n");
          }
          return inner();
        }
        await persist({ filePath: "sessions.json" }, true);
      `("src/runtime/nested-wrapper-branch-assigned-body-local-fs-alias.ts", [
        { kind: "legacy store filesystem write", line: 15 },
      ]),
      "flags wrapper option paths written through body-local fs object aliases": sourceCase`
        import fs from "node:fs/promises";
        function persist(params: { filePath: string }) {
          const writer = { writeFile: fs.writeFile };
          return writer.writeFile(params.filePath, "{}\\n");
        }
        await persist({ filePath: "sessions.json" });
      `("src/runtime/body-local-fs-object-alias-wrapper.ts", [
        { kind: "legacy store filesystem write", line: 7 },
      ]),
      "flags wrapper option paths written through bracketed body-local fs object aliases":
        sourceCase`
        import fs from "node:fs/promises";
        function persist(params: { filePath: string }) {
          const writer = { writeFile: fs.writeFile };
          return writer["writeFile"](params.filePath, "{}\\n");
        }
        await persist({ filePath: "sessions.json" });
      `("src/runtime/body-local-bracket-fs-object-alias-wrapper.ts", [
          { kind: "legacy store filesystem write", line: 7 },
        ]),
      "clears wrapper body fs object aliases after object reassignment": sourceCase`
        import fs from "node:fs/promises";
        function persist(params: { filePath: string }) {
          let writer = { writeFile: fs.writeFile };
          writer = customWriter;
          return writer.writeFile(params.filePath, "{}\\n");
        }
        await persist({ filePath: "sessions.json" });
      `("src/runtime/reassigned-body-local-fs-object-alias-wrapper.ts", []),
      "does not let block-local wrapper aliases mutate outer wrapper metadata": sourceCase`
        import fs from "node:fs/promises";
        import { writeFile } from "../infra/custom-writer.js";
        function persist(params: { filePath: string }) {
          return writeFile(params.filePath, "{}\\n");
        }
        {
          const save = persist;
          const { writeFile } = fs;
          await save({ filePath: "sessions.json" });
        }
        await persist({ filePath: "cron/jobs.json" });
      `("src/runtime/block-local-wrapper-alias-metadata.ts", []),
      "flags wrapper option paths written through fs.promises": sourceCase`
        import fs from "node:fs";
        function persist(params: { filePath: string }) {
          return fs.promises.writeFile(params.filePath, "{}\\n");
        }
        await persist({ filePath: "sessions.json" });
      `("src/runtime/wrapper-fs-promises-write.ts", [
        { kind: "legacy store filesystem write", line: 6 },
      ]),
      "flags wrapper option paths written through outer fs module object aliases": sourceCase`
        import fs from "node:fs/promises";
        const deps = { fs };
        function persist(params: { filePath: string }) {
          return deps.fs.writeFile(params.filePath, "{}\\n");
        }
        persist({ filePath: "sessions.json" });
      `("src/runtime/wrapper-outer-fs-module-object-alias.ts", [
        { kind: "legacy store filesystem write", line: 7 },
      ]),
      "flags wrapper option paths written through injected fs handles": sourceCase`
        function persist(deps: { fs: typeof import("node:fs") }, params: { filePath: string }) {
          return deps.fs.promises.writeFile(params.filePath, "{}\\n");
        }
        await persist(deps, { filePath: "sessions.json" });
      `("src/runtime/wrapper-injected-fs-write.ts", [
        { kind: "legacy store filesystem write", line: 5 },
      ]),
      "does not treat untyped wrapper fs properties as filesystem writes": sourceCase`
        function persist(deps: { fs: { promises: { writeFile: Function } } }, params: { filePath: string }) {
          return deps.fs.promises.writeFile(params.filePath, "{}\\n");
        }
        await persist(deps, { filePath: "sessions.json" });
      `("src/runtime/wrapper-custom-fs-property.ts", []),
      "flags wrapper option paths written through CommonJS fs": sourceCase`
        function persist(params: { filePath: string }) {
          const fs = require("node:fs");
          return fs.promises.writeFile(params.filePath, "{}\\n");
        }
        await persist({ filePath: "sessions.json" });
      `("src/runtime/wrapper-commonjs-fs-write.ts", [
        { kind: "legacy store filesystem write", line: 6 },
      ]),
      "flags wrapper options forwarded to filePath helper objects": sourceCase`
        import { appendRegularFile, replaceFileAtomic } from "../infra/fs-safe.js";
        function append(options: { filePath: string; content: string }) {
          return appendRegularFile(options);
        }
        function replace(options: { filePath: string; content: string }) {
          return replaceFileAtomic(options);
        }
        append({ filePath: "sessions.json", content: "{}\\n" });
        replace({ filePath: "plugin-state/state.sqlite", content: "" });
      `("src/runtime/forwarded-filepath-helper-options.ts", [
        { kind: "legacy store filesystem write", line: 9 },
        { kind: "legacy store filesystem write", line: 10 },
      ]),
      "flags wrapper options forwarded through another wrapper": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }) {
          return writeTextAtomic(params.filePath, "{}\\n");
        }
        function save(params: { filePath: string }) {
          return persist(params);
        }
        save({ filePath: "sessions.json" });
      `("src/runtime/transitive-wrapper-forwarding.ts", [
        { kind: "legacy store filesystem write", line: 9 },
      ]),
      "flags wrapper options spread through another wrapper": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }) {
          return writeTextAtomic(params.filePath, "{}\\n");
        }
        function save(params: { filePath: string }) {
          return persist({ ...params });
        }
        save({ filePath: "sessions.json" });
      `("src/runtime/transitive-wrapper-spread-forwarding.ts", [
        { kind: "legacy store filesystem write", line: 9 },
      ]),
      "allows wrapper spread forwarding when a later property overrides the path": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }) {
          return writeTextAtomic(params.filePath, "{}\\n");
        }
        function save(params: { filePath: string }) {
          return persist({ ...params, filePath: currentSqlitePath });
        }
        save({ filePath: "sessions.json" });
      `("src/runtime/transitive-wrapper-spread-overridden-forwarding.ts", []),
      "flags wrapper spread forwarding when a later spread restores the path": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }) {
          return writeTextAtomic(params.filePath, "{}\\n");
        }
        function save(params: { filePath: string }) {
          return persist({ filePath: currentSqlitePath, ...params });
        }
        save({ filePath: "sessions.json" });
      `("src/runtime/transitive-wrapper-spread-restored-forwarding.ts", [
        { kind: "legacy store filesystem write", line: 9 },
      ]),
      "flags wrapper options renamed through another wrapper": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }) {
          return writeTextAtomic(params.filePath, "{}\\n");
        }
        function save(params: { storePath: string }) {
          return persist({ filePath: params.storePath });
        }
        save({ storePath: "sessions.json" });
      `("src/runtime/transitive-wrapper-renamed-forwarding.ts", [
        { kind: "legacy store filesystem write", line: 9 },
      ]),
      "flags hoisted wrappers that use write aliases declared later": sourceCase`
        import fs from "node:fs/promises";
        function persist(params: { filePath: string }) {
          return writeFile(params.filePath, "{}\\n");
        }
        const { writeFile } = fs;
        await persist({ filePath: "sessions.json" });
      `("src/runtime/late-alias-hoisted-wrapper.ts", [
        { kind: "legacy store filesystem write", line: 7 },
      ]),
      "flags hoisted wrappers that use renamed write aliases declared later": sourceCase`
        import fs from "node:fs/promises";
        function persist(params: { filePath: string }) {
          return write(params.filePath, "{}\\n");
        }
        const { writeFile: write } = fs;
        await persist({ filePath: "sessions.json" });
      `("src/runtime/late-renamed-alias-hoisted-wrapper.ts", [
        { kind: "legacy store filesystem write", line: 7 },
      ]),
      "flags reassigned wrapper variables": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        let persist;
        persist = (params: { filePath: string }) => writeTextAtomic(params.filePath, "{}\\n");
        persist({ filePath: "sessions.json" });
      `("src/runtime/reassigned-wrapper-variable.ts", [
        { kind: "legacy store filesystem write", line: 5 },
      ]),
      "flags aliased wrapper variables": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }) {
          return writeTextAtomic(params.filePath, "{}\\n");
        }
        const save = persist;
        save({ filePath: "sessions.json" });
      `("src/runtime/aliased-wrapper-variable.ts", [
        { kind: "legacy store filesystem write", line: 7 },
      ]),
      "does not treat aliased top-level helpers as closing over wrapper parameters": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        const filePath = "not-openclaw-state.txt";
        function helper() {
          return writeTextAtomic(filePath, "{}\\n");
        }
        function persist(filePath: string) {
          const inner = helper;
          return inner();
        }
        persist("sessions.json");
      `("src/runtime/aliased-top-level-wrapper-closed-over-module-var.ts", []),
    }),
  )("$name", ({ source, filename, expected }) => {
    const violations = collectDatabaseFirstLegacyStoreViolations(source, filename);

    expect(violations).toEqual(expected);
  });

  // Object-backed wrapper discovery and alias tracking.
  it.each(
    namedCases({
      "flags object method wrappers": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        const writer = {
          persist(params: { filePath: string }) {
            return writeTextAtomic(params.filePath, "{}\\n");
          },
        };
        writer.persist({ filePath: "sessions.json" });
      `("src/runtime/object-method-wrapper.ts", [
        { kind: "legacy store filesystem write", line: 8 },
      ]),
      "flags object property wrapper functions": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        const writer = {
          persist: (params: { filePath: string }) => writeTextAtomic(params.filePath, "{}\\n"),
        };
        writer["persist"]({ filePath: "sessions.json" });
      `("src/runtime/object-property-wrapper-function.ts", [
        { kind: "legacy store filesystem write", line: 6 },
      ]),
      "flags object wrapper shorthand aliases": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }) {
          return writeTextAtomic(params.filePath, "{}\\n");
        }
        const writer = { persist };
        await writer.persist({ filePath: "sessions.json" });
      `("src/runtime/object-wrapper-shorthand-alias.ts", [
        { kind: "legacy store filesystem write", line: 7 },
      ]),
      "flags object wrapper property aliases": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }) {
          return writeTextAtomic(params.filePath, "{}\\n");
        }
        const writer = { save: persist };
        await writer.save({ filePath: "sessions.json" });
      `("src/runtime/object-wrapper-property-alias.ts", [
        { kind: "legacy store filesystem write", line: 7 },
      ]),
      "flags object wrapper methods copied through property access aliases": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          const writer = {
            save(nextPath: string) {
              return fs.writeFile(nextPath, "{}\\n");
            },
          };
          const proxy = { save: writer.save };
          return proxy.save(filePath);
        }
        await persist("sessions.json");
      `("src/runtime/object-wrapper-property-access-alias.ts", [
        { kind: "legacy store filesystem write", line: 12 },
      ]),
      "flags object wrapper methods copied through whole-object aliases": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          const writer = {
            save(nextPath: string) {
              return fs.writeFile(nextPath, "{}\\n");
            },
          };
          const proxy = writer;
          return proxy.save(filePath);
        }
        await persist("sessions.json");
      `("src/runtime/object-wrapper-whole-object-alias.ts", [
        { kind: "legacy store filesystem write", line: 12 },
      ]),
      "flags nested object wrapper methods copied through property access aliases": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          const writer = {
            nested: {
              save(nextPath: string) {
                return fs.writeFile(nextPath, "{}\\n");
              },
            },
          };
          const nested = writer.nested;
          return nested.save(filePath);
        }
        await persist("sessions.json");
      `("src/runtime/nested-object-wrapper-property-access-alias.ts", [
        { kind: "legacy store filesystem write", line: 14 },
      ]),
      "flags destructured object wrapper methods from deep property paths": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          const holder = {
            inner: {
              writer: {
                save() {
                  return fs.writeFile(filePath, "{}\\n");
                },
              },
            },
          };
          const { save } = holder.inner.writer;
          return save();
        }
        await persist("sessions.json");
      `("src/runtime/deep-object-wrapper-destructured-method.ts", [
        { kind: "legacy store filesystem write", line: 16 },
      ]),
      "flags nested object wrapper methods copied through destructuring aliases": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          const writer = {
            nested: {
              save() {
                return fs.writeFile(filePath, "{}\\n");
              },
            },
          };
          const { nested } = writer;
          return nested.save();
        }
        await persist("sessions.json");
      `("src/runtime/nested-object-wrapper-destructured-alias.ts", [
        { kind: "legacy store filesystem write", line: 14 },
      ]),
      "flags nested object wrapper methods copied through identifier-valued properties": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          const nested = {
            save() {
              return fs.writeFile(filePath, "{}\\n");
            },
          };
          const writer = { nested };
          return writer.nested.save();
        }
        await persist("sessions.json");
      `("src/runtime/nested-object-wrapper-identifier-property-alias.ts", [
        { kind: "legacy store filesystem write", line: 12 },
      ]),
      "clears stale nested object wrapper methods after object literal overwrites": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          const writer = {
            nested: {
              save(nextPath: string) {
                return fs.writeFile(nextPath, "{}\\n");
              },
            },
            nested: {},
          };
          return writer.nested.save(filePath);
        }
        await persist("sessions.json");
      `("src/runtime/nested-object-wrapper-literal-overwrite.ts", []),
      "flags object wrapper methods copied through object spreads": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          const writer = {
            save(nextPath: string) {
              return fs.writeFile(nextPath, "{}\\n");
            },
          };
          const proxy = { ...writer };
          return proxy.save(filePath);
        }
        await persist("sessions.json");
      `("src/runtime/object-wrapper-object-spread-alias.ts", [
        { kind: "legacy store filesystem write", line: 12 },
      ]),
      "flags nested object wrapper methods": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          const writer = {
            nested: {
              save() {
                return fs.writeFile(filePath, "{}\\n");
              },
            },
          };
          return writer.nested.save();
        }
        await persist("sessions.json");
      `("src/runtime/nested-object-wrapper-method.ts", [
        { kind: "legacy store filesystem write", line: 13 },
      ]),
      "flags top-level nested object wrapper methods": sourceCase`
        import { promises as fs } from "node:fs";
        const writer = {
          nested: {
            save(filePath: string) {
              return fs.writeFile(filePath, "{}\\n");
            },
          },
        };
        await writer.nested.save("sessions.json");
      `("src/runtime/top-level-nested-object-wrapper-method.ts", [
        { kind: "legacy store filesystem write", line: 10 },
      ]),
      "flags top-level nested object wrapper methods copied through shorthand properties":
        sourceCase`
        import { promises as fs } from "node:fs";
        const nested = {
          save(filePath: string) {
            return fs.writeFile(filePath, "{}\\n");
          },
        };
        const writer = { nested };
        await writer.nested.save("sessions.json");
      `("src/runtime/top-level-nested-object-wrapper-shorthand.ts", [
          { kind: "legacy store filesystem write", line: 9 },
        ]),
      "flags top-level nested object wrapper methods copied through identifier properties":
        sourceCase`
        import { promises as fs } from "node:fs";
        const nested = {
          save(filePath: string) {
            return fs.writeFile(filePath, "{}\\n");
          },
        };
        const writer = { child: nested };
        await writer.child.save("sessions.json");
      `("src/runtime/top-level-nested-object-wrapper-identifier-property.ts", [
          { kind: "legacy store filesystem write", line: 9 },
        ]),
      "flags top-level nested object wrapper methods copied through property access aliases":
        sourceCase`
        import { promises as fs } from "node:fs";
        const writer = {
          nested: {
            save(filePath: string) {
              return fs.writeFile(filePath, "{}\\n");
            },
          },
        };
        const child = writer.nested;
        await child.save("sessions.json");
      `("src/runtime/top-level-nested-object-wrapper-property-access-alias.ts", [
          { kind: "legacy store filesystem write", line: 11 },
        ]),
      "clears top-level object wrapper methods overwritten with undefined": sourceCase`
        import { promises as fs } from "node:fs";
        function save(filePath: string) {
          return fs.writeFile(filePath, "{}\\n");
        }
        const writer = { save, save: undefined };
        await writer.save?.("sessions.json");
      `("src/runtime/top-level-object-wrapper-undefined-overwrite.ts", []),
      "clears top-level nested object wrapper methods overwritten with undefined": sourceCase`
        import { promises as fs } from "node:fs";
        const writer = {
          nested: {
            save(filePath: string) {
              return fs.writeFile(filePath, "{}\\n");
            },
          },
          nested: undefined,
        };
        await writer.nested?.save?.("sessions.json");
      `("src/runtime/top-level-nested-object-wrapper-undefined-overwrite.ts", []),
      "does not copy object wrapper methods from shadowed objects": sourceCase`
        import { promises as fs } from "node:fs";
        const writer = {
          save(filePath: string) {
            return fs.writeFile(filePath, "{}\\n");
          },
        };
        {
          const writer = {};
          const alias = writer;
          await alias.save?.("sessions.json");
        }
      `("src/runtime/shadowed-object-wrapper-method-alias.ts", []),
      "flags nested object wrapper methods assigned through object properties": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          const writer: any = {};
          writer.nested = {
            save() {
              return fs.writeFile(filePath, "{}\\n");
            },
          };
          return writer.nested.save();
        }
        await persist("sessions.json");
      `("src/runtime/nested-object-wrapper-property-object-assignment.ts", [
        { kind: "legacy store filesystem write", line: 12 },
      ]),
      "flags top-level nested object wrapper methods assigned through object properties":
        sourceCase`
        import { promises as fs } from "node:fs";
        const writer: any = {};
        writer.nested = {
          save(filePath: string) {
            return fs.writeFile(filePath, "{}\\n");
          },
        };
        await writer.nested.save("sessions.json");
      `("src/runtime/top-level-nested-object-wrapper-property-object-assignment.ts", [
          { kind: "legacy store filesystem write", line: 9 },
        ]),
      "flags nested object wrapper methods assigned through deep object properties": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          const writer: any = { nested: {} };
          writer.nested.save = () => fs.writeFile(filePath, "{}\\n");
          return writer.nested.save();
        }
        await persist("sessions.json");
      `("src/runtime/nested-object-wrapper-deep-property-assignment.ts", [
        { kind: "legacy store filesystem write", line: 8 },
      ]),
      "clears stale nested object wrapper methods after property reassignment": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          const writer: any = {
            nested: {
              save() {
                return fs.writeFile(filePath, "{}\\n");
              },
            },
          };
          writer.nested = {};
          return writer.nested.save?.();
        }
        await persist("sessions.json");
      `("src/runtime/nested-object-wrapper-property-object-reassignment.ts", []),
      "clears object wrapper property aliases overwritten with undefined": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          const save = () => fs.writeFile(filePath, "{}\\n");
          const writer = { save, save: undefined };
          return writer.save?.();
        }
        await persist("sessions.json");
      `("src/runtime/object-wrapper-property-undefined-overwrite.ts", []),
      "flags object wrapper methods assigned after declaration": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        let writer: any = {};
        writer = {
          persist(params: { filePath: string }) {
            return writeTextAtomic(params.filePath, "{}\\n");
          },
        };
        await writer.persist({ filePath: "sessions.json" });
      `("src/runtime/assigned-object-wrapper-method.ts", [
        { kind: "legacy store filesystem write", line: 9 },
      ]),
      "clears object wrapper metadata after object reassignment": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        let writer: any = {
          persist(params: { filePath: string }) {
            return writeTextAtomic(params.filePath, "{}\\n");
          },
        };
        writer = customWriter;
        await writer.persist({ filePath: "sessions.json" });
      `("src/runtime/reassigned-object-wrapper-method.ts", []),
      "uses branch-local object wrapper metadata after conditional reassignment": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        const writer: any = {
          persist(params: { filePath: string }) {
            return writeTextAtomic(params.filePath, "{}\\n");
          },
        };
        if (ready) {
          writer.persist = customPersist;
          await writer.persist({ filePath: "sessions.json" });
        }
      `("src/runtime/conditional-object-wrapper-reassignment.ts", []),
      "flags object wrapper property assignments": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        const writer: any = {};
        writer.persist = (params: { filePath: string }) => writeTextAtomic(params.filePath, "{}\\n");
        await writer.persist({ filePath: "sessions.json" });
      `("src/runtime/object-wrapper-property-assignment.ts", [
        { kind: "legacy store filesystem write", line: 5 },
      ]),
      "flags nested object wrapper methods copied through property access spreads": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        const writer: any = {
          nested: {
            save(params: { filePath: string }) {
              return writeTextAtomic(params.filePath, "{}\\n");
            },
          },
        };
        const copy = { ...writer.nested };
        await copy.save({ filePath: "sessions.json" });
      `("src/runtime/nested-object-wrapper-property-access-spread.ts", [
        { kind: "legacy store filesystem write", line: 11 },
      ]),
      "flags extracted object wrapper methods": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        const writer = {
          persist(params: { filePath: string }) {
            return writeTextAtomic(params.filePath, "{}\\n");
          },
        };
        const save = writer.persist;
        await save({ filePath: "sessions.json" });
      `("src/runtime/extracted-object-wrapper-method.ts", [
        { kind: "legacy store filesystem write", line: 9 },
      ]),
      "flags extracted bracket object wrapper methods": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        const writer = {
          persist(params: { filePath: string }) {
            return writeTextAtomic(params.filePath, "{}\\n");
          },
        };
        const save = writer["persist"];
        await save({ filePath: "sessions.json" });
      `("src/runtime/extracted-bracket-object-wrapper-method.ts", [
        { kind: "legacy store filesystem write", line: 9 },
      ]),
      "flags reassigned aliases from object wrapper methods": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        const writer = {
          persist(params: { filePath: string }) {
            return writeTextAtomic(params.filePath, "{}\\n");
          },
        };
        let save;
        save = writer.persist;
        await save({ filePath: "sessions.json" });
      `("src/runtime/reassigned-object-wrapper-method-alias.ts", [
        { kind: "legacy store filesystem write", line: 10 },
      ]),
      "flags destructured object wrapper methods": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        const writer = {
          persist(params: { filePath: string }) {
            return writeTextAtomic(params.filePath, "{}\\n");
          },
        };
        const { persist } = writer;
        await persist({ filePath: "sessions.json" });
      `("src/runtime/destructured-object-wrapper-method.ts", [
        { kind: "legacy store filesystem write", line: 9 },
      ]),
      "flags renamed destructured object wrapper methods": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        const writer = {
          persist(params: { filePath: string }) {
            return writeTextAtomic(params.filePath, "{}\\n");
          },
        };
        const { persist: save } = writer;
        await save({ filePath: "sessions.json" });
      `("src/runtime/renamed-destructured-object-wrapper-method.ts", [
        { kind: "legacy store filesystem write", line: 9 },
      ]),
      "flags defaulted destructured object wrapper methods": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          const writer = {};
          const { save = () => fs.writeFile(filePath, "{}\\n") } = writer;
          return save();
        }
        await persist("sessions.json");
      `("src/runtime/defaulted-destructured-object-wrapper-method.ts", [
        { kind: "legacy store filesystem write", line: 8 },
      ]),
      "does not use destructured wrapper defaults when safe callbacks are present": sourceCase`
        import { promises as fs } from "node:fs";
        const noopParam = async (_path: string) => {};
        function persist(filePath: string) {
          const writer = { save: noopParam };
          const { save = () => fs.writeFile(filePath, "{}\\n") } = writer;
          return save(filePath);
        }
        await persist("sessions.json");
      `("src/runtime/present-safe-callback-destructured-default.ts", []),
      "uses destructured wrapper defaults when properties are explicitly undefined": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          const writer = { save: undefined };
          const { save = () => fs.writeFile(filePath, "{}\\n") } = writer;
          return save();
        }
        await persist("sessions.json");
      `("src/runtime/undefined-callback-destructured-default.ts", [
        { kind: "legacy store filesystem write", line: 8 },
      ]),
      "uses destructured wrapper defaults when properties are aliased undefined": sourceCase`
        import { promises as fs } from "node:fs";
        const absent = undefined;
        function persist(filePath: string) {
          const writer = { save: absent };
          const { save = () => fs.writeFile(filePath, "{}\\n") } = writer;
          return save();
        }
        await persist("sessions.json");
      `("src/runtime/aliased-undefined-callback-destructured-default.ts", [
        { kind: "legacy store filesystem write", line: 9 },
      ]),
      "does not use destructured wrapper defaults after unknown spreads": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string, options: { save?: () => Promise<void> }) {
          const writer = { save: undefined, ...options };
          const { save = () => fs.writeFile(filePath, "{}\\n") } = writer;
          return save();
        }
        await persist("sessions.json", { save: async () => {} });
      `("src/runtime/object-wrapper-destructuring-default-unknown-spread.ts", []),
      "does not force destructured wrapper defaults from unknown spread objects": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string, defaults: { save?: () => Promise<void> }) {
          const writer = { ...defaults };
          const { save = () => fs.writeFile(filePath, "{}\\n") } = writer;
          return save();
        }
        await persist("sessions.json", { save: async () => {} });
      `("src/runtime/object-wrapper-destructuring-default-unknown-spread-object.ts", []),
      "does not force closed-over destructured wrapper defaults from unknown spread objects":
        sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string, defaults: { save?: () => Promise<void> }) {
          function inner() {
            const writer = { ...defaults };
            const { save = () => fs.writeFile(filePath, "{}\\n") } = writer;
            return save();
          }
          return inner();
        }
        await persist("sessions.json", { save: async () => {} });
      `(
          "src/runtime/object-wrapper-destructuring-default-unknown-spread-object-closed-over.ts",
          [],
        ),
      "keeps branch-only object wrapper methods after exhaustive merge": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string, enabled: boolean) {
          let writer = {};
          if (enabled) {
            writer = {
              save() {
                return fs.writeFile(filePath, "{}\\n");
              },
            };
          } else {
            writer = {};
          }
          const { save } = writer;
          return save();
        }
        await persist("sessions.json", true);
      `("src/runtime/branch-only-object-wrapper-method.ts", [
        { kind: "legacy store filesystem write", line: 17 },
      ]),
      "keeps branch-only property assigned object wrapper methods after exhaustive merge":
        sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string, enabled: boolean) {
          let writer = {};
          if (enabled) {
            writer.save = () => fs.writeFile(filePath, "{}\\n");
          } else {
            writer = {};
          }
          return writer.save?.();
        }
        await persist("sessions.json", true);
      `("src/runtime/branch-only-property-object-wrapper-method.ts", [
          { kind: "legacy store filesystem write", line: 12 },
        ]),
      "keeps prior nested wrapper values when only one branch assigns": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(filePath: string, disabled: boolean) {
          let save = (nextPath: string) => fs.writeFile(nextPath, "{}\\n");
          if (disabled) {
            save = async () => {};
          } else {
          }
          return save(filePath);
        }
        await persist("sessions.json", false);
      `("src/runtime/prior-wrapper-value-branch-assignment.ts", [
        { kind: "legacy store filesystem write", line: 11 },
      ]),
      "clears wrapper metadata after non-wrapper reassignment": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        let persist = (params: { filePath: string }) => writeTextAtomic(params.filePath, "{}\\n");
        persist = customSink;
        persist({ filePath: "sessions.json" });
      `("src/runtime/cleared-wrapper-variable.ts", []),
      "keeps wrapper metadata after conditional non-wrapper reassignment": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        let persist = (params: { filePath: string }) => writeTextAtomic(params.filePath, "{}\\n");
        if (ready) persist = customSink;
        persist({ filePath: "sessions.json" });
      `("src/runtime/conditional-cleared-wrapper-variable.ts", [
        { kind: "legacy store filesystem write", line: 5 },
      ]),
      "clears wrapper metadata after exhaustive non-wrapper reassignments": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        let persist = (params: { filePath: string }) => writeTextAtomic(params.filePath, "{}\\n");
        if (ready) persist = customSink;
        else persist = customSink;
        persist({ filePath: "sessions.json" });
      `("src/runtime/exhaustive-cleared-wrapper-variable.ts", []),
      "keeps wrapper metadata after try-block non-wrapper reassignment": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        let persist = (params: { filePath: string }) => writeTextAtomic(params.filePath, "{}\\n");
        try {
          maybeThrow();
          persist = customSink;
        } catch {}
        persist({ filePath: "sessions.json" });
      `("src/runtime/try-cleared-wrapper-variable.ts", [
        { kind: "legacy store filesystem write", line: 8 },
      ]),
    }),
  )("$name", ({ source, filename, expected }) => {
    const violations = collectDatabaseFirstLegacyStoreViolations(source, filename);

    expect(violations).toEqual(expected);
  });

  // Tracked object paths, destructuring, and shadowing.
  it.each(
    namedCases({
      "flags wrapper option paths read through bracket property access": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }) {
          return writeTextAtomic(params["filePath"], "{}\\n");
        }
        persist({ filePath: "sessions.json" });
      `("src/runtime/bracket-wrapper-property.ts", [
        { kind: "legacy store filesystem write", line: 6 },
      ]),
      "does not treat custom writeFile methods as wrapper filesystem writes": sourceCase`
        function persist(writer: { writeFile: (path: string, content: string) => void }, params: { filePath: string }) {
          return writer.writeFile(params.filePath, "{}\\n");
        }
        persist(customWriter, { filePath: "sessions.json" });
      `("src/runtime/custom-writer-method-wrapper.ts", []),
      "does not use outer wrapper metadata for shadowed wrapper names": sourceCase`
        import { writeJson } from "../infra/json-files.js";
        function persist(options: { store: string }) {
          return writeJson(options.store, {});
        }
        {
          function persist(_options: { store: string }) {
            return "current";
          }
          await persist({ store: "sessions.json" });
        }
      `("src/runtime/shadowed-wrapper-options.ts", []),
      "does not let loop-scoped wrapper names shadow outer wrappers": sourceCase`
        import { writeJson } from "../infra/json-files.js";
        function persist(options: { store: string }) {
          return writeJson(options.store, {});
        }
        for (const persist of handlers) {
          await persist(currentOptions);
        }
        await persist({ store: "sessions.json" });
      `("src/runtime/loop-scoped-wrapper-name.ts", [
        { kind: "legacy store filesystem write", line: 9 },
      ]),
      "does not use outer wrapper metadata for destructured parameter wrapper names": sourceCase`
        import { writeJson } from "../infra/json-files.js";
        function persist(options: { store: string }) {
          return writeJson(options.store, {});
        }
        function caller({ persist }: { persist: (options: { store: string }) => void }) {
          persist({ store: "sessions.json" });
        }
      `("src/runtime/destructured-wrapper-name-parameter.ts", []),
      "does not treat sibling object metadata as the wrapper path property": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }) {
          return writeTextAtomic(params.filePath, "{}\\n");
        }
        const params = { label: "sessions.json", filePath: currentSqlitePath };
        await persist(params);
      `("src/runtime/current-path-sibling-metadata.ts", []),
      "does not treat custom writeFile methods as direct filesystem writes": sourceCase`
        const params = { filePath: "sessions.json" };
        await customWriter.writeFile(params.filePath, "{}\\n");
      `("src/runtime/custom-writer-method.ts", []),
      "flags legacy paths written through injected fs handles": sourceCase`
        const storePath = "sessions.json";
        const params: { deps: { fs: typeof import("node:fs") } } = { deps };
        await params.deps.fs.promises.writeFile(storePath, "{}\\n");
      `("src/runtime/injected-fs-write.ts", [{ kind: "legacy store filesystem write", line: 4 }]),
      "does not treat custom fs properties as direct filesystem writes": sourceCase`
        const storePath = "sessions.json";
        await client.fs.promises.writeFile(storePath, "{}\\n");
      `("src/runtime/custom-fs-property.ts", []),
      "updates object path metadata after property assignment": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        const params = { filePath: currentSqlitePath };
        params.filePath = "sessions.json";
        writeTextAtomic(params.filePath, "{}\\n");
      `("src/runtime/assigned-object-path.ts", [
        { kind: "legacy store filesystem write", line: 5 },
      ]),
      "updates object path metadata after bracket property assignment": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        const params = { filePath: currentSqlitePath };
        params["filePath"] = "sessions.json";
        writeTextAtomic(params["filePath"], "{}\\n");
      `("src/runtime/bracket-assigned-object-path.ts", [
        { kind: "legacy store filesystem write", line: 5 },
      ]),
      "updates outer object path metadata after nested property assignment": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        const params = { filePath: currentSqlitePath };
        {
          params.filePath = "sessions.json";
        }
        writeTextAtomic(params.filePath, "{}\\n");
      `("src/runtime/nested-assigned-object-path.ts", [
        { kind: "legacy store filesystem write", line: 7 },
      ]),
      "flags nested property assignments forwarded through option objects": sourceCase`
        import { promises as fs } from "node:fs";
        function persist({ paths: { filePath } }: { paths: { filePath: string } }) {
          return fs.writeFile(filePath, "{}\\n");
        }
        const options = { paths: {} };
        options.paths.filePath = "sessions.json";
        await persist(options);
      `("src/runtime/nested-wrapper-option-property-assignment.ts", [
        { kind: "legacy store filesystem write", line: 8 },
      ]),
      "flags nested property assignments read directly by filesystem writes": sourceCase`
        import { promises as fs } from "node:fs";
        const options = { paths: {} };
        options.paths.filePath = "sessions.json";
        await fs.writeFile(options.paths.filePath, "{}\\n");
      `("src/runtime/nested-direct-property-assignment.ts", [
        { kind: "legacy store filesystem write", line: 5 },
      ]),
      "flags nested parent object assignments forwarded through option objects": sourceCase`
        import { promises as fs } from "node:fs";
        function persist({ paths: { filePath } }: { paths: { filePath: string } }) {
          return fs.writeFile(filePath, "{}\\n");
        }
        const options = { paths: {} };
        options.paths = { filePath: "sessions.json" };
        await persist(options);
      `("src/runtime/nested-wrapper-option-parent-assignment.ts", [
        { kind: "legacy store filesystem write", line: 8 },
      ]),
      "flags nested defaults after parent object property assignments": sourceCase`
        import { promises as fs } from "node:fs";
        function persist({ paths: { filePath = "sessions.json" } }: { paths: { filePath?: string } }) {
          return fs.writeFile(filePath, "{}\\n");
        }
        const options = {};
        options.paths = {};
        await persist(options);
      `("src/runtime/nested-wrapper-option-parent-known-empty-assignment.ts", [
        { kind: "legacy store filesystem write", line: 8 },
      ]),
      "clears nested path metadata after parent object assignments": sourceCase`
        import { promises as fs } from "node:fs";
        function persist({ paths: { filePath } }: { paths: { filePath: string } }) {
          return fs.writeFile(filePath, "{}\\n");
        }
        const options = { paths: { filePath: "sessions.json" } };
        options.paths = { filePath: "current-state.json" };
        await persist(options);
      `("src/runtime/nested-wrapper-option-parent-current-assignment.ts", []),
      "keeps maybe missing nested properties after conditional parent object assignments":
        sourceCase`
        import { promises as fs } from "node:fs";
        function persist({ paths: { filePath = "sessions.json" } }: { paths: { filePath?: string } }) {
          return fs.writeFile(filePath, "{}\\n");
        }
        const options = { paths: { filePath: "state/openclaw.sqlite" } };
        if (Math.random() > 0.5) {
          options.paths = {};
        }
        await persist(options);
      `("src/runtime/conditional-nested-parent-missing-property.ts", [
          { kind: "legacy store filesystem write", line: 10 },
        ]),
      "clears object path metadata after current-path assignment": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        const params = { filePath: "sessions.json" };
        params.filePath = currentSqlitePath;
        writeTextAtomic(params.filePath, "{}\\n");
      `("src/runtime/reassigned-object-path.ts", []),
      "keeps legacy object metadata after conditional current-path assignment": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        const params = { filePath: "sessions.json" };
        if (ready) params.filePath = currentSqlitePath;
        writeTextAtomic(params.filePath, "{}\\n");
      `("src/runtime/conditional-current-object-path.ts", [
        { kind: "legacy store filesystem write", line: 5 },
      ]),
      "keeps maybe missing properties after conditional safe property assignments": sourceCase`
        import { promises as fs } from "node:fs";
        const options = {};
        if (ready) options.path = currentSqlitePath;
        function writePath(filePath: string, { path = filePath } = {}) {
          return fs.writeFile(path, "{}\\n");
        }
        await writePath("sessions.json", options);
      `("src/runtime/conditional-safe-property-missing-default.ts", [
        { kind: "legacy store filesystem write", line: 8 },
      ]),
      "keeps legacy object metadata after loop current-path assignment": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        const params = { filePath: "sessions.json" };
        while (ready) params.filePath = currentSqlitePath;
        writeTextAtomic(params.filePath, "{}\\n");
      `("src/runtime/loop-current-object-path.ts", [
        { kind: "legacy store filesystem write", line: 5 },
      ]),
      "does not let for-loop object bindings clear outer object metadata": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        const params = { filePath: "sessions.json" };
        for (const params = { filePath: currentSqlitePath }; ready; advance()) {
          await use(params);
        }
        writeTextAtomic(params.filePath, "{}\\n");
      `("src/runtime/for-loop-object-shadow.ts", [
        { kind: "legacy store filesystem write", line: 7 },
      ]),
      "does not leak for-loop legacy object bindings after the loop": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        const params = { filePath: currentSqlitePath };
        for (const params = { filePath: "sessions.json" }; ready; advance()) {
          await use(params);
        }
        writeTextAtomic(params.filePath, "{}\\n");
      `("src/runtime/for-loop-legacy-object-shadow.ts", []),
      "keeps legacy object metadata after conditional current-object assignment": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        let params = { filePath: "sessions.json" };
        if (ready) {
          params = { filePath: currentSqlitePath };
        }
        writeTextAtomic(params.filePath, "{}\\n");
      `("src/runtime/conditional-current-object.ts", [
        { kind: "legacy store filesystem write", line: 7 },
      ]),
      "clears object metadata after exhaustive current-object assignments": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        let params = { filePath: "sessions.json" };
        if (ready) {
          params = { filePath: currentSqlitePath };
        } else {
          params = { filePath: currentSqlitePath };
        }
        writeTextAtomic(params.filePath, "{}\\n");
      `("src/runtime/exhaustive-current-object.ts", []),
      "keeps outer object metadata after optional exhaustive current-object assignments":
        sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        let params = { filePath: "sessions.json" };
        if (ready) {
          if (mode === "a") {
            params = { filePath: currentSqlitePath };
          } else {
            params = { filePath: currentSqlitePath };
          }
        }
        writeTextAtomic(params.filePath, "{}\\n");
      `("src/runtime/optional-exhaustive-current-object.ts", [
          { kind: "legacy store filesystem write", line: 11 },
        ]),
      "allows branch-local writes after nested exhaustive current-object assignments": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        let params = { filePath: "sessions.json" };
        if (ready) {
          if (mode === "a") {
            params = { filePath: currentSqlitePath };
          } else {
            params = { filePath: currentSqlitePath };
          }
          writeTextAtomic(params.filePath, "{}\\n");
        }
      `("src/runtime/branch-local-exhaustive-current-object.ts", []),
      "keeps object metadata when one exhaustive branch keeps a legacy object": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        let params = { filePath: "sessions.json" };
        if (ready) {
          params = { filePath: currentSqlitePath };
        } else {
          params = { filePath: "sessions.json" };
        }
        writeTextAtomic(params.filePath, "{}\\n");
      `("src/runtime/exhaustive-mixed-object.ts", [
        { kind: "legacy store filesystem write", line: 9 },
      ]),
      "clears object property metadata after exhaustive current-path assignments": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        const params = { filePath: "sessions.json" };
        if (ready) {
          params.filePath = currentSqlitePath;
        } else {
          params.filePath = currentSqlitePath;
        }
        writeTextAtomic(params.filePath, "{}\\n");
      `("src/runtime/exhaustive-current-object-property.ts", []),
      "keeps legacy object metadata after try-block current-object assignment": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        let params = { filePath: "sessions.json" };
        try {
          maybeThrow();
          params = { filePath: currentSqlitePath };
        } catch {}
        writeTextAtomic(params.filePath, "{}\\n");
      `("src/runtime/try-current-object.ts", [{ kind: "legacy store filesystem write", line: 8 }]),
      "clears outer object path metadata after nested current-path assignment": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        const params = { filePath: "sessions.json" };
        {
          params.filePath = currentSqlitePath;
        }
        writeTextAtomic(params.filePath, "{}\\n");
      `("src/runtime/nested-reassigned-object-path.ts", []),
      "allows in-branch writes after object property reassignment to the current path": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        const params = { filePath: "sessions.json" };
        if (ready) {
          params.filePath = currentSqlitePath;
          writeTextAtomic(params.filePath, "{}\\n");
        }
      `("src/runtime/branch-reassigned-object-property.ts", []),
      "updates object path metadata after whole-object assignment": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        let params = { filePath: currentSqlitePath };
        params = { filePath: "sessions.json" };
        writeTextAtomic(params.filePath, "{}\\n");
      `("src/runtime/reassigned-object.ts", [{ kind: "legacy store filesystem write", line: 5 }]),
      "clears object path metadata after whole-object current-path assignment": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        let params = { filePath: "sessions.json" };
        params = { filePath: currentSqlitePath };
        writeTextAtomic(params.filePath, "{}\\n");
      `("src/runtime/reassigned-current-object.ts", []),
      "flags legacy paths destructured from tracked object properties": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        const params = { filePath: "sessions.json" };
        const { filePath } = params;
        writeTextAtomic(filePath, "{}\\n");
      `("src/runtime/destructured-tracked-object-path.ts", [
        { kind: "legacy store filesystem write", line: 5 },
      ]),
      "flags legacy paths from nested destructured object properties": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        const params = { nested: { filePath: "sessions.json" } };
        const { nested: { filePath } } = params;
        writeTextAtomic(filePath, "{}\\n");
      `("src/runtime/nested-destructured-tracked-object-path.ts", [
        { kind: "legacy store filesystem write", line: 5 },
      ]),
      "uses tracked nested current paths before destructured defaults": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        const params = { nested: { filePath: currentSqlitePath } };
        const { nested: { filePath = "sessions.json" } } = params;
        writeTextAtomic(filePath, "{}\\n");
      `("src/runtime/nested-destructured-current-object-path.ts", []),
      "flags nested defaults after conditional whole-object rewrites omit safe properties":
        sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist({ paths: { filePath = "sessions.json" } }: { paths: { filePath?: string } }) {
          return writeTextAtomic(filePath, "{}\\n");
        }
        let options = { paths: { filePath: currentSqlitePath } };
        if (ready) {
          options = { paths: {} };
        }
        await persist(options);
      `("src/runtime/conditional-whole-object-rewrite-nested-default.ts", [
          { kind: "legacy store filesystem write", line: 10 },
        ]),
      "flags nested defaults after conditional whole-object rewrites from known aliases":
        sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist({ paths: { filePath = "sessions.json" } }: { paths: { filePath?: string } }) {
          return writeTextAtomic(filePath, "{}\\n");
        }
        const source = { paths: {} };
        let options = { paths: { filePath: currentSqlitePath } };
        if (ready) {
          options = source;
        }
        await persist(options);
      `("src/runtime/conditional-whole-object-rewrite-alias-nested-default.ts", [
          { kind: "legacy store filesystem write", line: 11 },
        ]),
      "flags legacy paths from destructured default values": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        const params = {};
        const { filePath = "sessions.json" } = params;
        writeTextAtomic(filePath, "{}\\n");
      `("src/runtime/destructured-default-object-path.ts", [
        { kind: "legacy store filesystem write", line: 5 },
      ]),
      "flags legacy paths from inline object destructured default values": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        const { filePath = "sessions.json" } = {};
        writeTextAtomic(filePath, "{}\\n");
      `("src/runtime/inline-destructured-default-object-path.ts", [
        { kind: "legacy store filesystem write", line: 4 },
      ]),
      "flags legacy paths from inline destructured object descendants": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        const { paths } = { paths: { filePath: "sessions.json" } };
        writeTextAtomic(paths.filePath, "{}\\n");
      `("src/runtime/inline-destructured-object-descendant-path.ts", [
        { kind: "legacy store filesystem write", line: 4 },
      ]),
      "flags legacy paths destructured from tracked nested properties": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        const options = { paths: { filePath: "sessions.json" } };
        const { filePath } = options.paths;
        writeTextAtomic(filePath, "{}\\n");
      `("src/runtime/destructured-tracked-nested-property-path.ts", [
        { kind: "legacy store filesystem write", line: 5 },
      ]),
      "does not force inline object destructured defaults after unknown spreads": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        declare const defaults: { filePath?: string };
        const { filePath = "sessions.json" } = { ...defaults };
        writeTextAtomic(filePath, "{}\\n");
      `("src/runtime/inline-destructured-default-unknown-spread.ts", []),
      "flags destructured defaults from explicitly undefined tracked properties": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        const params = { filePath: undefined };
        const { filePath = "sessions.json" } = params;
        writeTextAtomic(filePath, "{}\\n");
      `("src/runtime/destructured-default-explicit-undefined-object-path.ts", [
        { kind: "legacy store filesystem write", line: 5 },
      ]),
      "flags wrapper defaults from destructured missing tracked properties": sourceCase`
        import { promises as fs } from "node:fs";
        const params = {};
        function persist({ path = "sessions.json" }: { path?: string }) {
          return fs.writeFile(path, "{}\\n");
        }
        const { filePath } = params;
        await persist({ path: filePath });
      `("src/runtime/destructured-missing-property-wrapper-default.ts", [
        { kind: "legacy store filesystem write", line: 8 },
      ]),
      "flags wrapper defaults from inline destructured missing properties": sourceCase`
        import { promises as fs } from "node:fs";
        function persist({ path = "sessions.json" }: { path?: string }) {
          return fs.writeFile(path, "{}\\n");
        }
        const { filePath } = {};
        await persist({ path: filePath });
      `("src/runtime/inline-destructured-missing-property-wrapper-default.ts", [
        { kind: "legacy store filesystem write", line: 7 },
      ]),
      "flags destructured defaults from aliased undefined tracked properties": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        const absent = undefined;
        const params = { filePath: absent };
        const { filePath = "sessions.json" } = params;
        writeTextAtomic(filePath, "{}\\n");
      `("src/runtime/destructured-default-aliased-undefined-object-path.ts", [
        { kind: "legacy store filesystem write", line: 6 },
      ]),
      "uses tracked object properties before destructured defaults": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        const params = { filePath: currentSqlitePath };
        const { filePath = "sessions.json" } = params;
        writeTextAtomic(filePath, "{}\\n");
      `("src/runtime/destructured-default-current-object-path.ts", []),
      "flags wrapper shorthand options destructured from tracked object properties": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }) {
          return writeTextAtomic(params.filePath, "{}\\n");
        }
        const params = { filePath: "sessions.json" };
        const { filePath } = params;
        persist({ filePath });
      `("src/runtime/destructured-shorthand-wrapper-path.ts", [
        { kind: "legacy store filesystem write", line: 8 },
      ]),
      "does not treat unrelated property names as destructured wrapper paths": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist({ filePath }: { filePath: string }) {
          return writeTextAtomic(current.filePath, "{}\\n");
        }
        await persist({ filePath: "sessions.json" });
      `("src/runtime/unrelated-property-name-wrapper.ts", []),
      "flags wrapper option paths forwarded through object aliases": sourceCase`
        import { writeJson } from "../infra/json-files.js";
        function persist(options: { store: string }) {
          return writeJson(options.store, {});
        }
        const params = { store: "sessions.json" };
        const forwarded = params;
        await persist(forwarded);
      `("src/runtime/forwarded-wrapper-options.ts", [
        { kind: "legacy store filesystem write", line: 8 },
      ]),
      "flags wrapper option paths forwarded through destructured object aliases": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { paths: { filePath: string } }) {
          return writeTextAtomic(params.paths.filePath, "{}\\n");
        }
        const options = { paths: { filePath: "sessions.json" } };
        const { paths } = options;
        await persist({ paths });
      `("src/runtime/wrapper-option-path-destructured-object-alias.ts", [
        { kind: "legacy store filesystem write", line: 8 },
      ]),
      "does not treat sibling nested properties as wrapper option paths": sourceCase`
        import { promises as fs } from "node:fs";
        function persist(params: { paths: { filePath: string; legacyPath: string } }) {
          return fs.writeFile(params.paths.filePath, "{}\\n");
        }
        const options = {
          paths: {
            filePath: "state/openclaw.sqlite",
            legacyPath: "sessions.json",
          },
        };
        await persist(options);
      `("src/runtime/wrapper-option-path-nested-sibling-property.ts", []),
      "clears nested wrapper option paths after object literal spread overwrites": sourceCase`
        import { promises as fs } from "node:fs";
        function persist({ paths: { filePath = currentSqlitePath } = {} }) {
          return fs.writeFile(filePath, "{}\\n");
        }
        const params = {
          paths: { filePath: "sessions.json" },
          ...{ paths: {} },
        };
        await persist(params);
      `("src/runtime/wrapper-option-path-object-spread-overwrite.ts", []),
      "clears known nested wrapper option paths after parent rewrites": sourceCase`
        import { promises as fs } from "node:fs";
        declare function loadNested(): { filePath?: string };
        function persist({ paths: { nested: { filePath = "sessions.json" } = {} } }) {
          return fs.writeFile(filePath, "{}\\n");
        }
        const options = { paths: { nested: {} } };
        options.paths = { nested: loadNested() };
        await persist(options);
      `("src/runtime/wrapper-option-path-parent-rewrite-unknown-nested.ts", []),
      "flags wrapper option paths forwarded through object spreads": sourceCase`
        import { writeJson } from "../infra/json-files.js";
        function persist(options: { store: string }) {
          return writeJson(options.store, {});
        }
        const params = { store: "sessions.json" };
        const forwarded = { ...params };
        await persist(forwarded);
      `("src/runtime/spread-wrapper-options.ts", [
        { kind: "legacy store filesystem write", line: 8 },
      ]),
      "flags wrapper option paths passed through inline object spreads": sourceCase`
        import { writeJson } from "../infra/json-files.js";
        function persist(options: { store: string }) {
          return writeJson(options.store, {});
        }
        const params = { store: "sessions.json" };
        await persist({ ...params });
        await persist({ store: currentSqlitePath, ...params });
      `("src/runtime/inline-spread-wrapper-options.ts", [
        { kind: "legacy store filesystem write", line: 7 },
        { kind: "legacy store filesystem write", line: 8 },
      ]),
      "flags wrapper option paths passed through inline object literal spreads": sourceCase`
        import { writeJson } from "../infra/json-files.js";
        function persist(options: { store: string }) {
          return writeJson(options.store, {});
        }
        await persist({ ...{ store: "sessions.json" } });
        const params = { ...{ store: "sessions.json" } };
        await persist(params);
      `("src/runtime/inline-object-literal-spread-wrapper-options.ts", [
        { kind: "legacy store filesystem write", line: 6 },
        { kind: "legacy store filesystem write", line: 8 },
      ]),
      "allows inline object spreads when a later property overrides the legacy path": sourceCase`
        import { writeJson } from "../infra/json-files.js";
        function persist(options: { store: string }) {
          return writeJson(options.store, {});
        }
        const params = { store: "sessions.json" };
        await persist({ ...params, store: currentSqlitePath });
      `("src/runtime/inline-spread-wrapper-options.ts", []),
      "allows inline object literal spreads when a later property overrides the legacy path":
        sourceCase`
        import { writeJson } from "../infra/json-files.js";
        function persist(options: { store: string }) {
          return writeJson(options.store, {});
        }
        await persist({ ...{ store: "sessions.json" }, store: currentSqlitePath });
        await persist({ store: "sessions.json", ...{ store: currentSqlitePath } });
      `("src/runtime/inline-object-literal-spread-current-wrapper-options.ts", []),
      "allows inline object spreads when a later spread overrides the legacy path": sourceCase`
        import { writeJson } from "../infra/json-files.js";
        function persist(options: { store: string }) {
          return writeJson(options.store, {});
        }
        const currentOptions = { store: currentSqlitePath };
        await persist({ store: "sessions.json", ...currentOptions });
      `("src/runtime/inline-current-spread-wrapper-options.ts", []),
      "allows nested inline object spreads when a later spread overrides the legacy path":
        sourceCase`
        import { writeJson } from "../infra/json-files.js";
        function persist({ paths: { filePath } }: { paths: { filePath: string } }) {
          return writeJson(filePath, {});
        }
        await persist({
          paths: { filePath: "sessions.json" },
          ...{ paths: { filePath: currentSqlitePath } },
        });
      `("src/runtime/nested-inline-current-spread-wrapper-options.ts", []),
      "does not copy wrapper option metadata from shadowed source objects": sourceCase`
        import { writeJson } from "../infra/json-files.js";
        function persist(options: { store: string }) {
          return writeJson(options.store, {});
        }
        const params = { store: "sessions.json" };
        {
          const params = currentSqlitePath;
          const forwarded = params;
          await persist(forwarded);
        }
      `("src/runtime/shadowed-forwarded-wrapper-options.ts", []),
      "does not treat shadowed fs alias names as wrapper filesystem writes": sourceCase`
        import { writeFile } from "node:fs/promises";
        function persist(writeFile: (path: string, value: string) => void, params: { filePath: string }) {
          return writeFile(params.filePath, "{}\\n");
        }
        await persist(customSink, { filePath: "sessions.json" });
      `("src/runtime/shadowed-fs-alias-wrapper.ts", []),
      "does not treat block-shadowed fs alias names as wrapper filesystem writes": sourceCase`
        import { writeFile } from "node:fs/promises";
        {
          const writeFile = customSink;
          function persist(params: { filePath: string }) {
            return writeFile(params.filePath, "{}\\n");
          }
          persist({ filePath: "sessions.json" });
        }
      `("src/runtime/block-shadowed-fs-alias-wrapper.ts", []),
      "does not treat destructures from shadowed fs module names as wrapper filesystem writes":
        sourceCase`
        import fs from "node:fs/promises";
        function persist(params: { filePath: string }) {
          const fs = customFs;
          const { writeFile } = fs;
          return writeFile(params.filePath, "{}\\n");
        }
        persist({ filePath: "sessions.json" });
      `("src/runtime/shadowed-fs-module-wrapper.ts", []),
      "does not treat shadowed wrapper parameter objects as argument paths": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }) {
          {
            const params = { filePath: currentSqlitePath };
            writeTextAtomic(params.filePath, "{}\\n");
          }
        }
        await persist({ filePath: "sessions.json" });
      `("src/runtime/shadowed-wrapper-parameter-object.ts", []),
      "does not keep object metadata for uninitialized local shadows": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        const params = { filePath: "sessions.json" };
        {
          let params;
          writeTextAtomic(params.filePath, "{}\\n");
        }
      `("src/runtime/uninitialized-object-shadow.ts", []),
      "keeps catch binding shadows scoped to the catch block": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        const params = { filePath: "sessions.json" };
        try {
          await load();
        } catch (params) {
          writeTextAtomic(params.filePath, "{}\\n");
        }
        writeTextAtomic(params.filePath, "{}\\n");
      `("src/runtime/catch-object-shadow.ts", [{ kind: "legacy store filesystem write", line: 9 }]),
      "keeps closed-over catch binding shadows scoped to the catch block": sourceCase`
        import fs from "node:fs/promises";
        function persist(filePath: string) {
          function inner() {
            try {
              await load();
            } catch (filePath) {
              await recover(filePath);
            }
            return fs.writeFile(filePath, "{}\\n");
          }
          return inner();
        }
        await persist("sessions.json");
      `("src/runtime/nested-wrapper-catch-shadow.ts", [
        { kind: "legacy store filesystem write", line: 14 },
      ]),
      "keeps wrapper catch binding shadows scoped to the catch block": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }) {
          try {
            await load();
          } catch (params) {
            await recover(params);
          }
          writeTextAtomic(params.filePath, "{}\\n");
        }
        persist({ filePath: "sessions.json" });
      `("src/runtime/wrapper-catch-object-shadow.ts", [
        { kind: "legacy store filesystem write", line: 11 },
      ]),
      "does not keep object metadata for destructured local shadows": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        const params = { filePath: "sessions.json" };
        {
          const { params } = source;
          writeTextAtomic(params.filePath, "{}\\n");
        }
      `("src/runtime/destructured-object-shadow.ts", []),
      "does not let unrelated nested fs aliases mark custom writes": sourceCase`
        import fs from "node:fs/promises";
        import { writeFile } from "./custom-writer.js";
        await writeFile("sessions.json", "{}\\n");
        function later() {
          const { writeFile } = fs;
          return writeFile(currentSqlitePath, "{}\\n");
        }
      `("src/runtime/custom-writer-shadow.ts", []),
      "does not use caller block fs aliases for outer wrapper bodies": sourceCase`
        import fs from "node:fs/promises";
        import { writeFile } from "./custom-writer.js";
        function persist(params: { filePath: string }) {
          return writeFile(params.filePath, "{}\\n");
        }
        {
          const { writeFile } = fs;
          await persist({ filePath: "sessions.json" });
        }
      `("src/runtime/caller-block-alias-wrapper.ts", []),
      "does not leak block-scoped fs aliases across wrapper body scopes": sourceCase`
        import fs from "node:fs/promises";
        function persist(params: { filePath: string }) {
          {
            const { writeFile } = fs;
            writeFile(currentSqlitePath, "{}\\n");
          }
          return writeFile(params.filePath, "{}\\n");
        }
        await persist({ filePath: "sessions.json" });
      `("src/runtime/block-scoped-fs-alias-wrapper.ts", []),
      "ignores shadowed destructured wrapper option names": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist({ filePath }: { filePath: string }) {
          {
            const filePath = currentSqlitePath;
            writeTextAtomic(filePath, "{}\\n");
          }
        }
        await persist({ filePath: "sessions.json" });
      `("src/runtime/shadowed-destructured-wrapper-options.ts", []),
      "keeps earlier destructured wrapper option uses before later shadowing": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist({ filePath }: { filePath: string }) {
          writeTextAtomic(filePath, "{}\\n");
          {
            const filePath = currentSqlitePath;
          }
        }
        await persist({ filePath: "sessions.json" });
      `("src/runtime/late-shadowed-destructured-wrapper-options.ts", [
        { kind: "legacy store filesystem write", line: 9 },
      ]),
      "does not leak legacy path variable names across lexical scopes": sourceCase`
        import { promises as fs } from "node:fs";
        {
          const storePath = "sessions.json";
        }
        export async function save(storePath: string) {
          await fs.writeFile(storePath, "{}\\n", "utf8");
        }
      `("src/runtime/current-store-writer.ts", []),
      "lets inner bindings shadow outer legacy path variables": sourceCase`
        import { promises as fs } from "node:fs";
        const storePath = "sessions.json";
        {
          const storePath = currentSqlitePath;
          await fs.writeFile(storePath, "{}\\n", "utf8");
        }
      `("src/runtime/current-store-writer.ts", []),
      "lets inner object properties shadow outer legacy path properties": sourceCase`
        import { writeTextAtomic } from "../infra/json-files.js";
        const params = { filePath: "sessions.json" };
        {
          const params = { filePath: currentSqlitePath };
          await writeTextAtomic(params.filePath, "{}\\n");
        }
      `("src/runtime/current-store-writer.ts", []),
      "ignores legacy filenames in write payloads": sourceCase`
        import { promises as fs } from "node:fs";
        await fs.writeFile(reportPath, "sessions.json\\n", "utf8");
        await fs.appendFile(currentLogPath, "cron/runs/job.jsonl\\n", "utf8");
      `("src/runtime/report-writer.ts", []),
    }),
  )("$name", ({ source, filename, expected }) => {
    const violations = collectDatabaseFirstLegacyStoreViolations(source, filename);

    expect(violations).toEqual(expected);
  });

  // Current-debt and migration-owner policy.
  it.each(
    namedCases({
      "flags runtime writes to sidecar SQLite and JSONL stores": sourceCase`
        import fs from "node:fs";
        fs.appendFileSync("cron/runs/job.jsonl", "{}\\n");
        fs.writeFileSync("plugin-state/state.sqlite", "");
      `("extensions/example/src/store.ts", [
        { kind: "legacy store filesystem write", line: 3 },
        { kind: "legacy store filesystem write", line: 4 },
      ]),
      "flags new writes in current legacy-debt files": sourceCase`
        import fs from "node:fs";
        fs.writeFileSync("sessions.json", "{}\\n");
      `("extensions/memory-wiki/src/compile.ts", [
        { kind: "legacy store filesystem write", line: 3 },
      ]),
    }),
  )("$name", ({ source, filename, expected }) => {
    const violations = collectDatabaseFirstLegacyStoreViolations(source, filename);

    expect(violations).toEqual(expected);
  });

  it("flags changed writes on current legacy-debt lines", () => {
    const content = `import fs from "node:fs";${"\n".repeat(667)}fs.writeFileSync("sessions.json", "{}\\n");`;
    const violations = collectDatabaseFirstLegacyStoreViolations(
      content,
      "extensions/memory-wiki/src/compile.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 668 }]);
  });

  it("flags duplicate copies when one current legacy-debt write is allowed", () => {
    const relativePath = "extensions/memory-wiki/src/compile.ts";
    const allowedWrite = `fs.writeFileSync("sessions.json", "{}\\n")`;
    const currentLegacyWriteAllowances = new Map([
      [`${relativePath}:legacy store filesystem write:${allowedWrite}`, 1],
    ]);
    const violations = collectDatabaseFirstLegacyStoreViolations(
      [`import fs from "node:fs";`, `${allowedWrite};`, `${allowedWrite};`].join("\n"),
      relativePath,
      { currentLegacyWriteAllowances },
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 3 }]);
  });

  // Migration-owner allowlists and runtime exclusions.
  it.each(
    namedCases({
      "allows doctor and migration owners to import or archive legacy files": sourceCase`
        import { promises as fs } from "node:fs";
        await fs.rename("cron/jobs.json", "cron/jobs.json.migrated");
        await fs.writeFile("sessions.json", "{}\\n", "utf8");
      `("src/commands/doctor/cron/legacy-store-migration.ts", []),
      "blocks runtime writes to the retired device identity file": sourceCase`
        import fs from "node:fs";
        fs.writeFileSync(path.join(stateDir, "identity/device.json"), "{}\\n");
      `("src/infra/device-identity.ts", [{ kind: "legacy store filesystem write", line: 3 }]),
      "allows only the device identity migration owner to retire its legacy source": sourceCase`
        import fs from "node:fs";
        fs.renameSync(
          path.join(stateDir, "identity/device.json"),
          path.join(stateDir, "identity/device.json.doctor-importing"),
        );
      `("src/infra/state-migrations.device-identity.ts", []),
    }),
  )("$name", ({ source, filename, expected }) => {
    const violations = collectDatabaseFirstLegacyStoreViolations(source, filename);

    expect(violations).toEqual(expected);
  });

  it("keeps legacy PortGuardian filenames inside the native migration owner", () => {
    const runtimeViolations = collectDatabaseFirstNativeLegacyStoreViolations(
      'let path = root.appendingPathComponent("port-guard.json")\n',
      "apps/macos/Sources/OpenClaw/PortGuardian.swift",
    );
    const migrationViolations = collectDatabaseFirstNativeLegacyStoreViolations(
      'let path = root.appendingPathComponent("port-guard.json")\n',
      "apps/macos/Sources/OpenClaw/PortGuardianRecordStore.swift",
    );

    expect(runtimeViolations).toEqual([{ kind: "legacy PortGuardian file reference", line: 1 }]);
    expect(migrationViolations).toEqual([]);
  });

  // Doctor, plugin, QA, and transcript owner boundaries.
  it.each(
    namedCases({
      "allows the workspace Doctor migration owner to claim legacy sidecars": sourceCase`
        import { promises as fs } from "node:fs";
        await fs.rename("openclaw-workspace-state.json", "openclaw-workspace-state.json.doctor-importing");
        await fs.rename("workspace.attested", "workspace.attested.doctor-importing");
      `("src/infra/state-migrations.workspace-setup.ts", []),
      "allows plugin doctor migration owners to archive legacy files": sourceCase`
        import { promises as fs } from "node:fs";
        const statePath = "plugin-state/state.sqlite";
        await fs.rename(statePath, "plugin-state/state.sqlite.migrated");
      `("extensions/example/doctor-contract-api.ts", []),
      "flags extension runtime writes under migration-like directories": sourceCase`
        import { promises as fs } from "node:fs";
        await fs.writeFile("sessions.json", "{}\\n", "utf8");
      `("extensions/example/src/migrations/runtime.ts", [
        { kind: "legacy store filesystem write", line: 3 },
      ]),
      "allows exact QA fixture owners to materialize legacy files": sourceCase`
        import { promises as fs } from "node:fs";
        const authStorePath = "auth-profiles.json";
        await fs.writeFile(authStorePath, "{}\\n", "utf8");
      `("extensions/qa-lab/src/providers/shared/auth-store.ts", []),
      "flags legacy transcript bridge markers in runtime source": sourceCase`
        export const transcriptLocator = "sqlite-transcript://session";
        export const dynamicLocator = \`sqlite-transcript://\${sessionId}\`;
      `("src/runtime/transcript-bridge.ts", [
        { kind: "legacy transcript bridge marker", line: 2 },
        { kind: "legacy transcript bridge marker", line: 3 },
      ]),
    }),
  )("$name", ({ source, filename, expected }) => {
    const violations = collectDatabaseFirstLegacyStoreViolations(source, filename);

    expect(violations).toEqual(expected);
  });
});
