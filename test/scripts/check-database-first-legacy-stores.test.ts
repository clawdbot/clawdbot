// Database-first legacy-store guard tests cover runtime state-file regressions.
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectDatabaseFirstLegacyStoreSourceFiles,
  collectDatabaseFirstLegacyStoreViolations,
} from "../../scripts/check-database-first-legacy-stores.mjs";

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

  it("terminates analysis for self-recursive helper wrappers", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        function normalize(value: unknown): unknown {
          if (Array.isArray(value)) {
            return value.map((entry) => normalize(entry));
          }
          return value;
        }
        normalize([]);
      `,
      "src/runtime/self-recursive-helper.ts",
    );

    expect(violations).toEqual([]);
  });

  it("flags runtime writes to legacy sessions.json stores", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        import path from "node:path";
        export async function save(dir: string) {
          await fs.writeFile(path.join(dir, "sessions.json"), "{}\\n", "utf8");
        }
      `,
      "src/runtime/session-writer.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 5 }]);
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

  it("flags legacy restart sentinel references outside the migration owner", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        const legacyPath = path.join(stateDir, "restart-sentinel.json");
        await readFile(legacyPath, "utf8");
      `,
      "src/commands/doctor/state-migrations.ts",
    );

    expect(violations).toEqual([{ kind: "legacy restart sentinel reference", line: 2 }]);
  });

  it("allows the CLI preflight to detect exact legacy restart sentinel inputs", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        [
          path.join(stateDir, "restart-sentinel.json"),
          path.join(stateDir, "restart-sentinel.json.doctor-importing"),
        ].some(fileOrDirExists);
      `,
      "src/cli/program/config-guard.ts",
    );

    expect(violations).toEqual([]);
  });

  it("flags direct legacy restart sentinel reads from the CLI preflight", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        await readFile(path.join(stateDir, "restart-sentinel.json"), "utf8");
        await readFile(path.join(stateDir, "restart-sentinel.json.doctor-importing"), "utf8");
      `,
      "src/cli/program/config-guard.ts",
    );

    expect(violations).toEqual([
      { kind: "legacy restart sentinel reference", line: 2 },
      { kind: "legacy restart sentinel reference", line: 3 },
    ]);
  });

  it("flags nested restart sentinel paths disguised as CLI preflight detection", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        [path.join(stateDir, "archive/restart-sentinel.json")].some(fileOrDirExists);
      `,
      "src/cli/program/config-guard.ts",
    );

    expect(violations).toEqual([{ kind: "legacy restart sentinel reference", line: 2 }]);
  });

  it("flags retired Diffs viewer sidecar writes", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        import path from "node:path";
        await fs.writeFile(path.join(root, id, "viewer.html"), html);
        await fs.writeFile(path.join(root, id, "meta.json"), metadata);
        await fs.writeFile(path.join(root, id, "file-meta.json"), metadata);
      `,
      "extensions/diffs/src/legacy-store.ts",
    );

    expect(violations).toEqual([
      { kind: "legacy store filesystem write", line: 4 },
      { kind: "legacy store filesystem write", line: 5 },
      { kind: "legacy store filesystem write", line: 6 },
    ]);
  });

  it("flags retired QMD file-lock sidecars", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { withFileLock } from "openclaw/plugin-sdk/file-lock";
        import path from "node:path";
        await withFileLock(path.join(stateDir, "qmd", "embed.lock"), options, task);
        await withFileLock(path.join(agentDir, "qmd-write.lock"), options, task);
      `,
      "extensions/memory-core/src/memory/qmd-locks.ts",
    );

    expect(violations).toEqual([
      { kind: "legacy store filesystem write", line: 4 },
      { kind: "legacy store filesystem write", line: 5 },
    ]);
  });

  it("flags writes through local variables initialized from legacy store paths", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        import path from "node:path";
        export async function save(dir: string) {
          const storePath = path.join(dir, "sessions.json");
          await fs.writeFile(storePath, "{}\\n", "utf8");
        }
      `,
      "src/runtime/session-writer.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 6 }]);
  });

  it("flags writes through property access on legacy path variables", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        const storePath = "sessions.json";
        await writeTextAtomic(storePath.toString(), "{}\\n");
      `,
      "src/runtime/legacy-path-property-access.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 4 }]);
  });

  it("flags legacy paths split across path.join segments", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        import path from "node:path";
        await fs.writeFile(path.join(stateDir, "cron", "jobs.json"), "{}\\n", "utf8");
        const sidecarPath = path.join(root, "plugin-state", "state.sqlite");
        await fs.writeFile(sidecarPath, "");
      `,
      "src/runtime/legacy-state.ts",
    );

    expect(violations).toEqual([
      { kind: "legacy store filesystem write", line: 4 },
      { kind: "legacy store filesystem write", line: 6 },
    ]);
  });

  it("flags runtime writes to the retired TUI last-session store", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        import path from "node:path";
        await fs.writeFile(path.join(stateDir, "tui", "last-session.json"), "{}\\n");
      `,
      "src/tui/last-session-writer.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 4 }]);
  });

  it("flags runtime writes to the retired commitments JSON store", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        import path from "node:path";
        await fs.writeFile(path.join(stateDir, "commitments", "commitments.json"), "{}\\n");
      `,
      "src/commitments/file-store.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 4 }]);
  });

  it("flags runtime writes to retired managed-image record JSON", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        import path from "node:path";
        await fs.writeFile(path.join(stateDir, "media", "outgoing", "records", \`\${id}.json\`), "{}\n");
      `,
      "src/gateway/managed-image-file-store.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 4 }]);
  });

  it("flags runtime writes to retired Web Push JSON stores", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        import path from "node:path";
        await fs.writeFile(path.join(stateDir, "push", "web-push-subscriptions.json"), "{}\n");
        await fs.writeFile(path.join(stateDir, "push", "vapid-keys.json"), "{}\n");
      `,
      "src/infra/push-web-file-store.ts",
    );

    expect(violations).toEqual([
      { kind: "legacy store filesystem write", line: 4 },
      { kind: "legacy store filesystem write", line: 6 },
    ]);
  });

  it("flags runtime writes to the retired APNs registration store", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        import path from "node:path";
        await fs.writeFile(path.join(stateDir, "push", "apns-registrations.json"), "{}\n");
      `,
      "src/infra/push-apns-file-store.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 4 }]);
  });

  it("flags runtime writes to the retired node-host JSON config", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        import path from "node:path";
        await fs.writeFile(path.join(stateDir, "node.json"), "{}\n");
      `,
      "src/node-host/config-file-store.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 4 }]);
  });

  it("flags runtime writes to retired workspace setup and attestation sidecars", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        import path from "node:path";
        await fs.writeFile(path.join(workspaceDir, "openclaw-workspace-state.json"), "{}\\n");
        await fs.writeFile(path.join(workspaceDir, ".openclaw", "workspace-state.json"), "{}\\n");
        await fs.writeFile(path.join(stateDir, "workspace-attestations", \`\${workspaceKey}.attested\`), "ok\\n");
        await fs.writeFile(\`\${workspaceDir}.attested\`, "ok\\n");
      `,
      "src/agents/workspace-sidecar-store.ts",
    );

    expect(violations).toEqual([
      { kind: "legacy store filesystem write", line: 4 },
      { kind: "legacy store filesystem write", line: 5 },
      { kind: "legacy store filesystem write", line: 6 },
      { kind: "legacy store filesystem write", line: 7 },
    ]);
  });

  it("flags runtime writes to the retired native hook relay JSON registry", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        import path from "node:path";
        await fs.writeFile(path.join("/tmp", "openclaw-native-hook-relays-501", "relay.json"), "{}\n");
      `,
      "src/agents/harness/native-hook-relay-file-store.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 4 }]);
  });

  it("flags runtime writes to the retired subagent JSON registry", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        import path from "node:path";
        await fs.writeFile(path.join(stateDir, "subagents", "runs.json"), "{}\n");
      `,
      "src/agents/subagent-registry-file-store.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 4 }]);
  });

  it("flags runtime writes to retired skill-upload staging", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        import path from "node:path";
        await fs.writeFile(path.join(stateDir, "tmp", "skill-uploads", uploadId, "metadata.json"), "{}\n");
      `,
      "src/skills/lifecycle/upload-file-store.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 4 }]);
  });

  it("flags runtime writes to retired system-agent rescue approval stores", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        import path from "node:path";
        await fs.writeFile(path.join(stateDir, "openclaw", "rescue-pending", \`\${key}.json\`), "{}\\n");
        await fs.writeFile(path.join(stateDir, "crestodian", "rescue-pending", "old.json"), "{}\\n");
      `,
      "src/system-agent/rescue-writer.ts",
    );

    expect(violations).toEqual([
      { kind: "legacy store filesystem write", line: 4 },
      { kind: "legacy store filesystem write", line: 5 },
    ]);
  });

  it("flags legacy paths with dynamic agent id segments", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        import path from "node:path";
        await fs.writeFile(path.join(stateDir, "agents", agentId, "agent", "auth.json"), "{}\\n");
      `,
      "src/runtime/dynamic-agent-auth.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 4 }]);
  });

  it("flags legacy paths with dynamic segments and constant filenames", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        import path from "node:path";
        const AUTH_FILE = "auth.json";
        await fs.writeFile(path.join(stateDir, "agents", agentId, "agent", AUTH_FILE), "{}\\n");
      `,
      "src/runtime/dynamic-agent-auth-constant.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 5 }]);
  });

  it("flags legacy JSONL paths with dynamic template filenames", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        import path from "node:path";
        await fs.appendFile(path.join(stateDir, "cron", "runs", \`\${runId}.jsonl\`), "{}\\n");
      `,
      "src/runtime/dynamic-cron-run.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 4 }]);
  });

  it("flags legacy paths assembled from filename constants", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        import path from "node:path";
        const STORE_FILE = "sessions.json";
        const JOBS_FILE = "jobs.json";
        const SQLITE_FILE = "state.sqlite";
        const storePath = path.join(dir, STORE_FILE);
        await fs.writeFile(storePath, "{}\\n", "utf8");
        await fs.writeFile(path.join(stateDir, "cron", JOBS_FILE), "{}\\n");
        await fs.writeFile(path.join(stateDir, "plugin-state", SQLITE_FILE), "");
      `,
      "src/runtime/constant-session-store.ts",
    );

    expect(violations).toEqual([
      { kind: "legacy store filesystem write", line: 8 },
      { kind: "legacy store filesystem write", line: 9 },
      { kind: "legacy store filesystem write", line: 10 },
    ]);
  });

  it("flags legacy paths assembled from template literal constants", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        const sessionBase = "sessions";
        const cronRuns = "cron/runs";
        await fs.writeFile(\`\${sessionBase}.json\`, "{}\\n");
        await fs.appendFile(\`\${cronRuns}/job.jsonl\`, "{}\\n");
      `,
      "src/runtime/template-constant-legacy-store.ts",
    );

    expect(violations).toEqual([
      { kind: "legacy store filesystem write", line: 5 },
      { kind: "legacy store filesystem write", line: 6 },
    ]);
  });

  it("does not leak conditional literal path constants", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        import path from "node:path";
        const JOBS_FILE = "current.json";
        if (debug) {
          const JOBS_FILE = "jobs.json";
          console.log(JOBS_FILE);
        }
        await fs.writeFile(path.join(stateDir, "cron", JOBS_FILE), "{}\\n");
      `,
      "src/runtime/conditional-literal-shadow.ts",
    );

    expect(violations).toEqual([]);
  });

  it("keeps conditional literal reassignment candidates", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        import path from "node:path";
        let JOBS_FILE = "current.json";
        if (debug) {
          JOBS_FILE = "jobs.json";
        }
        await fs.writeFile(path.join(stateDir, "cron", JOBS_FILE), "{}\\n");
      `,
      "src/runtime/conditional-literal-reassignment.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 8 }]);
  });

  it("keeps known literal candidates when conditional reassignment is dynamic", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        import path from "node:path";
        let JOBS_FILE = "jobs.json";
        if (debug) {
          JOBS_FILE = getJobsFile();
        }
        await fs.writeFile(path.join(stateDir, "cron", JOBS_FILE), "{}\\n");
      `,
      "src/runtime/conditional-dynamic-literal-reassignment.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 8 }]);
  });

  it("drops stale literal candidates after exhaustive branch reassignment", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        import path from "node:path";
        let JOBS_FILE = "jobs.json";
        if (debug) {
          JOBS_FILE = "current.json";
        } else {
          JOBS_FILE = "active.json";
        }
        await fs.writeFile(path.join(stateDir, "cron", JOBS_FILE), "{}\\n");
      `,
      "src/runtime/exhaustive-literal-reassignment.ts",
    );

    expect(violations).toEqual([]);
  });

  it("keeps known literal candidates after exhaustive dynamic branch reassignment", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        import path from "node:path";
        let JOBS_FILE = "current.json";
        if (debug) {
          JOBS_FILE = "jobs.json";
        } else {
          JOBS_FILE = getJobsFile();
        }
        await fs.writeFile(path.join(stateDir, "cron", JOBS_FILE), "{}\\n");
      `,
      "src/runtime/exhaustive-dynamic-literal-reassignment.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 10 }]);
  });

  it("drops stale literal candidates after exhaustive dynamic branch reassignment", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        import path from "node:path";
        let JOBS_FILE = "jobs.json";
        if (debug) {
          JOBS_FILE = "current.json";
        } else {
          JOBS_FILE = getJobsFile();
        }
        await fs.writeFile(path.join(stateDir, "cron", JOBS_FILE), "{}\\n");
      `,
      "src/runtime/exhaustive-dynamic-stale-literal-reassignment.ts",
    );

    expect(violations).toEqual([]);
  });

  it("flags imported and destructured fs write aliases", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import fs, { writeFile as persist } from "node:fs/promises";
        const { appendFile: append } = fs;
        await persist("sessions.json", "{}\\n", "utf8");
        await append("cron/runs/job.jsonl", "{}\\n");
      `,
      "src/runtime/aliased-fs.ts",
    );

    expect(violations).toEqual([
      { kind: "legacy store filesystem write", line: 4 },
      { kind: "legacy store filesystem write", line: 5 },
    ]);
  });

  it("flags helper writes through namespace imports", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import * as jsonFiles from "../infra/json-files.js";
        await jsonFiles.writeJson("sessions.json", {});
      `,
      "src/runtime/helper-namespace-write.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 3 }]);
  });

  it("flags private file store writes to legacy paths", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { privateFileStore } from "openclaw/plugin-sdk/security-runtime";
        await privateFileStore(stateDir).writeJson("thread-bindings.json", {});
      `,
      "src/runtime/private-file-store-write.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 3 }]);
  });

  it("flags fs-safe factory aliases writing legacy paths", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { privateFileStore } from "openclaw/plugin-sdk/security-runtime";
        import * as fsSafe from "openclaw/plugin-sdk/security-runtime";
        const makePrivateStore = privateFileStore;
        const makeRoot = fsSafe.root;
        const { privateFileStore: makeFromNamespace } = fsSafe;
        await makePrivateStore(stateDir).writeJson("thread-bindings.json", {});
        await (await makeRoot(stateDir)).writeJson("plugin-binding-approvals.json", {});
        await makeFromNamespace(stateDir).writeJson("gateway-restart-intent.json", {});
      `,
      "src/runtime/fs-safe-factory-alias-write.ts",
    );

    expect(violations).toEqual([
      { kind: "legacy store filesystem write", line: 7 },
      { kind: "legacy store filesystem write", line: 8 },
      { kind: "legacy store filesystem write", line: 9 },
    ]);
  });

  it("flags fs-safe root writes to legacy paths", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { root } from "openclaw/plugin-sdk/security-runtime";
        const state = await root(stateDir);
        await state.writeJson("plugin-binding-approvals.json", {});
        await (await root(stateDir)).writeJson("thread-bindings.json", {});
      `,
      "src/runtime/fs-safe-root-write.ts",
    );

    expect(violations).toEqual([
      { kind: "legacy store filesystem write", line: 4 },
      { kind: "legacy store filesystem write", line: 5 },
    ]);
  });

  it("flags bare fs-safe package root writes to legacy paths", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { root } from "@openclaw/fs-safe";
        const state = await root(stateDir);
        await state.writeJson("thread-bindings.json", {});
      `,
      "src/runtime/bare-fs-safe-root-write.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 4 }]);
  });

  it("flags file access runtime root writes to legacy paths", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { root } from "openclaw/plugin-sdk/file-access-runtime";
        const state = await root(stateDir);
        await state.writeJson("thread-bindings.json", {});
      `,
      "extensions/example/src/runtime/file-access-root-write.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 4 }]);
  });

  it("flags fs-safe store root writes to legacy paths", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { privateFileStore } from "openclaw/plugin-sdk/security-runtime";
        const state = await privateFileStore(stateDir).root();
        await state.writeJson("thread-bindings.json", {});
        await (await privateFileStore(stateDir).root()).writeJson("plugin-binding-approvals.json", {});
      `,
      "src/runtime/fs-safe-store-root-write.ts",
    );

    expect(violations).toEqual([
      { kind: "legacy store filesystem write", line: 4 },
      { kind: "legacy store filesystem write", line: 5 },
    ]);
  });

  it("allows fs-safe store reads from legacy paths", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { privateFileStore } from "openclaw/plugin-sdk/security-runtime";
        const store = privateFileStore(stateDir);
        await store.readJson("thread-bindings.json");
      `,
      "src/runtime/private-file-store-read.ts",
    );

    expect(violations).toEqual([]);
  });

  it("flags fs-safe JSON store writes to legacy paths", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { privateFileStore } from "openclaw/plugin-sdk/security-runtime";
        await privateFileStore(stateDir).json("thread-bindings.json").write({});
        const bindings = privateFileStore(stateDir).json("plugin-binding-approvals.json");
        await bindings.update((current) => current ?? {});
        await privateFileStore(stateDir).json("gateway-restart-intent.json").updateOr({}, (current) => current);
      `,
      "src/runtime/private-file-json-store-write.ts",
    );

    expect(violations).toEqual([
      { kind: "legacy store filesystem write", line: 3 },
      { kind: "legacy store filesystem write", line: 5 },
      { kind: "legacy store filesystem write", line: 6 },
    ]);
  });

  it("flags direct fs-safe package store writes to legacy paths", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { fileStore, jsonStore } from "@openclaw/fs-safe/store";
        await fileStore({ rootDir: stateDir }).writeJson("thread-bindings.json", {});
        const options = { filePath: "plugin-binding-approvals.json" };
        await jsonStore(options).write({});
        await jsonStore({ filePath: "gateway-restart-intent.json" }).update((current) => current ?? {});
      `,
      "src/runtime/direct-fs-safe-store-write.ts",
    );

    expect(violations).toEqual([
      { kind: "legacy store filesystem write", line: 3 },
      { kind: "legacy store filesystem write", line: 5 },
      { kind: "legacy store filesystem write", line: 6 },
    ]);
  });

  it("flags fs-safe store object aliases writing legacy paths", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/fs-safe-store-object-alias-write.ts",
    );

    expect(violations).toEqual([
      { kind: "legacy store filesystem write", line: 8 },
      { kind: "legacy store filesystem write", line: 9 },
      { kind: "legacy store filesystem write", line: 13 },
    ]);
  });

  it("flags fs-safe store object aliases copied through spreads and nested objects", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { privateFileStore } from "openclaw/plugin-sdk/security-runtime";
        const base = { state: privateFileStore(stateDir) };
        const stores = { ...base };
        const nested = { inner: { bindings: privateFileStore(stateDir).json("plugin-binding-approvals.json") } };
        await stores.state.writeJson("thread-bindings.json", {});
        await nested.inner.bindings.write({});
      `,
      "src/runtime/fs-safe-store-spread-object-alias-write.ts",
    );

    expect(violations).toEqual([
      { kind: "legacy store filesystem write", line: 6 },
      { kind: "legacy store filesystem write", line: 7 },
    ]);
  });

  it("flags fs-safe store object aliases assigned through nested object properties", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { privateFileStore } from "openclaw/plugin-sdk/security-runtime";
        const stores = {};
        stores.inner = { bindings: privateFileStore(stateDir).json("thread-bindings.json") };
        await stores.inner.bindings.write({});
      `,
      "src/runtime/assigned-nested-fs-safe-store-object-alias.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 5 }]);
  });

  it("flags fs-safe store object aliases copied through destructuring", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { privateFileStore } from "openclaw/plugin-sdk/security-runtime";
        const stores = { state: privateFileStore(stateDir) };
        const nested = { inner: { bindings: privateFileStore(stateDir).json("plugin-binding-approvals.json") } };
        const { state } = stores;
        const { inner: { bindings } } = nested;
        await state.writeJson("thread-bindings.json", {});
        await bindings.write({});
      `,
      "src/runtime/fs-safe-store-destructured-object-alias-write.ts",
    );

    expect(violations).toEqual([
      { kind: "legacy store filesystem write", line: 7 },
      { kind: "legacy store filesystem write", line: 8 },
    ]);
  });

  it("clears fs-safe store object aliases after exhaustive property reassignment", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { privateFileStore } from "openclaw/plugin-sdk/security-runtime";
        const stores = { state: privateFileStore(stateDir) };
        if (flag) {
          stores.state = customA;
        } else {
          stores.state = customB;
        }
        await stores.state.writeJson("thread-bindings.json", {});
      `,
      "src/runtime/exhaustive-fs-safe-store-property-reassignment.ts",
    );

    expect(violations).toEqual([]);
  });

  it("clears nested fs-safe store object aliases after exhaustive property reassignment", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { privateFileStore } from "openclaw/plugin-sdk/security-runtime";
        const stores = { inner: { bindings: privateFileStore(stateDir).json("thread-bindings.json") } };
        if (flag) {
          stores.inner = { bindings: customA };
        } else {
          stores.inner = { bindings: customB };
        }
        await stores.inner.bindings.write({});
      `,
      "src/runtime/exhaustive-nested-fs-safe-store-property-reassignment.ts",
    );

    expect(violations).toEqual([]);
  });

  it("keeps fs-safe store object aliases when one exhaustive property branch remains a store", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { privateFileStore } from "openclaw/plugin-sdk/security-runtime";
        const stores = { state: customStore };
        if (flag) {
          stores.state = customA;
        } else {
          stores.state = privateFileStore(stateDir);
        }
        await stores.state.writeJson("thread-bindings.json", {});
      `,
      "src/runtime/exhaustive-fs-safe-store-property-partial-reassignment.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 9 }]);
  });

  it("flags direct fs-safe package namespace store writes to legacy paths", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import * as fsSafeStore from "@openclaw/fs-safe/store";
        const store = fsSafeStore.fileStoreSync({ rootDir: stateDir });
        store.writeJson("thread-bindings.json", {});
        const bindings = fsSafeStore.jsonStore({ filePath: "plugin-binding-approvals.json" });
        await bindings.write({});
      `,
      "src/runtime/direct-fs-safe-store-namespace-write.ts",
    );

    expect(violations).toEqual([
      { kind: "legacy store filesystem write", line: 4 },
      { kind: "legacy store filesystem write", line: 6 },
    ]);
  });

  it("allows fs-safe JSON store reads from legacy paths", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { privateFileStore } from "openclaw/plugin-sdk/security-runtime";
        const bindings = privateFileStore(stateDir).json("thread-bindings.json");
        await bindings.read();
        await privateFileStore(stateDir).json("plugin-binding-approvals.json").readOr({});
      `,
      "src/runtime/private-file-json-store-read.ts",
    );

    expect(violations).toEqual([]);
  });

  it("clears fs-safe store aliases after exhaustive non-store reassignment", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { privateFileStore } from "openclaw/plugin-sdk/security-runtime";
        let store = privateFileStore(stateDir);
        if (flag) {
          store = customA;
        } else {
          store = customB;
        }
        await store.writeJson("thread-bindings.json", {});
      `,
      "src/runtime/exhaustive-fs-safe-store-reassignment.ts",
    );

    expect(violations).toEqual([]);
  });

  it("keeps fs-safe store aliases when one exhaustive branch remains a store", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { privateFileStore } from "openclaw/plugin-sdk/security-runtime";
        let store = customStore;
        if (flag) {
          store = customA;
        } else {
          store = privateFileStore(stateDir);
        }
        await store.writeJson("thread-bindings.json", {});
      `,
      "src/runtime/exhaustive-fs-safe-store-partial-reassignment.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 9 }]);
  });

  it("clears fs-safe namespace factory aliases after shadowing", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import * as fsSafe from "openclaw/plugin-sdk/security-runtime";
        async function save(fsSafe: { root(dir: string): Promise<{ writeJson(path: string): void }> }) {
          await (await fsSafe.root(stateDir)).writeJson("thread-bindings.json");
        }
      `,
      "src/runtime/fs-safe-namespace-shadow.ts",
    );

    expect(violations).toEqual([]);
  });

  it("ignores helper-like namespace imports from unrelated modules", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import * as runtime from "../runtime/json-output.js";
        runtime.writeJson("sessions.json", {});
      `,
      "src/runtime/unrelated-helper-namespace.ts",
    );

    expect(violations).toEqual([]);
  });

  it("ignores helper-like named imports from unrelated modules", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeJson } from "../runtime/json-output.js";
        writeJson("sessions.json", {});
      `,
      "src/runtime/unrelated-helper-named-import.ts",
    );

    expect(violations).toEqual([]);
  });

  it("clears namespace helper aliases after shadowing", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import * as jsonFiles from "../infra/json-files.js";
        function save(jsonFiles: { writeJson(path: string, value: unknown): void }) {
          jsonFiles.writeJson("sessions.json", {});
        }
        save(customJsonFiles);
      `,
      "src/runtime/helper-namespace-shadow.ts",
    );

    expect(violations).toEqual([]);
  });

  it("allows read-only fs open calls and flags write modes", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import fs from "node:fs/promises";
        await fs.open("sessions.json");
        await fs.open("sessions.json", "r");
        await fs.open("sessions.json", "r+");
        await fs.open("sessions.json", "w");
      `,
      "src/runtime/open-flags.ts",
    );

    expect(violations).toEqual([
      { kind: "legacy store filesystem write", line: 5 },
      { kind: "legacy store filesystem write", line: 6 },
    ]);
  });

  it("flags fs copy calls writing legacy store paths", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import fs from "node:fs/promises";
        import syncFs from "node:fs";
        await fs.cp("source.json", "sessions.json");
        syncFs.cpSync("source.json", "cron/jobs.json");
      `,
      "src/runtime/fs-copy-legacy-store.ts",
    );

    expect(violations).toEqual([
      { kind: "legacy store filesystem write", line: 4 },
      { kind: "legacy store filesystem write", line: 5 },
    ]);
  });

  it("allows fs copy calls reading from legacy store paths", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import fs from "node:fs/promises";
        import syncFs from "node:fs";
        await fs.copyFile("sessions.json", "state/openclaw.sqlite.import");
        await fs.cp("cron/jobs.json", "state/openclaw.sqlite.import");
        syncFs.copyFileSync("auth-profiles.json", "state/openclaw.sqlite.import");
        syncFs.cpSync("cache/models.json", "state/openclaw.sqlite.import");
      `,
      "src/runtime/fs-copy-legacy-store-source.ts",
    );

    expect(violations).toEqual([]);
  });

  it("flags fs removal calls targeting legacy store paths", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import fs from "node:fs/promises";
        import syncFs from "node:fs";
        await fs.rm("sessions.json", { force: true });
        syncFs.unlinkSync("cron/jobs.json");
      `,
      "src/runtime/fs-remove-legacy-store.ts",
    );

    expect(violations).toEqual([
      { kind: "legacy store filesystem write", line: 4 },
      { kind: "legacy store filesystem write", line: 5 },
    ]);
  });

  it("flags legacy paths destructured from for-of tuple entries", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import path from "node:path";
        import { root as fsRoot } from "openclaw/plugin-sdk/security-runtime";
        const CLAIMS_DIGEST_PATH = ".openclaw-wiki/cache/claims.jsonl";
        const claimsDigestPath = path.join(rootDir, CLAIMS_DIGEST_PATH);
        for (const [filePath, content] of [[claimsDigestPath, claimsDigest]]) {
          const relativePath = path.relative(rootDir, filePath);
          const root = await fsRoot(rootDir);
          await root.write(relativePath, content);
        }
      `,
      "src/runtime/for-of-destructured-legacy-path.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 9 }]);
  });

  it("applies open write-mode checks inside wrappers", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import fs from "node:fs/promises";
        function read(path: string) {
          return fs.open(path, "r");
        }
        function write(path: string) {
          return fs.open(path, "w");
        }
        await read("sessions.json");
        await write("sessions.json");
      `,
      "src/runtime/open-wrapper-flags.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 10 }]);
  });

  it("flags string-literal fs write aliases from destructuring", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import fs from "node:fs/promises";
        const { "writeFile": persist } = fs;
        await persist("sessions.json", "{}\\n", "utf8");
      `,
      "src/runtime/string-literal-fs-alias.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 4 }]);
  });

  it("flags CommonJS fs write aliases", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        const fs = require("node:fs");
        const { appendFileSync } = require("node:fs");
        fs.writeFileSync("sessions.json", "{}\\n");
        appendFileSync("cron/runs/job.jsonl", "{}\\n");
      `,
      "src/runtime/commonjs-fs-aliases.ts",
    );

    expect(violations).toEqual([
      { kind: "legacy store filesystem write", line: 4 },
      { kind: "legacy store filesystem write", line: 5 },
    ]);
  });

  it("does not treat local require bindings as CommonJS fs", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        function save(require: (specifier: string) => { writeFileSync(path: string, value: string): void }) {
          const fs = require("node:fs");
          fs.writeFileSync("sessions.json", "");
        }
        save(customRequire);
      `,
      "src/runtime/local-require-binding.ts",
    );

    expect(violations).toEqual([]);
  });

  it("flags createRequire-backed CommonJS fs writes", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { createRequire } from "node:module";
        const require = createRequire(import.meta.url);
        const fs = require("node:fs");
        fs.writeFileSync("sessions.json", "{}\\n");
      `,
      "src/runtime/create-require-fs.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 5 }]);
  });

  it("flags createRequire alias-backed CommonJS fs writes", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { createRequire } from "node:module";
        const req = createRequire(import.meta.url);
        const fs = req("node:fs");
        fs.writeFileSync("sessions.json", "{}\\n");
      `,
      "src/runtime/create-require-alias-fs.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 5 }]);
  });

  it("flags copied createRequire alias-backed CommonJS fs writes", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { createRequire } from "node:module";
        const req = createRequire(import.meta.url);
        const req2 = req;
        const fs = req2("node:fs");
        fs.writeFileSync("sessions.json", "{}\\n");
      `,
      "src/runtime/copied-create-require-alias-fs.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 6 }]);
  });

  it("flags reassigned createRequire alias-backed CommonJS fs writes", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { createRequire } from "node:module";
        let req;
        req = createRequire(import.meta.url);
        const fs = req("node:fs");
        fs.writeFileSync("sessions.json", "{}\\n");
      `,
      "src/runtime/reassigned-create-require-alias-fs.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 6 }]);
  });

  it("flags reassigned createRequire aliases named require", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { createRequire } from "node:module";
        let require;
        require = createRequire(import.meta.url);
        const fs = require("node:fs");
        fs.writeFileSync("sessions.json", "{}\\n");
      `,
      "src/runtime/reassigned-create-require-name.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 6 }]);
  });

  it("refreshes hoisted wrappers after createRequire alias reassignment", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { createRequire } from "node:module";
        let req;
        function persist(filePath: string) {
          const fs = req("node:fs");
          fs.writeFileSync(filePath, "{}\\n");
        }
        req = createRequire(import.meta.url);
        persist("sessions.json");
      `,
      "src/runtime/hoisted-wrapper-reassigned-create-require-alias.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 9 }]);
  });

  it("refreshes hoisted wrappers after nested createRequire alias reassignment", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/hoisted-wrapper-nested-create-require-alias.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 11 }]);
  });

  it("refreshes block-scoped wrappers after nested outer createRequire alias reassignment", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/block-wrapper-nested-create-require-alias.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 12 }]);
  });

  it("refreshes escaped wrappers after outer createRequire alias reassignment", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/escaped-wrapper-create-require-alias.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 13 }]);
  });

  it("keeps escaped wrapper local require shadows after outer createRequire alias reassignment", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/escaped-wrapper-local-require-shadow.ts",
    );

    expect(violations).toEqual([]);
  });

  it("does not treat parameter shadows as createRequire aliases", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { createRequire } from "node:module";
        const req = createRequire(import.meta.url);
        function save(req: (specifier: string) => { writeFileSync(path: string, value: string): void }) {
          const fs = req("node:fs");
          fs.writeFileSync("sessions.json", "");
        }
        save(customRequire);
      `,
      "src/runtime/create-require-parameter-shadow.ts",
    );

    expect(violations).toEqual([]);
  });

  it("does not treat shadowed createRequire bindings as Node require", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { createRequire } from "node:module";
        function save(createRequire: (url: string) => (specifier: string) => { writeFileSync(path: string, value: string): void }) {
          const require = createRequire("custom");
          const fs = require("node:fs");
          fs.writeFileSync("sessions.json", "");
        }
        save(customCreateRequire);
      `,
      "src/runtime/shadowed-create-require.ts",
    );

    expect(violations).toEqual([]);
  });

  it("does not treat hoisted function createRequire shadows as Node require", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/hoisted-create-require-shadow.ts",
    );

    expect(violations).toEqual([]);
  });

  it("flags CommonJS fs promises aliases", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        const { promises: fs } = require("node:fs");
        const { promises } = require("node:fs");
        await fs.writeFile("sessions.json", "{}\\n");
        await promises.appendFile("cron/runs/job.jsonl", "{}\\n");
      `,
      "src/runtime/commonjs-fs-promises-aliases.ts",
    );

    expect(violations).toEqual([
      { kind: "legacy store filesystem write", line: 4 },
      { kind: "legacy store filesystem write", line: 5 },
    ]);
  });

  it("flags nested CommonJS fs promises write aliases", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        const { promises: { writeFile } } = require("node:fs");
        await writeFile("sessions.json", "{}\\n");
      `,
      "src/runtime/nested-commonjs-fs-promises-alias.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 3 }]);
  });

  it("flags inline CommonJS fs writes", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        require("node:fs").writeFileSync("sessions.json", "{}\\n");
        require("node:fs").promises.writeFile("cron/jobs.json", "{}\\n");
      `,
      "src/runtime/inline-commonjs-fs-write.ts",
    );

    expect(violations).toEqual([
      { kind: "legacy store filesystem write", line: 2 },
      { kind: "legacy store filesystem write", line: 3 },
    ]);
  });

  it("flags bracketed fs writes", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import fs from "node:fs";
        await fs["writeFile"]("sessions.json", "{}\\n");
        await fs.promises["writeFile"]("cron/runs/job.jsonl", "{}\\n");
        require("node:fs")["writeFileSync"]("sessions.json", "{}\\n");
      `,
      "src/runtime/bracketed-fs-writes.ts",
    );

    expect(violations).toEqual([
      { kind: "legacy store filesystem write", line: 3 },
      { kind: "legacy store filesystem write", line: 4 },
      { kind: "legacy store filesystem write", line: 5 },
    ]);
  });

  it("flags dynamic fs import writes", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        const fs = await import("node:fs/promises");
        const nodeFs = await import("node:fs");
        await fs.writeFile("sessions.json", "{}\\n");
        await nodeFs.promises.appendFile("cron/runs/job.jsonl", "{}\\n");
      `,
      "src/runtime/dynamic-fs-import-write.ts",
    );

    expect(violations).toEqual([
      { kind: "legacy store filesystem write", line: 4 },
      { kind: "legacy store filesystem write", line: 5 },
    ]);
  });

  it("flags dynamic fs import write aliases", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        const { writeFile } = await import("node:fs/promises");
        const { promises } = await import("node:fs");
        await writeFile("sessions.json", "{}\\n");
        await promises.appendFile("cron/runs/job.jsonl", "{}\\n");
      `,
      "src/runtime/dynamic-fs-import-aliases.ts",
    );

    expect(violations).toEqual([
      { kind: "legacy store filesystem write", line: 4 },
      { kind: "legacy store filesystem write", line: 5 },
    ]);
  });

  it("flags dynamic fs import promise callback writes", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        await import("node:fs/promises").then((fs) =>
          fs.writeFile("sessions.json", "{}\\n"),
        );
      `,
      "src/runtime/dynamic-fs-import-promise-callback.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 3 }]);
  });

  it("flags destructured dynamic fs import promise callback writes", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        await import("node:fs/promises").then(({ writeFile }) =>
          writeFile("sessions.json", "{}\\n"),
        );
        await import("node:fs").then(({ promises }) =>
          promises.appendFile("cron/runs/job.jsonl", "{}\\n"),
        );
        await import("node:fs").then(({ promises: { writeFile: persist } }) =>
          persist("sessions.json", "{}\\n"),
        );
      `,
      "src/runtime/destructured-dynamic-fs-import-promise-callback.ts",
    );

    expect(violations).toEqual([
      { kind: "legacy store filesystem write", line: 3 },
      { kind: "legacy store filesystem write", line: 6 },
      { kind: "legacy store filesystem write", line: 9 },
    ]);
  });

  it("flags write aliases destructured from fs.promises", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import * as fs from "node:fs";
        const { writeFile: persist } = fs.promises;
        const fsp = fs.promises;
        const { appendFile } = fsp;
        await persist("sessions.json", "{}\\n", "utf8");
        await appendFile("cron/runs/job.jsonl", "{}\\n");
      `,
      "src/runtime/fs-promises-aliases.ts",
    );

    expect(violations).toEqual([
      { kind: "legacy store filesystem write", line: 6 },
      { kind: "legacy store filesystem write", line: 7 },
    ]);
  });

  it("flags fs write method aliases", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import fs from "node:fs/promises";
        const persist = fs.writeFile;
        await persist("sessions.json", "{}\\n");
      `,
      "src/runtime/fs-write-method-alias.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 4 }]);
  });

  it("flags write aliases destructured from local fs module aliases", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import fs from "node:fs/promises";
        {
          const storage = fs;
          const { writeFile } = storage;
          await writeFile("sessions.json", "{}\\n");
        }
      `,
      "src/runtime/local-fs-module-alias.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 6 }]);
  });

  it("flags nested write aliases destructured from local fs module aliases", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        const nodeFs = require("node:fs");
        const { promises: { writeFile } } = nodeFs;
        await writeFile("sessions.json", "{}\\n");
      `,
      "src/runtime/nested-local-fs-module-alias.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 4 }]);
  });

  it("clears fs module aliases after reassignment", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import fs from "node:fs/promises";
        let writer = fs;
        writer = customWriter;
        await writer.writeFile("sessions.json", "{}\\n");
      `,
      "src/runtime/reassigned-fs-module-alias.ts",
    );

    expect(violations).toEqual([]);
  });

  it("uses branch-local fs module aliases after conditional assignment", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import fs from "node:fs/promises";
        let writer;
        if (ready) {
          writer = fs;
          await writer.writeFile("sessions.json", "{}\\n");
        }
      `,
      "src/runtime/conditional-fs-module-alias.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 6 }]);
  });

  it("keeps fs module aliases after conditional assignment", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import fs from "node:fs/promises";
        let writer;
        if (ready) {
          writer = fs;
        }
        await writer.writeFile("sessions.json", "{}\\n");
      `,
      "src/runtime/conditional-retained-fs-module-alias.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 7 }]);
  });

  it("keeps fs write aliases after conditional assignment", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import fs from "node:fs/promises";
        let persist;
        if (ready) {
          persist = fs.writeFile;
        }
        await persist("sessions.json", "{}\\n");
      `,
      "src/runtime/conditional-retained-fs-write-alias.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 7 }]);
  });

  it("clears fs module aliases after exhaustive conditional reassignment", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import fs from "node:fs/promises";
        let writer = fs;
        if (ready) {
          writer = customWriter;
        } else {
          writer = otherWriter;
        }
        await writer.writeFile("sessions.json", "{}\\n");
      `,
      "src/runtime/exhaustive-reassigned-fs-module-alias.ts",
    );

    expect(violations).toEqual([]);
  });

  it("keeps uninitialized fs aliases assigned from nested blocks", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import fs from "node:fs/promises";
        let writer;
        let persist;
        {
          writer = fs;
          persist = fs.writeFile;
        }
        await writer.writeFile("sessions.json", "{}\\n");
        await persist("cron/jobs.json", "{}\\n");
      `,
      "src/runtime/nested-assigned-uninitialized-fs-aliases.ts",
    );

    expect(violations).toEqual([
      { kind: "legacy store filesystem write", line: 9 },
      { kind: "legacy store filesystem write", line: 10 },
    ]);
  });

  it("flags fs write aliases stored on object properties", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import fs from "node:fs/promises";
        const writer = { writeFile: fs.writeFile };
        await writer.writeFile("sessions.json", "{}\\n");
      `,
      "src/runtime/object-fs-write-alias.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 4 }]);
  });

  it("flags fs module handles stored on object properties", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import fs from "node:fs/promises";
        const deps = { fs };
        const io = { storage: fs };
        await deps.fs.writeFile("sessions.json", "{}\\n");
        await io.storage.appendFile("cron/runs/job.jsonl", "{}\\n");
      `,
      "src/runtime/object-fs-module-alias.ts",
    );

    expect(violations).toEqual([
      { kind: "legacy store filesystem write", line: 5 },
      { kind: "legacy store filesystem write", line: 6 },
    ]);
  });

  it("clears fs write object aliases after object reassignment", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import fs from "node:fs/promises";
        let writer = { writeFile: fs.writeFile };
        writer = customWriter;
        await writer.writeFile("sessions.json", "{}\\n");
      `,
      "src/runtime/reassigned-object-fs-write-alias.ts",
    );

    expect(violations).toEqual([]);
  });

  it("clears fs module object aliases after object reassignment", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import fs from "node:fs/promises";
        let deps = { fs };
        deps = customDeps;
        await deps.fs.writeFile("sessions.json", "{}\\n");
      `,
      "src/runtime/reassigned-object-fs-module-alias.ts",
    );

    expect(violations).toEqual([]);
  });

  it("flags fs write aliases assigned to object properties", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import fs from "node:fs/promises";
        const writer: any = {};
        writer.writeFile = fs.writeFile;
        await writer.writeFile("sessions.json", "{}\\n");
      `,
      "src/runtime/assigned-object-fs-write-alias.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 5 }]);
  });

  it("flags fs module handles assigned to object properties", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import fs from "node:fs/promises";
        const deps: any = {};
        deps.fs = fs;
        await deps.fs.writeFile("sessions.json", "{}\\n");
      `,
      "src/runtime/assigned-object-fs-module-alias.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 5 }]);
  });

  it("uses branch-local fs object aliases after conditional reassignment", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import fs from "node:fs/promises";
        const writer = { writeFile: fs.writeFile };
        if (ready) {
          writer.writeFile = customSink;
          await writer.writeFile("sessions.json", "{}\\n");
        }
      `,
      "src/runtime/conditional-object-fs-write-alias-reassignment.ts",
    );

    expect(violations).toEqual([]);
  });

  it("does not leak local fs module aliases outside their scope", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/local-fs-module-alias-scope.ts",
    );

    expect(violations).toEqual([]);
  });

  it("flags legacy paths written through regular-file helpers", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { appendRegularFile as appendSafe } from "openclaw/plugin-sdk/security-runtime";
        const filePath = "session.trajectory.jsonl";
        await appendSafe({ filePath, content: "{}\\n" });
      `,
      "src/runtime/regular-file-helper.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 4 }]);
  });

  it("flags legacy paths written through JSON and atomic helpers", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeJson, writeTextAtomic } from "../infra/json-files.js";
        import { replaceFileAtomicSync } from "../infra/replace-file.js";
        import { saveJsonFile, writeJsonFileAtomically } from "openclaw/plugin-sdk/json-store";
        await writeJson("restart-sentinel.json", {});
        await writeTextAtomic("gateway-restart-intent.json", "{}\\n");
        replaceFileAtomicSync({ filePath: "plugin-state/state.sqlite", content: "" });
        await writeJsonFileAtomically("thread-bindings.json", {});
        saveJsonFile("plugin-binding-approvals.json", {});
      `,
      "src/runtime/write-helper-regressions.ts",
    );

    expect(violations).toEqual([
      { kind: "legacy restart sentinel reference", line: 5 },
      { kind: "legacy store filesystem write", line: 5 },
      { kind: "legacy store filesystem write", line: 6 },
      { kind: "legacy store filesystem write", line: 7 },
      { kind: "legacy store filesystem write", line: 8 },
      { kind: "legacy store filesystem write", line: 9 },
    ]);
  });

  it("flags legacy paths passed through wrapper object properties", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import path from "node:path";
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }) {
          return writeTextAtomic(params.filePath, "{}\\n");
        }
        const ledgerPath = path.join(stateDir, "acp", "event-ledger.json");
        await persist({ filePath: ledgerPath });
      `,
      "src/runtime/object-property-wrapper.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 8 }]);
  });

  it("flags wrapper paths written through createRequire aliases", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { createRequire } from "node:module";
        const req = createRequire(import.meta.url);
        function persist(filePath: string) {
          const fs = req("node:fs");
          fs.writeFileSync(filePath, "{}\\n");
        }
        persist("sessions.json");
      `,
      "src/runtime/create-require-alias-wrapper.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 8 }]);
  });

  it("flags wrapper-local createRequire alias writes", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { createRequire } from "node:module";
        function persist(filePath: string) {
          const req = createRequire(import.meta.url);
          const fs = req("node:fs");
          fs.writeFileSync(filePath, "{}\\n");
        }
        persist("sessions.json");
      `,
      "src/runtime/wrapper-local-create-require-alias.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 8 }]);
  });

  it("flags wrapper-local copied createRequire aliases", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { createRequire } from "node:module";
        function persist(filePath: string) {
          const req = createRequire(import.meta.url);
          const req2 = req;
          const fs = req2("node:fs");
          fs.writeFileSync(filePath, "{}\\n");
        }
        persist("sessions.json");
      `,
      "src/runtime/wrapper-copied-create-require-alias.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 9 }]);
  });

  it("flags wrapper-local createRequire aliases after local shadow reassignment", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { createRequire } from "node:module";
        const req = createRequire(import.meta.url);
        function persist(filePath: string) {
          let req;
          req = createRequire(import.meta.url);
          const fs = req("node:fs");
          fs.writeFileSync(filePath, "{}\\n");
        }
        persist("sessions.json");
      `,
      "src/runtime/wrapper-shadowed-reassigned-create-require-alias.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 10 }]);
  });

  it("flags wrapper-local reassigned createRequire aliases named require", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { createRequire } from "node:module";
        function persist(filePath: string) {
          let require;
          require = createRequire(import.meta.url);
          const fs = require("node:fs");
          fs.writeFileSync(filePath, "{}\\n");
        }
        persist("sessions.json");
      `,
      "src/runtime/wrapper-reassigned-create-require-name.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 9 }]);
  });

  it("flags wrapper-local createRequire alias assignments inside blocks", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/wrapper-block-create-require-assignment.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 11 }]);
  });

  it("does not treat wrapper-shadowed createRequire parameters as Node createRequire", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        function persist(
          filePath: string,
          createRequire: (url: string) => (specifier: string) => { writeFileSync(path: string, value: string): void },
        ) {
          const req = createRequire(import.meta.url);
          const fs = req("node:fs");
          fs.writeFileSync(filePath, "{}\\n");
        }
        persist("sessions.json", customCreateRequire);
      `,
      "src/runtime/wrapper-shadowed-create-require.ts",
    );

    expect(violations).toEqual([]);
  });

  it("does not treat wrapper hoisted function createRequire shadows as Node createRequire", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/wrapper-hoisted-create-require-shadow.ts",
    );

    expect(violations).toEqual([]);
  });

  it("keeps wrapper lexical createRequire aliases when call sites shadow them", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/wrapper-lexical-create-require-alias.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 10 }]);
  });

  it("keeps wrapper-local createRequire calls when call sites shadow createRequire", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/wrapper-create-require-call-site-shadow.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 10 }]);
  });

  it("flags exhaustive conditional createRequire alias assignments", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { createRequire } from "node:module";
        let req;
        if (condition) {
          req = createRequire(import.meta.url);
        } else {
          req = createRequire(import.meta.url);
        }
        const fs = req("node:fs");
        fs.writeFileSync("sessions.json", "{}\\n");
      `,
      "src/runtime/conditional-create-require-alias.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 10 }]);
  });

  it("refreshes hoisted wrappers after exhaustive createRequire alias branches", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/hoisted-wrapper-conditional-create-require-alias.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 13 }]);
  });

  it("keeps wrapper conditional createRequire alias branches", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/wrapper-conditional-create-require-alias.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 13 }]);
  });

  it("flags legacy paths passed through named wrapper options", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeJson } from "../infra/json-files.js";
        function persist(options: { store: string }) {
          return writeJson(options.store, {});
        }
        const store = "sessions.json";
        const params = { store };
        await persist(params);
      `,
      "src/runtime/named-wrapper-options.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 8 }]);
  });

  it("flags legacy paths read through chained wrapper option properties", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }) {
          return writeTextAtomic(params.filePath.toString(), "{}\\n");
        }
        const options = { filePath: "sessions.json" };
        await persist(options);
      `,
      "src/runtime/chained-wrapper-option-path.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 7 }]);
  });

  it("flags legacy paths passed through destructured wrapper options", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist({ filePath }: { filePath: string }) {
          return writeTextAtomic(filePath, "{}\\n");
        }
        await persist({ filePath: "sessions.json" });
      `,
      "src/runtime/destructured-wrapper-options.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 6 }]);
  });

  it("flags legacy paths passed through nested destructured wrapper options", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist({ paths: { filePath } }: { paths: { filePath: string } }) {
          return writeTextAtomic(filePath, "{}\\n");
        }
        await persist({ paths: { filePath: "sessions.json" } });
      `,
      "src/runtime/nested-destructured-wrapper-options.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 6 }]);
  });

  it("flags legacy paths from nested destructured wrapper option defaults", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist({ paths: { filePath = "sessions.json" } }: { paths: { filePath?: string } }) {
          return writeTextAtomic(filePath, "{}\\n");
        }
        await persist({ paths: {} });
      `,
      "src/runtime/nested-destructured-wrapper-option-default.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 6 }]);
  });

  it("flags nested parameter defaults from identifier-valued intermediate objects", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        const paths = { filePath: "sessions.json" };
        function persist({ paths: { filePath } }: { paths: { filePath: string } } = { paths }) {
          return writeTextAtomic(filePath, "{}\\n");
        }
        await persist();
      `,
      "src/runtime/nested-parameter-default-identifier-intermediate.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 7 }]);
  });

  it("flags nested destructuring defaults from identifier-valued intermediate objects", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        const paths = {};
        function persist({ paths: { filePath = "sessions.json" } }: { paths: { filePath?: string } } = { paths }) {
          return writeTextAtomic(filePath, "{}\\n");
        }
        await persist();
      `,
      "src/runtime/nested-destructuring-default-identifier-intermediate.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 7 }]);
  });

  it("flags nested destructuring defaults from aliased known object literals", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist({ paths: { filePath = "sessions.json" } }: { paths: { filePath?: string } }) {
          return writeTextAtomic(filePath, "{}\\n");
        }
        const source = { paths: {} };
        const options = source;
        await persist(options);
      `,
      "src/runtime/nested-destructuring-default-aliased-known-object.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 8 }]);
  });

  it("flags nested destructuring defaults from parent binding defaults", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        function persist({ paths: { filePath } = { filePath: "sessions.json" } }) {
          return fs.writeFile(filePath, "{}\\n");
        }
        await persist({});
      `,
      "src/runtime/nested-destructuring-parent-binding-default.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 6 }]);
  });

  it("does not force nested destructured defaults for unknown intermediate properties", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        declare function loadPaths(): { filePath?: string };
        function persist({ paths: { filePath = "sessions.json" } }: { paths: { filePath?: string } }) {
          return fs.writeFile(filePath, "{}\\n");
        }
        const options = { paths: loadPaths() };
        await persist(options);
      `,
      "src/runtime/nested-destructured-wrapper-option-unknown-intermediate.ts",
    );

    expect(violations).toEqual([]);
  });

  it("flags defaults referencing earlier nested destructured identifier parameters", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        function writePath({ paths: { filePath } }: { paths: { filePath: string } }, path = filePath) {
          return fs.writeFile(path, "{}\\n");
        }
        const options = { paths: { filePath: "sessions.json" } };
        await writePath(options);
      `,
      "src/runtime/nested-destructured-wrapper-earlier-identifier-default.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 7 }]);
  });

  it("flags defaults referencing earlier nested object parameter properties", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        function writePath(options: { paths: { filePath: string } }, path = options.paths.filePath) {
          return fs.writeFile(path, "{}\\n");
        }
        const options = { paths: { filePath: "sessions.json" } };
        await writePath(options);
      `,
      "src/runtime/nested-object-wrapper-earlier-property-default.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 7 }]);
  });

  it("flags legacy paths passed through positional wrapper parameters", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(filePath: string) {
          return writeTextAtomic(filePath, "{}\\n");
        }
        await persist("sessions.json");
      `,
      "src/runtime/positional-wrapper-path.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 6 }]);
  });

  it("flags defaulted wrapper parameters after optional safe assignments", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        let filePath;
        if (useDb) filePath = currentSqlitePath;
        function persist(path = "sessions.json") {
          return fs.writeFile(path, "{}\\n");
        }
        await persist(filePath);
      `,
      "src/runtime/conditional-undefined-defaulted-wrapper-parameter.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 8 }]);
  });

  it("flags legacy paths forwarded through nested wrapper helpers", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          function inner(nextPath: string) {
            return fs.writeFile(nextPath, "{}\\n");
          }
          return inner(filePath);
        }
        await persist("sessions.json");
      `,
      "src/runtime/nested-wrapper-path.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 9 }]);
  });

  it("flags legacy paths captured by nested wrapper helpers", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          function inner() {
            return fs.writeFile(filePath, "{}\\n");
          }
          return inner();
        }
        await persist("sessions.json");
      `,
      "src/runtime/nested-wrapper-closed-over-path.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 9 }]);
  });

  it("flags legacy paths captured by nested helpers and forwarded to outer wrappers", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/nested-helper-forwarded-to-outer-wrapper.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 12 }]);
  });

  it("keeps closed-over write aliases after loop-scoped shadows", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/nested-wrapper-loop-shadowed-write-alias.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 11 }]);
  });

  it("flags legacy paths forwarded through nested helper parameter defaults", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          function inner(nextPath = filePath) {
            return fs.writeFile(nextPath, "{}\\n");
          }
          return inner();
        }
        await persist("sessions.json");
      `,
      "src/runtime/nested-helper-parameter-default.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 9 }]);
  });

  it("flags legacy paths written by callable nested helper parameter defaults", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          function inner(save = () => fs.writeFile(filePath, "{}\\n")) {
            return save();
          }
          return inner();
        }
        await persist("sessions.json");
      `,
      "src/runtime/nested-helper-callable-parameter-default.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 9 }]);
  });

  it("does not use callable nested helper parameter defaults when callbacks are provided", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          function inner(save = () => fs.writeFile(filePath, "{}\\n")) {
            return save();
          }
          return inner(async () => {});
        }
        await persist("sessions.json");
      `,
      "src/runtime/nested-helper-callable-parameter-default-provided.ts",
    );

    expect(violations).toEqual([]);
  });

  it("flags legacy paths forwarded through undefined nested helper arguments", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          function inner(nextPath = filePath) {
            return fs.writeFile(nextPath, "{}\\n");
          }
          return inner(undefined);
        }
        await persist("sessions.json");
      `,
      "src/runtime/nested-helper-undefined-parameter-default.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 9 }]);
  });

  it("flags legacy paths forwarded through void nested helper arguments", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          function inner(nextPath = filePath) {
            return fs.writeFile(nextPath, "{}\\n");
          }
          return inner(void 0);
        }
        await persist("sessions.json");
      `,
      "src/runtime/nested-helper-void-parameter-default.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 9 }]);
  });

  it("resolves nested helper parameter defaults in the helper scope", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          function inner(filePath: string, nextPath = filePath) {
            return fs.writeFile(nextPath, "{}\\n");
          }
          return inner(currentSqlitePath);
        }
        await persist("sessions.json");
      `,
      "src/runtime/nested-helper-default-parameter-shadow.ts",
    );

    expect(violations).toEqual([]);
  });

  it("does not resolve top-level helper parameter defaults in the caller scope", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        const defaultPath = "current-state.json";
        function writePath(path = defaultPath) {
          return fs.writeFile(path, "{}\\n");
        }
        function persist(defaultPath: string) {
          return writePath();
        }
        await persist("sessions.json");
      `,
      "src/runtime/top-level-helper-default-caller-shadow.ts",
    );

    expect(violations).toEqual([]);
  });

  it("does not resolve top-level helper object binding defaults in the caller scope", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        const defaultPath = "current-state.json";
        function writePath({ path = defaultPath } = {}) {
          return fs.writeFile(path, "{}\\n");
        }
        function persist(defaultPath: string) {
          return writePath({});
        }
        await persist("sessions.json");
      `,
      "src/runtime/top-level-helper-object-binding-default-caller-shadow.ts",
    );

    expect(violations).toEqual([]);
  });

  it("flags forwarded top-level helper object binding literal defaults", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        function writePath({ path = "sessions.json" } = {}) {
          return fs.writeFile(path, "{}\\n");
        }
        function persist() {
          return writePath({});
        }
        await persist();
      `,
      "src/runtime/top-level-helper-object-binding-literal-default.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 7 }]);
  });

  it("does not resolve top-level helper expression defaults in the caller scope", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        const fallback = "current-state.json";
        function writePath(path = filePath ?? fallback) {
          return fs.writeFile(path, "{}\\n");
        }
        function persist(filePath: string) {
          return writePath();
        }
        await persist("sessions.json");
      `,
      "src/runtime/top-level-helper-expression-default-caller-shadow.ts",
    );

    expect(violations).toEqual([]);
  });

  it("flags top-level helper expression defaults derived from earlier parameters", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        const fallback = "current-state.json";
        function writePath(filePath: string, path = filePath ?? fallback) {
          return fs.writeFile(path, "{}\\n");
        }
        function persist(filePath: string) {
          return writePath(filePath);
        }
        await persist("sessions.json");
      `,
      "src/runtime/top-level-helper-earlier-parameter-expression-default.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 10 }]);
  });

  it("flags direct top-level helper calls with defaults derived from earlier arguments", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        const fallback = "current-state.json";
        function writePath(filePath: string, path = filePath ?? fallback) {
          return fs.writeFile(path, "{}\\n");
        }
        await writePath("sessions.json");
      `,
      "src/runtime/top-level-helper-direct-earlier-parameter-default.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 7 }]);
  });

  it("flags direct top-level helper calls with defaults from earlier destructured arguments", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        function writePath({ filePath }: { filePath: string }, path = filePath) {
          return fs.writeFile(path, "{}\\n");
        }
        await writePath({ filePath: "sessions.json" });
      `,
      "src/runtime/top-level-helper-direct-destructured-earlier-parameter-default.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 6 }]);
  });

  it("flags direct top-level helper calls with defaults from nested destructured arguments", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        function writePath(
          { paths: { filePath } }: { paths: { filePath: string } },
          path = filePath,
        ) {
          return fs.writeFile(path, "{}\\n");
        }
        await writePath({ paths: { filePath: "sessions.json" } });
      `,
      "src/runtime/top-level-helper-direct-nested-destructured-earlier-parameter-default.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 9 }]);
  });

  it("does not flag safe defaults that only inspect earlier legacy arguments", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        function writePath(
          filePath: string,
          path = filePath ? "current-state.json" : "current-state.json",
        ) {
          return fs.writeFile(path, "{}\\n");
        }
        await writePath("sessions.json");
      `,
      "src/runtime/top-level-helper-safe-conditional-default.ts",
    );

    expect(violations).toEqual([]);
  });

  it("flags direct top-level helper calls with method defaults from earlier arguments", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        function writePath(filePath: string, path = filePath.replace(/\\.json$/, ".json")) {
          return fs.writeFile(path, "{}\\n");
        }
        await writePath("sessions.json");
      `,
      "src/runtime/top-level-helper-direct-method-earlier-parameter-default.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 6 }]);
  });

  it("flags direct top-level helper calls with comma defaults from earlier arguments", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        const safePath = "current-state.json";
        function writePath(filePath: string, path = (safePath, filePath)) {
          return fs.writeFile(path, "{}\\n");
        }
        await writePath("sessions.json");
      `,
      "src/runtime/top-level-helper-direct-comma-earlier-parameter-default.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 7 }]);
  });

  it("flags direct top-level helper calls with assignment defaults from earlier arguments", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        let cached = "current-state.json";
        function writePath(filePath: string, path = (cached = filePath)) {
          return fs.writeFile(path, "{}\\n");
        }
        await writePath("sessions.json");
      `,
      "src/runtime/top-level-helper-direct-assignment-earlier-parameter-default.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 7 }]);
  });

  it("flags top-level helper object binding expression defaults derived from earlier parameters", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        const fallback = "current-state.json";
        function writePath(filePath: string, { path = filePath ?? fallback } = {}) {
          return fs.writeFile(path, "{}\\n");
        }
        function persist(filePath: string) {
          return writePath(filePath, {});
        }
        await persist("sessions.json");
      `,
      "src/runtime/top-level-helper-object-binding-earlier-parameter-expression-default.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 10 }]);
  });

  it("flags direct top-level helper calls with object binding defaults from earlier arguments", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        const fallback = "current-state.json";
        function writePath(filePath: string, { path = filePath ?? fallback } = {}) {
          return fs.writeFile(path, "{}\\n");
        }
        await writePath("sessions.json");
      `,
      "src/runtime/top-level-helper-direct-object-binding-earlier-parameter-default.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 7 }]);
  });

  it("flags object binding defaults from missing properties on identifier arguments", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        const options = {};
        function writePath(filePath: string, { path = filePath } = {}) {
          return fs.writeFile(path, "{}\\n");
        }
        await writePath("sessions.json", options);
      `,
      "src/runtime/top-level-helper-object-binding-missing-identifier-default.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 7 }]);
  });

  it("flags object binding defaults from undefined properties on identifier arguments", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        const options = { path: undefined };
        function writePath(filePath: string, { path = filePath } = {}) {
          return fs.writeFile(path, "{}\\n");
        }
        await writePath("sessions.json", options);
      `,
      "src/runtime/top-level-helper-object-binding-undefined-identifier-default.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 7 }]);
  });

  it("flags object binding defaults from undefined properties in parameter defaults", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        function writePath({ path = "sessions.json" } = { path: undefined }) {
          return fs.writeFile(path, "{}\\n");
        }
        await writePath();
      `,
      "src/runtime/top-level-helper-object-binding-undefined-parameter-default.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 6 }]);
  });

  it("uses explicit safe properties on identifier arguments before object binding defaults", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        const options = { path: "current-state.json" };
        function writePath(filePath: string, { path = filePath } = {}) {
          return fs.writeFile(path, "{}\\n");
        }
        await writePath("sessions.json", options);
      `,
      "src/runtime/top-level-helper-object-binding-safe-identifier-property.ts",
    );

    expect(violations).toEqual([]);
  });

  it("does not force object binding defaults for unknown identifier arguments", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        declare function loadOptions(): { path?: string };
        const options = loadOptions();
        function writePath(filePath: string, { path = filePath } = {}) {
          return fs.writeFile(path, "{}\\n");
        }
        await writePath("sessions.json", options);
      `,
      "src/runtime/top-level-helper-object-binding-unknown-identifier-default.ts",
    );

    expect(violations).toEqual([]);
  });

  it("does not force object binding defaults for identifier arguments with unknown spreads", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        declare const defaults: { path?: string };
        const options = { ...defaults };
        function writePath(filePath: string, { path = filePath } = {}) {
          return fs.writeFile(path, "{}\\n");
        }
        await writePath("sessions.json", options);
      `,
      "src/runtime/top-level-helper-object-binding-unknown-spread-default.ts",
    );

    expect(violations).toEqual([]);
  });

  it("keeps explicit undefined object properties after exhaustive branch merges", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/top-level-helper-object-binding-branch-undefined-default.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 12 }]);
  });

  it("keeps maybe undefined object properties after exhaustive branch merges", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/top-level-helper-object-binding-branch-maybe-undefined-default.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 12 }]);
  });

  it("keeps known nested object literals after exhaustive branch merges", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/top-level-helper-object-binding-branch-known-nested-object.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 12 }]);
  });

  it("does not force object binding defaults after exhaustive unknown object branch merges", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/top-level-helper-object-binding-branch-unknown-default.ts",
    );

    expect(violations).toEqual([]);
  });

  it("does not force object binding defaults after optional unknown object rewrites", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/top-level-helper-object-binding-optional-unknown-rewrite-default.ts",
    );

    expect(violations).toEqual([]);
  });

  it("keeps known-missing object properties after exhaustive branch merges", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/top-level-helper-object-binding-branch-known-missing-default.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 12 }]);
  });

  it("flags object binding defaults from earlier destructured arguments", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        function writePath({ filePath }: { filePath: string }, { path = filePath } = {}) {
          return fs.writeFile(path, "{}\\n");
        }
        await writePath({ filePath: "sessions.json" }, {});
      `,
      "src/runtime/top-level-helper-object-binding-destructured-earlier-parameter-default.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 6 }]);
  });

  it("flags object binding defaults from nested destructured arguments", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        function writePath(
          { paths: { filePath } }: { paths: { filePath: string } },
          { path = filePath } = {},
        ) {
          return fs.writeFile(path, "{}\\n");
        }
        await writePath({ paths: { filePath: "sessions.json" } }, {});
      `,
      "src/runtime/top-level-helper-object-binding-nested-destructured-earlier-parameter-default.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 9 }]);
  });

  it("does not scan unrelated object properties for earlier property defaults", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/top-level-helper-property-default-unrelated-legacy-property.ts",
    );

    expect(violations).toEqual([]);
  });

  it("does not scan unrelated object properties for bracket defaults", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/top-level-helper-bracket-default-unrelated-legacy-property.ts",
    );

    expect(violations).toEqual([]);
  });

  it("flags direct top-level helper calls with nested property defaults", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/top-level-helper-nested-property-default.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 9 }]);
  });

  it("flags direct top-level helper calls with nested bracket property defaults", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/top-level-helper-nested-bracket-property-default.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 9 }]);
  });

  it("does not crash on unknown spreads in nested property defaults", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        declare const defaults: { paths?: { filePath: string } };
        function writePath(
          options: { paths?: { filePath: string } },
          path = options.paths.filePath,
        ) {
          return fs.writeFile(path, "{}\\n");
        }
        await writePath({ ...defaults });
      `,
      "src/runtime/top-level-helper-nested-property-default-unknown-spread.ts",
    );

    expect(violations).toEqual([]);
  });

  it("keeps nested legacy paths before unknown outer spreads", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        declare const options: { paths?: { filePath: string } };
        function persist({ paths: { filePath } }: { paths: { filePath: string } }) {
          return fs.writeFile(filePath, "{}\\n");
        }
        await persist({ paths: { filePath: "sessions.json" }, ...options });
      `,
      "src/runtime/nested-wrapper-path-before-unknown-spread.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 7 }]);
  });

  it("flags nested legacy paths passed through shorthand options", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        const paths = { filePath: "sessions.json" };
        function writePath(options: { paths: { filePath: string } }, path = options.paths.filePath) {
          return fs.writeFile(path, "{}\\n");
        }
        await writePath({ paths });
      `,
      "src/runtime/top-level-helper-nested-shorthand-options.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 7 }]);
  });

  it("flags nested legacy paths forwarded through identifier-valued object properties", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        function persist({ paths: { filePath } }: { paths: { filePath: string } }) {
          return fs.writeFile(filePath, "{}\\n");
        }
        const paths = { filePath: "sessions.json" };
        const options = { paths };
        await persist(options);
      `,
      "src/runtime/nested-wrapper-identifier-valued-object-property.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 8 }]);
  });

  it("flags nested legacy paths hidden in intermediate option expressions", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        declare function makePaths(filePath: string): { filePath: string };
        function persist({ paths: { filePath } }: { paths: { filePath: string } }) {
          return fs.writeFile(filePath, "{}\\n");
        }
        await persist({ paths: makePaths("sessions.json") });
      `,
      "src/runtime/nested-wrapper-path-intermediate-expression.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 7 }]);
  });

  it("flags direct top-level helper calls with chained literal parameter defaults", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        function writePath(filePath = "sessions.json", path = filePath) {
          return fs.writeFile(path, "{}\\n");
        }
        await writePath();
      `,
      "src/runtime/top-level-helper-chained-literal-parameter-default.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 6 }]);
  });

  it("flags direct top-level helper calls with nested object literal parameter defaults", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        function writePath(
          options = { paths: { filePath: "sessions.json" } },
          path = options.paths.filePath,
        ) {
          return fs.writeFile(path, "{}\\n");
        }
        await writePath();
      `,
      "src/runtime/top-level-helper-nested-object-literal-parameter-default.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 9 }]);
  });

  it("flags direct top-level helper calls with nested spread parameter defaults", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        const defaults = { paths: { filePath: "sessions.json" } };
        function writePath(
          options = { ...defaults },
          path = options.paths.filePath,
        ) {
          return fs.writeFile(path, "{}\\n");
        }
        await writePath();
      `,
      "src/runtime/top-level-helper-nested-spread-parameter-default.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 10 }]);
  });

  it("does not resolve top-level helper nested spread defaults in the caller scope", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/top-level-helper-nested-spread-default-caller-shadow.ts",
    );

    expect(violations).toEqual([]);
  });

  it("does not resolve omitted earlier helper parameters in the caller scope", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        function writePath(filePath?: string, path = filePath) {
          return fs.writeFile(path, "{}\\n");
        }
        function persist(filePath: string) {
          return writePath();
        }
        await persist("sessions.json");
      `,
      "src/runtime/top-level-helper-omitted-earlier-default.ts",
    );

    expect(violations).toEqual([]);
  });

  it("does not resolve omitted earlier helper parameters in object binding defaults", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        function writePath(filePath?: string, { path = filePath } = {}) {
          return fs.writeFile(path, "{}\\n");
        }
        function persist(filePath: string) {
          return writePath(undefined, {});
        }
        await persist("sessions.json");
      `,
      "src/runtime/top-level-helper-object-binding-omitted-earlier-default.ts",
    );

    expect(violations).toEqual([]);
  });

  it("flags default expressions that combine multiple earlier parameters", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        function writePath(prefix: string, filePath: string, path = prefix + filePath) {
          return fs.writeFile(path, "{}\\n");
        }
        function persist(filePath: string) {
          return writePath("state/", filePath);
        }
        await persist("sessions.json");
      `,
      "src/runtime/top-level-helper-multiple-earlier-parameter-default.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 9 }]);
  });

  it("does not resolve top-level helper defaults in closed-over caller scope", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/top-level-helper-default-closed-over-caller-shadow.ts",
    );

    expect(violations).toEqual([]);
  });

  it("does not treat top-level helper aliases as closed over nested helpers", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/top-level-helper-alias-module-path-shadow.ts",
    );

    expect(violations).toEqual([]);
  });

  it("does not resolve aliased top-level helper defaults in the caller scope", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/top-level-helper-alias-default-caller-shadow.ts",
    );

    expect(violations).toEqual([]);
  });

  it("flags legacy paths forwarded through nested helper object binding defaults", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          function inner({ path = filePath } = {}) {
            return fs.writeFile(path, "{}\\n");
          }
          return inner();
        }
        await persist("sessions.json");
      `,
      "src/runtime/nested-helper-object-binding-default.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 9 }]);
  });

  it("does not use nested helper object binding defaults when a spread may provide the property", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          const options = getOptions();
          function inner({ path = filePath } = {}) {
            return fs.writeFile(path, "{}\\n");
          }
          return inner({ ...options });
        }
        await persist("sessions.json");
      `,
      "src/runtime/nested-helper-object-binding-default-unknown-spread.ts",
    );

    expect(violations).toEqual([]);
  });

  it("flags nested helper object binding defaults after known-empty object spreads", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          const defaults = {};
          function inner({ path = filePath } = {}) {
            return fs.writeFile(path, "{}\\n");
          }
          return inner({ ...defaults, ...{} });
        }
        await persist("sessions.json");
      `,
      "src/runtime/nested-helper-object-binding-default-known-empty-spread.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 10 }]);
  });

  it("resolves nested helper object binding defaults in the helper scope", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          function inner(filePath: string, { path = filePath } = {}) {
            return fs.writeFile(path, "{}\\n");
          }
          return inner(currentSqlitePath, {});
        }
        await persist("sessions.json");
      `,
      "src/runtime/nested-helper-object-binding-default-shadow.ts",
    );

    expect(violations).toEqual([]);
  });

  it("flags legacy paths forwarded through undefined nested helper object arguments", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          function inner({ path = filePath } = {}) {
            return fs.writeFile(path, "{}\\n");
          }
          return inner(undefined);
        }
        await persist("sessions.json");
      `,
      "src/runtime/nested-helper-undefined-object-binding-default.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 9 }]);
  });

  it("flags legacy paths forwarded through explicit undefined nested helper object properties", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          function inner({ path = filePath } = {}) {
            return fs.writeFile(path, "{}\\n");
          }
          return inner({ path: undefined });
        }
        await persist("sessions.json");
      `,
      "src/runtime/nested-helper-undefined-object-property-default.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 9 }]);
  });

  it("flags legacy paths captured by nested helpers with local fs aliases", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        function persist(filePath: string) {
          function inner() {
            const fs = require("node:fs");
            return fs.writeFileSync(filePath, "{}\\n");
          }
          return inner();
        }
        persist("sessions.json");
      `,
      "src/runtime/nested-wrapper-closed-over-local-fs.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 9 }]);
  });

  it("does not treat named function expression self-bindings as captured write aliases", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          const writeFile = fs.writeFile;
          const inner = function writeFile() {
            return writeFile(filePath);
          };
          return inner();
        }
        await persist("sessions.json");
      `,
      "src/runtime/named-function-expression-write-alias-shadow.ts",
    );

    expect(violations).toEqual([]);
  });

  it("flags legacy paths captured by defaulted destructured nested helpers", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/defaulted-destructured-nested-helper.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 11 }]);
  });

  it("does not use nested helper destructuring defaults when safe callbacks are present", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/present-safe-callback-nested-default.ts",
    );

    expect(violations).toEqual([]);
  });

  it("uses nested helper destructuring defaults when properties are explicitly undefined", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/undefined-callback-nested-default.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 11 }]);
  });

  it("does not resolve outer object methods through local object shadows", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/local-object-shadow-nested-method.ts",
    );

    expect(violations).toEqual([]);
  });

  it("keeps branch-only object methods inside closed-over nested helpers", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/branch-only-closed-over-object-method.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 20 }]);
  });

  it("keeps branch-only property assigned methods inside closed-over nested helpers", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/branch-only-property-closed-over-object-method.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 15 }]);
  });

  it("flags legacy paths captured by nested helpers with branch-assigned write aliases", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/nested-wrapper-branch-assigned-write-alias.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 15 }]);
  });

  it("flags legacy paths captured by conditionally assigned nested helpers", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/conditionally-assigned-nested-helper.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 15 }]);
  });

  it("keeps legacy nested helpers after braceless optional reassignment", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/nested-wrapper-braceless-optional-reassignment.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 11 }]);
  });

  it("flags legacy paths captured by nested helpers with destructured fs aliases", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          function inner() {
            const { writeFile } = fs;
            return writeFile(filePath, "{}\\n");
          }
          return inner();
        }
        await persist("sessions.json");
      `,
      "src/runtime/nested-wrapper-closed-over-destructured-fs.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 10 }]);
  });

  it("ignores nested helpers with shadowed local require aliases", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        function persist(filePath: string, customRequire: NodeRequire) {
          function inner() {
            const require = customRequire;
            const fs = require("node:fs");
            return fs.writeFileSync(filePath, "{}\\n");
          }
          return inner();
        }
        persist("sessions.json", customRequire);
      `,
      "src/runtime/nested-wrapper-shadowed-require.ts",
    );

    expect(violations).toEqual([]);
  });

  it("uses nested helper createRequire shadows from the helper definition", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/nested-wrapper-create-require-definition-scope.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 14 }]);
  });

  it("does not treat named nested function expressions as closed-over path parameters", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          const inner = function filePath() {
            return fs.writeFile(filePath, "{}\\n");
          };
          return inner();
        }
        await persist("sessions.json");
      `,
      "src/runtime/nested-wrapper-named-function-expression.ts",
    );

    expect(violations).toEqual([]);
  });

  it("does not resolve locally shadowed nested helper calls to outer wrappers", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/nested-wrapper-shadowed-helper-call.ts",
    );

    expect(violations).toEqual([]);
  });

  it("flags legacy paths captured by branch-assigned nested helpers", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        function persist(filePath: string, useJson: boolean) {
          let inner;
          if (useJson) {
            inner = () => fs.writeFile(filePath, "{}\\n");
          }
          return inner();
        }
        await persist("sessions.json", true);
      `,
      "src/runtime/nested-wrapper-branch-assigned-closed-over-path.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 10 }]);
  });

  it("flags legacy paths captured through nested helper chains", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/nested-wrapper-helper-chain-closed-over-path.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 12 }]);
  });

  it("flags legacy paths captured through hoisted nested helper chains", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/nested-wrapper-hoisted-helper-chain-closed-over-path.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 12 }]);
  });

  it("flags hoisted nested helpers that use write aliases declared later", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/nested-wrapper-hoisted-helper-late-alias.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 13 }]);
  });

  it("flags escaped nested helpers that use write aliases declared later", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/nested-wrapper-escaped-late-write-alias.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 12 }]);
  });

  it("flags block-escaped nested helpers that use block write aliases declared later", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/nested-wrapper-block-escaped-late-write-alias.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 14 }]);
  });

  it("flags var nested helpers declared in blocks", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/nested-wrapper-var-block-helper.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 12 }]);
  });

  it("flags var nested helper object methods declared in blocks", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/nested-wrapper-var-block-helper-object-method.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 16 }]);
  });

  it("flags nested helper defaults from object literal destructuring", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          const { save = () => fs.writeFile(filePath, "{}\\n") } = {};
          return save();
        }
        await persist("sessions.json");
      `,
      "src/runtime/nested-wrapper-object-literal-destructuring-default.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 7 }]);
  });

  it("uses the last object literal property before nested helper destructuring defaults", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/nested-wrapper-object-literal-duplicate-default.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 11 }]);
  });

  it("does not use nested helper destructuring defaults when the last duplicate is safe", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/nested-wrapper-object-literal-duplicate-safe.ts",
    );

    expect(violations).toEqual([]);
  });

  it("does not use nested helper destructuring defaults when a spread may provide the property", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          const safe = async () => {};
          const { save = () => fs.writeFile(filePath, "{}\\n") } = {
            ...{ save: safe },
          };
          return save();
        }
        await persist("sessions.json");
      `,
      "src/runtime/nested-wrapper-object-literal-spread-safe.ts",
    );

    expect(violations).toEqual([]);
  });

  it("does not use nested helper destructuring defaults for untracked identifier spreads", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          const defaults = getWriter();
          const { save = () => fs.writeFile(filePath, "{}\\n") } = {
            ...defaults,
          };
          return save?.();
        }
        await persist("sessions.json");
      `,
      "src/runtime/nested-wrapper-object-literal-unknown-spread-default.ts",
    );

    expect(violations).toEqual([]);
  });

  it("keeps earlier wrapper properties through known-missing object spreads", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/nested-wrapper-object-literal-known-missing-spread.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 12 }]);
  });

  it("uses nested helper destructuring defaults after known undefined object spreads", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          const defaults = { save: undefined };
          const { save = () => fs.writeFile(filePath, "{}\\n") } = {
            ...defaults,
          };
          return save();
        }
        await persist("sessions.json");
      `,
      "src/runtime/nested-wrapper-object-literal-undefined-spread-default.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 10 }]);
  });

  it("flags var nested wrappers declared in blocks", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          {
            var inner = (path: string) => fs.writeFile(path, "{}\\n");
          }
          return inner(filePath);
        }
        await persist("sessions.json");
      `,
      "src/runtime/nested-wrapper-var-block-declaration.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 9 }]);
  });

  it("merges var nested wrapper declarations inside exhaustive branches", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/nested-wrapper-var-branch-declaration.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 11 }]);
  });

  it("keeps prior var nested wrapper declarations after optional branch redeclarations", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        function persist(filePath: string, disabled: boolean) {
          var inner = (path: string) => fs.writeFile(path, "{}\\n");
          if (disabled) {
            var inner = async (_path: string) => {};
          }
          return inner(filePath);
        }
        await persist("sessions.json", false);
      `,
      "src/runtime/nested-wrapper-var-optional-branch-declaration.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 10 }]);
  });

  it("flags var nested wrapper destructuring defaults declared in blocks", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          {
            var { save = (path: string) => fs.writeFile(path, "{}\\n") } = {};
          }
          return save(filePath);
        }
        await persist("sessions.json");
      `,
      "src/runtime/nested-wrapper-var-block-destructuring-default.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 9 }]);
  });

  it("flags legacy paths captured through sibling nested helper calls", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/nested-wrapper-sibling-helper-call-closed-over-path.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 12 }]);
  });

  it("flags legacy paths forwarded through sibling nested helper parameters", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/nested-wrapper-sibling-helper-forwarded-path.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 12 }]);
  });

  it("flags legacy paths captured through nested arrow helper chains", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          const inner = () => {
            const deeper = () => fs.writeFile(filePath, "{}\\n");
            return deeper();
          };
          return inner();
        }
        await persist("sessions.json");
      `,
      "src/runtime/nested-wrapper-arrow-helper-chain-closed-over-path.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 10 }]);
  });

  it("flags legacy paths captured through nested helper aliases", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/nested-wrapper-helper-alias-closed-over-path.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 11 }]);
  });

  it("flags legacy paths captured through nested object helper methods", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/nested-wrapper-object-helper-closed-over-path.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 14 }]);
  });

  it("flags legacy paths captured through nested object helper aliases", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/nested-wrapper-object-helper-alias-closed-over-path.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 11 }]);
  });

  it("does not treat nested function declaration shadows as captured write aliases", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/nested-wrapper-function-declaration-write-shadow.ts",
    );

    expect(violations).toEqual([]);
  });

  it("does not treat nested helper parameters as captured write aliases", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        function persist(filePath: string, customWrite: (value: string) => void) {
          const writeFile = fs.writeFile;
          function inner(writeFile: (value: string) => void) {
            return writeFile(filePath);
          }
          return inner(customWrite);
        }
        await persist("sessions.json", customWrite);
      `,
      "src/runtime/nested-wrapper-parameter-write-alias-shadow.ts",
    );

    expect(violations).toEqual([]);
  });

  it("flags legacy paths forwarded through nested arrow helpers", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          const inner = (nextPath: string) => fs.writeFile(nextPath, "{}\\n");
          return inner(filePath);
        }
        await persist("sessions.json");
      `,
      "src/runtime/nested-arrow-wrapper-path.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 7 }]);
  });

  it("flags legacy paths forwarded through nested object helper methods", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/nested-object-wrapper-path.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 11 }]);
  });

  it("flags legacy paths forwarded through nested helper aliases", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          function inner(nextPath: string) {
            return fs.writeFile(nextPath, "{}\\n");
          }
          const save = inner;
          return save(filePath);
        }
        await persist("sessions.json");
      `,
      "src/runtime/nested-wrapper-alias-path.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 10 }]);
  });

  it("flags legacy paths forwarded through assignment-defined nested helper aliases", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/nested-wrapper-assigned-alias-closed-over-path.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 11 }]);
  });

  it("flags enclosing helper assignments made inside nested helpers", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/nested-wrapper-enclosing-assigned-helper.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 11 }]);
  });

  it("flags legacy paths forwarded through extracted nested object helper methods", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/nested-object-wrapper-alias-path.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 12 }]);
  });

  it("flags legacy paths forwarded through assignment-defined nested object helpers", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/nested-object-wrapper-assigned-alias-closed-over-path.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 11 }]);
  });

  it("merges closed-over var nested wrapper declarations inside exhaustive branches", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/nested-wrapper-var-branch-declaration-closed-over-path.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 14 }]);
  });

  it("merges closed-over var fs aliases declared inside optional branches", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/nested-wrapper-var-fs-alias-branch-closed-over-path.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 12 }]);
  });

  it("flags enclosing object helper assignments made inside nested helpers", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/nested-object-wrapper-enclosing-assigned-helper.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 14 }]);
  });

  it("flags legacy paths forwarded through local nested object helper aliases", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/nested-object-wrapper-local-method-alias-closed-over-path.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 15 }]);
  });

  it("flags closed-over nested object helper methods copied through destructuring aliases", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/nested-object-wrapper-destructured-alias-closed-over-path.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 17 }]);
  });

  it("clears closed-over nested object helpers after exhaustive reassignment", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/nested-object-wrapper-exhaustive-reassigned-safe.ts",
    );

    expect(violations).toEqual([]);
  });

  it("keeps closed-over nested helpers after optional branch assignment", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/nested-wrapper-optional-branch-assigned-helper.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 13 }]);
  });

  it("keeps closed-over nested helpers after loop assignment", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/nested-wrapper-loop-assigned-helper.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 13 }]);
  });

  it("keeps closed-over nested helpers after optional while reassignment", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/nested-wrapper-while-reassigned-helper.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 13 }]);
  });

  it("keeps switch case closed-over nested helper shadows scoped", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/nested-wrapper-switch-case-shadow.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 15 }]);
  });

  it("flags nested helper declarations inside switch cases", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/nested-wrapper-switch-case-helper.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 12 }]);
  });

  it("keeps closed-over nested helpers after try assignment", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/nested-wrapper-try-assigned-helper.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 13 }]);
  });

  it("flags closed-over nested helper aliases to outer wrappers", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/nested-wrapper-outer-wrapper-alias.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 13 }]);
  });

  it("flags closed-over nested helper parameter default writes", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          function inner(_ = fs.writeFile(filePath, "{}\\n")) {
            return _;
          }
          return inner();
        }
        await persist("sessions.json");
      `,
      "src/runtime/nested-wrapper-parameter-default-write.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 9 }]);
  });

  it("does not use outer write aliases shadowed later in closed-over helpers", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/nested-wrapper-later-write-alias-shadow.ts",
    );

    expect(violations).toEqual([]);
  });

  it("flags closed-over aliases to top-level wrappers with local metadata", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/nested-wrapper-top-level-wrapper-alias.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 15 }]);
  });

  it("flags closed-over aliases to top-level wrappers with module object metadata", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/nested-wrapper-top-level-object-wrapper-alias.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 15 }]);
  });

  it("flags legacy paths forwarded through destructured local nested object helpers", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/nested-object-wrapper-local-method-destructure-closed-over-path.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 15 }]);
  });

  it("flags legacy paths forwarded through destructured nested object helper methods", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/nested-object-wrapper-destructure-path.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 12 }]);
  });

  it("flags legacy paths forwarded through renamed nested object helper methods", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/nested-object-wrapper-renamed-destructure-path.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 12 }]);
  });

  it("keeps nested wrapper assignments inside optional branches", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        function persist(filePath: string, useJson: boolean) {
          let inner: (nextPath: string) => Promise<void>;
          if (useJson) {
            inner = (nextPath: string) => fs.writeFile(nextPath, "{}\\n");
          }
          return inner(filePath);
        }
        await persist("sessions.json", true);
      `,
      "src/runtime/nested-wrapper-optional-branch-assignment.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 10 }]);
  });

  it("keeps previous nested wrappers after optional safe reassignment", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        function persist(filePath: string, disabled: boolean) {
          let inner = (nextPath: string) => fs.writeFile(nextPath, "{}\\n");
          if (disabled) {
            inner = async () => {};
          }
          return inner(filePath);
        }
        await persist("sessions.json", false);
      `,
      "src/runtime/nested-wrapper-optional-safe-reassignment.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 10 }]);
  });

  it("keeps nested object wrapper assignments inside optional branches", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        function persist(filePath: string, useJson: boolean) {
          const writer: { inner?: (nextPath: string) => Promise<void> } = {};
          if (useJson) {
            writer.inner = (nextPath: string) => fs.writeFile(nextPath, "{}\\n");
          }
          return writer.inner?.(filePath);
        }
        await persist("sessions.json", true);
      `,
      "src/runtime/nested-object-wrapper-optional-branch-assignment.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 10 }]);
  });

  it("keeps nested object wrapper methods from optional whole-object assignments", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/nested-object-wrapper-optional-object-assignment.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 14 }]);
  });

  it("flags legacy paths after exhaustive nested wrapper assignments", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/nested-wrapper-branch-assignment.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 12 }]);
  });

  it("flags legacy paths after nested wrapper assignments inside plain blocks", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          let inner: (nextPath: string) => Promise<void>;
          {
            inner = (nextPath: string) => fs.writeFile(nextPath, "{}\\n");
          }
          return inner(filePath);
        }
        await persist("sessions.json");
      `,
      "src/runtime/nested-wrapper-block-assignment.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 10 }]);
  });

  it("keeps exhaustive nested wrapper assignments inside plain blocks", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/nested-wrapper-block-branch-assignment.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 14 }]);
  });

  it("does not leak branch-local nested wrapper shadows after exhaustive branches", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/nested-wrapper-branch-local-shadow.ts",
    );

    expect(violations).toEqual([]);
  });

  it("refreshes block-local aliases for nested wrappers assigned to outer bindings", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/nested-wrapper-block-local-late-alias.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 11 }]);
  });

  it("keeps escaped nested wrapper aliases isolated from sibling blocks", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/nested-wrapper-sibling-block-alias-shadow.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 14 }]);
  });

  it("refreshes merged nested wrapper assignments after later aliases", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/nested-wrapper-branch-late-alias.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 13 }]);
  });

  it("refreshes branch-local aliases before merging nested wrapper assignments", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/nested-wrapper-branch-local-late-alias.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 14 }]);
  });

  it("flags legacy paths after exhaustive nested object wrapper assignments", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/nested-object-wrapper-branch-assignment.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 20 }]);
  });

  it("clears stale nested object wrapper methods after exhaustive object reassignment", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/nested-object-wrapper-exhaustive-object-reassignment.ts",
    );

    expect(violations).toEqual([]);
  });

  it("flags legacy paths after exhaustive nested object wrapper parameter assignments", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/nested-object-wrapper-parameter-branch-assignment.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 15 }]);
  });

  it("keeps block-local nested wrapper shadows scoped to their block", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/nested-wrapper-block-shadow.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 12 }]);
  });

  it("does not use outer nested wrappers for destructured parameter shadows", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        function helper(nextPath: string) {
          return fs.writeFile(nextPath, "{}\\n");
        }
        function persist({ helper }: { helper: (nextPath: string) => Promise<void> }, filePath: string) {
          return helper(filePath);
        }
        await persist({ helper: async () => {} }, "sessions.json");
      `,
      "src/runtime/nested-wrapper-destructured-parameter-shadow.ts",
    );

    expect(violations).toEqual([]);
  });

  it("uses enclosing aliases when nested wrapper helpers are called", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          const write = fs.writeFile;
          function inner(nextPath: string) {
            return write(nextPath, "{}\\n");
          }
          return inner(filePath);
        }
        await persist("sessions.json");
      `,
      "src/runtime/nested-wrapper-alias.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 10 }]);
  });

  it("does not use caller block shadows for nested wrapper helper aliases", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/nested-wrapper-call-shadow.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 14 }]);
  });

  it("flags wrapper object binding defaults for explicit undefined forwarded properties", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/wrapper-forwarded-undefined-object-property-default.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 12 }]);
  });

  it("flags legacy paths from defaulted wrapper parameters", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/defaulted-wrapper-paths.ts",
    );

    expect(violations).toEqual([
      { kind: "legacy store filesystem write", line: 12 },
      { kind: "legacy store filesystem write", line: 13 },
      { kind: "legacy store filesystem write", line: 14 },
      { kind: "legacy store filesystem write", line: 15 },
      { kind: "legacy store filesystem write", line: 16 },
    ]);
  });

  it("does not treat ambient declarations as undefined wrapper arguments", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import fs from "node:fs/promises";
        declare const provided: string;
        function persist(filePath = "sessions.json") {
          return fs.writeFile(filePath, "{}\\n");
        }
        await persist(provided);
      `,
      "src/runtime/ambient-defaulted-wrapper-path.ts",
    );

    expect(violations).toEqual([]);
  });

  it("clears wrapper object parameter paths after reassignment", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }) {
          params = { filePath: currentSqlitePath };
          return writeTextAtomic(params.filePath, "{}\\n");
        }
        await persist({ filePath: "sessions.json" });
      `,
      "src/runtime/reassigned-wrapper-object-options.ts",
    );

    expect(violations).toEqual([]);
  });

  it("clears wrapper object parameter paths after nested block reassignment", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }) {
          {
            params = { filePath: currentSqlitePath };
          }
          return writeTextAtomic(params.filePath, "{}\\n");
        }
        await persist({ filePath: "sessions.json" });
      `,
      "src/runtime/nested-reassigned-wrapper-object-options.ts",
    );

    expect(violations).toEqual([]);
  });

  it("does not let block-local wrapper parameter shadows clear outer paths", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }) {
          {
            const params = { filePath: currentSqlitePath };
            await use(params);
          }
          return writeTextAtomic(params.filePath, "{}\\n");
        }
        await persist({ filePath: "sessions.json" });
      `,
      "src/runtime/block-local-wrapper-object-options-shadow.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 10 }]);
  });

  it("clears destructured wrapper option paths after reassignment", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist({ filePath }: { filePath: string }) {
          filePath = currentSqlitePath;
          return writeTextAtomic(filePath, "{}\\n");
        }
        await persist({ filePath: "sessions.json" });
      `,
      "src/runtime/reassigned-destructured-wrapper-options.ts",
    );

    expect(violations).toEqual([]);
  });

  it("clears wrapper object property paths after reassignment", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }) {
          params.filePath = currentSqlitePath;
          return writeTextAtomic(params.filePath, "{}\\n");
        }
        await persist({ filePath: "sessions.json" });
      `,
      "src/runtime/reassigned-wrapper-property-options.ts",
    );

    expect(violations).toEqual([]);
  });

  it("clears nested wrapper object property paths after reassignment", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        function persist(params: { paths: { filePath: string } }) {
          params.paths.filePath = currentSqlitePath;
          return fs.writeFile(params.paths.filePath, "{}\\n");
        }
        await persist({ paths: { filePath: "sessions.json" } });
      `,
      "src/runtime/reassigned-nested-wrapper-property-options.ts",
    );

    expect(violations).toEqual([]);
  });

  it("updates wrapper object property paths after reassignment from another parameter", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }, legacy: { filePath: string }) {
          params.filePath = legacy.filePath;
          return writeTextAtomic(params.filePath, "{}\\n");
        }
        await persist({ filePath: currentSqlitePath }, { filePath: "sessions.json" });
      `,
      "src/runtime/reassigned-wrapper-property-from-parameter.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 7 }]);
  });

  it("keeps wrapper object property paths after conditional reassignment", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }) {
          if (ready) params.filePath = currentSqlitePath;
          return writeTextAtomic(params.filePath, "{}\\n");
        }
        await persist({ filePath: "sessions.json" });
      `,
      "src/runtime/conditional-reassigned-wrapper-property-options.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 7 }]);
  });

  it("keeps wrapper object parameter paths after conditional reassignment", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }) {
          if (ready) params = { filePath: currentSqlitePath };
          return writeTextAtomic(params.filePath, "{}\\n");
        }
        await persist({ filePath: "sessions.json" });
      `,
      "src/runtime/conditional-reassigned-wrapper-object-options.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 7 }]);
  });

  it("keeps wrapper object property paths after for-of reassignment", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }) {
          for (const item of items) {
            params.filePath = currentSqlitePath;
          }
          return writeTextAtomic(params.filePath, "{}\\n");
        }
        await persist({ filePath: "sessions.json" });
      `,
      "src/runtime/for-of-reassigned-wrapper-property-options.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 9 }]);
  });

  it("keeps wrapper object property paths after try-block reassignment", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }) {
          try {
            maybeThrow();
            params.filePath = currentSqlitePath;
          } catch {}
          return writeTextAtomic(params.filePath, "{}\\n");
        }
        await persist({ filePath: "sessions.json" });
      `,
      "src/runtime/try-reassigned-wrapper-property-options.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 10 }]);
  });

  it("clears wrapper object property paths after exhaustive current-path assignments", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }) {
          if (ready) params.filePath = currentSqlitePath;
          else params.filePath = currentSqlitePath;
          return writeTextAtomic(params.filePath, "{}\\n");
        }
        await persist({ filePath: "sessions.json" });
      `,
      "src/runtime/exhaustive-current-wrapper-property-options.ts",
    );

    expect(violations).toEqual([]);
  });

  it("clears wrapper object parameter paths after exhaustive current-object assignments", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }) {
          if (ready) params = { filePath: currentSqlitePath };
          else params = { filePath: currentSqlitePath };
          return writeTextAtomic(params.filePath, "{}\\n");
        }
        await persist({ filePath: "sessions.json" });
      `,
      "src/runtime/exhaustive-current-wrapper-object-options.ts",
    );

    expect(violations).toEqual([]);
  });

  it("flags wrapper object property paths after mixed exhaustive assignments", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }, legacy: { filePath: string }) {
          if (ready) params.filePath = currentSqlitePath;
          else params.filePath = legacy.filePath;
          return writeTextAtomic(params.filePath, "{}\\n");
        }
        await persist({ filePath: currentSqlitePath }, { filePath: "sessions.json" });
      `,
      "src/runtime/exhaustive-mixed-wrapper-property-options.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 8 }]);
  });

  it("flags wrapper object property paths after conditional reassignment from another parameter", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }, legacy: { filePath: string }) {
          if (ready) params.filePath = legacy.filePath;
          return writeTextAtomic(params.filePath, "{}\\n");
        }
        await persist({ filePath: currentSqlitePath }, { filePath: "sessions.json" });
      `,
      "src/runtime/conditional-reassigned-wrapper-property-from-parameter.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 7 }]);
  });

  it("flags wrapper object paths after conditional reassignment from another parameter", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }, legacy: { filePath: string }) {
          if (ready) params = legacy;
          return writeTextAtomic(params.filePath, "{}\\n");
        }
        await persist({ filePath: currentSqlitePath }, { filePath: "sessions.json" });
      `,
      "src/runtime/conditional-reassigned-wrapper-object-from-parameter.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 7 }]);
  });

  it("flags destructured wrapper paths after conditional reassignment from another parameter", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist({ filePath }: { filePath: string }, legacy: { filePath: string }) {
          if (ready) filePath = legacy.filePath;
          return writeTextAtomic(filePath, "{}\\n");
        }
        await persist({ filePath: currentSqlitePath }, { filePath: "sessions.json" });
      `,
      "src/runtime/conditional-reassigned-destructured-wrapper-options.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 7 }]);
  });

  it("flags legacy paths passed through locally destructured wrapper options", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }) {
          const { filePath } = params;
          return writeTextAtomic(filePath, "{}\\n");
        }
        await persist({ filePath: "sessions.json" });
      `,
      "src/runtime/local-destructured-wrapper-options.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 7 }]);
  });

  it("flags legacy paths passed through local wrapper property aliases", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }) {
          const filePath = params.filePath;
          return writeTextAtomic(filePath, "{}\\n");
        }
        await persist({ filePath: "sessions.json" });
      `,
      "src/runtime/local-property-alias-wrapper-options.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 7 }]);
  });

  it("flags legacy paths passed through local wrapper object aliases", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }) {
          const target = params;
          return writeTextAtomic(target.filePath, "{}\\n");
        }
        await persist({ filePath: "sessions.json" });
      `,
      "src/runtime/local-object-alias-wrapper-options.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 7 }]);
  });

  it("flags wrapper object paths after reassignment from another parameter", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }, legacy: { filePath: string }) {
          params = legacy;
          return writeTextAtomic(params.filePath, "{}\\n");
        }
        await persist({ filePath: currentSqlitePath }, { filePath: "sessions.json" });
      `,
      "src/runtime/reassigned-wrapper-object-from-parameter.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 7 }]);
  });

  it("flags wrapper object property paths after nested block reassignment from another parameter", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }, legacy: { filePath: string }) {
          {
            params.filePath = legacy.filePath;
          }
          return writeTextAtomic(params.filePath, "{}\\n");
        }
        await persist({ filePath: currentSqlitePath }, { filePath: "sessions.json" });
      `,
      "src/runtime/nested-block-reassigned-wrapper-property.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 9 }]);
  });

  it("flags wrapper destructured paths after nested block reassignment from another parameter", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist({ filePath }: { filePath: string }, legacy: { filePath: string }) {
          {
            filePath = legacy.filePath;
          }
          return writeTextAtomic(filePath, "{}\\n");
        }
        await persist({ filePath: currentSqlitePath }, { filePath: "sessions.json" });
      `,
      "src/runtime/nested-block-reassigned-wrapper-destructured.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 9 }]);
  });

  it("does not leak block-local wrapper path aliases into the parent block", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }) {
          const filePath = currentSqlitePath;
          {
            const filePath = params.filePath;
          }
          return writeTextAtomic(filePath, "{}\\n");
        }
        await persist({ filePath: "sessions.json" });
      `,
      "src/runtime/block-local-wrapper-path-alias.ts",
    );

    expect(violations).toEqual([]);
  });

  it("flags wrapper option paths written through body-local fs aliases", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import fs from "node:fs/promises";
        function persist(params: { filePath: string }) {
          const { writeFile } = fs;
          return writeFile(params.filePath, "{}\\n");
        }
        await persist({ filePath: "sessions.json" });
      `,
      "src/runtime/body-local-fs-alias-wrapper.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 7 }]);
  });

  it("flags wrapper option paths written through body-local fs method aliases", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import fs from "node:fs/promises";
        function persist(params: { filePath: string }) {
          const save = fs.writeFile;
          return save(params.filePath, "{}\\n");
        }
        await persist({ filePath: "sessions.json" });
      `,
      "src/runtime/wrapper-body-local-fs-method-alias.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 7 }]);
  });

  it("flags wrapper option paths written through branch-assigned body-local fs aliases", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/branch-assigned-body-local-fs-alias-wrapper.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 12 }]);
  });

  it("flags nested wrapper helpers capturing branch-assigned body-local fs aliases", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/nested-wrapper-branch-assigned-body-local-fs-alias.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 15 }]);
  });

  it("flags wrapper option paths written through body-local fs object aliases", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import fs from "node:fs/promises";
        function persist(params: { filePath: string }) {
          const writer = { writeFile: fs.writeFile };
          return writer.writeFile(params.filePath, "{}\\n");
        }
        await persist({ filePath: "sessions.json" });
      `,
      "src/runtime/body-local-fs-object-alias-wrapper.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 7 }]);
  });

  it("flags wrapper option paths written through bracketed body-local fs object aliases", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import fs from "node:fs/promises";
        function persist(params: { filePath: string }) {
          const writer = { writeFile: fs.writeFile };
          return writer["writeFile"](params.filePath, "{}\\n");
        }
        await persist({ filePath: "sessions.json" });
      `,
      "src/runtime/body-local-bracket-fs-object-alias-wrapper.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 7 }]);
  });

  it("clears wrapper body fs object aliases after object reassignment", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import fs from "node:fs/promises";
        function persist(params: { filePath: string }) {
          let writer = { writeFile: fs.writeFile };
          writer = customWriter;
          return writer.writeFile(params.filePath, "{}\\n");
        }
        await persist({ filePath: "sessions.json" });
      `,
      "src/runtime/reassigned-body-local-fs-object-alias-wrapper.ts",
    );

    expect(violations).toEqual([]);
  });

  it("does not let block-local wrapper aliases mutate outer wrapper metadata", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/block-local-wrapper-alias-metadata.ts",
    );

    expect(violations).toEqual([]);
  });

  it("flags wrapper option paths written through fs.promises", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import fs from "node:fs";
        function persist(params: { filePath: string }) {
          return fs.promises.writeFile(params.filePath, "{}\\n");
        }
        await persist({ filePath: "sessions.json" });
      `,
      "src/runtime/wrapper-fs-promises-write.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 6 }]);
  });

  it("flags wrapper option paths written through outer fs module object aliases", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import fs from "node:fs/promises";
        const deps = { fs };
        function persist(params: { filePath: string }) {
          return deps.fs.writeFile(params.filePath, "{}\\n");
        }
        persist({ filePath: "sessions.json" });
      `,
      "src/runtime/wrapper-outer-fs-module-object-alias.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 7 }]);
  });

  it("flags wrapper option paths written through injected fs handles", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        function persist(deps: { fs: typeof import("node:fs") }, params: { filePath: string }) {
          return deps.fs.promises.writeFile(params.filePath, "{}\\n");
        }
        await persist(deps, { filePath: "sessions.json" });
      `,
      "src/runtime/wrapper-injected-fs-write.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 5 }]);
  });

  it("does not treat untyped wrapper fs properties as filesystem writes", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        function persist(deps: { fs: { promises: { writeFile: Function } } }, params: { filePath: string }) {
          return deps.fs.promises.writeFile(params.filePath, "{}\\n");
        }
        await persist(deps, { filePath: "sessions.json" });
      `,
      "src/runtime/wrapper-custom-fs-property.ts",
    );

    expect(violations).toEqual([]);
  });

  it("flags wrapper option paths written through CommonJS fs", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        function persist(params: { filePath: string }) {
          const fs = require("node:fs");
          return fs.promises.writeFile(params.filePath, "{}\\n");
        }
        await persist({ filePath: "sessions.json" });
      `,
      "src/runtime/wrapper-commonjs-fs-write.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 6 }]);
  });

  it("flags wrapper options forwarded to filePath helper objects", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { appendRegularFile, replaceFileAtomic } from "../infra/fs-safe.js";
        function append(options: { filePath: string; content: string }) {
          return appendRegularFile(options);
        }
        function replace(options: { filePath: string; content: string }) {
          return replaceFileAtomic(options);
        }
        append({ filePath: "sessions.json", content: "{}\\n" });
        replace({ filePath: "plugin-state/state.sqlite", content: "" });
      `,
      "src/runtime/forwarded-filepath-helper-options.ts",
    );

    expect(violations).toEqual([
      { kind: "legacy store filesystem write", line: 9 },
      { kind: "legacy store filesystem write", line: 10 },
    ]);
  });

  it("flags wrapper options forwarded through another wrapper", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }) {
          return writeTextAtomic(params.filePath, "{}\\n");
        }
        function save(params: { filePath: string }) {
          return persist(params);
        }
        save({ filePath: "sessions.json" });
      `,
      "src/runtime/transitive-wrapper-forwarding.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 9 }]);
  });

  it("flags wrapper options spread through another wrapper", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }) {
          return writeTextAtomic(params.filePath, "{}\\n");
        }
        function save(params: { filePath: string }) {
          return persist({ ...params });
        }
        save({ filePath: "sessions.json" });
      `,
      "src/runtime/transitive-wrapper-spread-forwarding.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 9 }]);
  });

  it("allows wrapper spread forwarding when a later property overrides the path", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }) {
          return writeTextAtomic(params.filePath, "{}\\n");
        }
        function save(params: { filePath: string }) {
          return persist({ ...params, filePath: currentSqlitePath });
        }
        save({ filePath: "sessions.json" });
      `,
      "src/runtime/transitive-wrapper-spread-overridden-forwarding.ts",
    );

    expect(violations).toEqual([]);
  });

  it("flags wrapper spread forwarding when a later spread restores the path", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }) {
          return writeTextAtomic(params.filePath, "{}\\n");
        }
        function save(params: { filePath: string }) {
          return persist({ filePath: currentSqlitePath, ...params });
        }
        save({ filePath: "sessions.json" });
      `,
      "src/runtime/transitive-wrapper-spread-restored-forwarding.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 9 }]);
  });

  it("flags wrapper options renamed through another wrapper", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }) {
          return writeTextAtomic(params.filePath, "{}\\n");
        }
        function save(params: { storePath: string }) {
          return persist({ filePath: params.storePath });
        }
        save({ storePath: "sessions.json" });
      `,
      "src/runtime/transitive-wrapper-renamed-forwarding.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 9 }]);
  });

  it("flags hoisted wrappers that use write aliases declared later", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import fs from "node:fs/promises";
        function persist(params: { filePath: string }) {
          return writeFile(params.filePath, "{}\\n");
        }
        const { writeFile } = fs;
        await persist({ filePath: "sessions.json" });
      `,
      "src/runtime/late-alias-hoisted-wrapper.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 7 }]);
  });

  it("flags hoisted wrappers that use renamed write aliases declared later", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import fs from "node:fs/promises";
        function persist(params: { filePath: string }) {
          return write(params.filePath, "{}\\n");
        }
        const { writeFile: write } = fs;
        await persist({ filePath: "sessions.json" });
      `,
      "src/runtime/late-renamed-alias-hoisted-wrapper.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 7 }]);
  });

  it("flags reassigned wrapper variables", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        let persist;
        persist = (params: { filePath: string }) => writeTextAtomic(params.filePath, "{}\\n");
        persist({ filePath: "sessions.json" });
      `,
      "src/runtime/reassigned-wrapper-variable.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 5 }]);
  });

  it("flags aliased wrapper variables", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }) {
          return writeTextAtomic(params.filePath, "{}\\n");
        }
        const save = persist;
        save({ filePath: "sessions.json" });
      `,
      "src/runtime/aliased-wrapper-variable.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 7 }]);
  });

  it("does not treat aliased top-level helpers as closing over wrapper parameters", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/aliased-top-level-wrapper-closed-over-module-var.ts",
    );

    expect(violations).toEqual([]);
  });

  it("flags object method wrappers", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        const writer = {
          persist(params: { filePath: string }) {
            return writeTextAtomic(params.filePath, "{}\\n");
          },
        };
        writer.persist({ filePath: "sessions.json" });
      `,
      "src/runtime/object-method-wrapper.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 8 }]);
  });

  it("flags object property wrapper functions", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        const writer = {
          persist: (params: { filePath: string }) => writeTextAtomic(params.filePath, "{}\\n"),
        };
        writer["persist"]({ filePath: "sessions.json" });
      `,
      "src/runtime/object-property-wrapper-function.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 6 }]);
  });

  it("flags object wrapper shorthand aliases", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }) {
          return writeTextAtomic(params.filePath, "{}\\n");
        }
        const writer = { persist };
        await writer.persist({ filePath: "sessions.json" });
      `,
      "src/runtime/object-wrapper-shorthand-alias.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 7 }]);
  });

  it("flags object wrapper property aliases", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }) {
          return writeTextAtomic(params.filePath, "{}\\n");
        }
        const writer = { save: persist };
        await writer.save({ filePath: "sessions.json" });
      `,
      "src/runtime/object-wrapper-property-alias.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 7 }]);
  });

  it("flags object wrapper methods copied through property access aliases", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/object-wrapper-property-access-alias.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 12 }]);
  });

  it("flags object wrapper methods copied through whole-object aliases", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/object-wrapper-whole-object-alias.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 12 }]);
  });

  it("flags nested object wrapper methods copied through property access aliases", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/nested-object-wrapper-property-access-alias.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 14 }]);
  });

  it("flags destructured object wrapper methods from deep property paths", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/deep-object-wrapper-destructured-method.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 16 }]);
  });

  it("flags nested object wrapper methods copied through destructuring aliases", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/nested-object-wrapper-destructured-alias.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 14 }]);
  });

  it("flags nested object wrapper methods copied through identifier-valued properties", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/nested-object-wrapper-identifier-property-alias.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 12 }]);
  });

  it("clears stale nested object wrapper methods after object literal overwrites", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/nested-object-wrapper-literal-overwrite.ts",
    );

    expect(violations).toEqual([]);
  });

  it("flags object wrapper methods copied through object spreads", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/object-wrapper-object-spread-alias.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 12 }]);
  });

  it("flags nested object wrapper methods", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/nested-object-wrapper-method.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 13 }]);
  });

  it("flags top-level nested object wrapper methods", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        const writer = {
          nested: {
            save(filePath: string) {
              return fs.writeFile(filePath, "{}\\n");
            },
          },
        };
        await writer.nested.save("sessions.json");
      `,
      "src/runtime/top-level-nested-object-wrapper-method.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 10 }]);
  });

  it("flags top-level nested object wrapper methods copied through shorthand properties", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        const nested = {
          save(filePath: string) {
            return fs.writeFile(filePath, "{}\\n");
          },
        };
        const writer = { nested };
        await writer.nested.save("sessions.json");
      `,
      "src/runtime/top-level-nested-object-wrapper-shorthand.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 9 }]);
  });

  it("flags top-level nested object wrapper methods copied through identifier properties", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        const nested = {
          save(filePath: string) {
            return fs.writeFile(filePath, "{}\\n");
          },
        };
        const writer = { child: nested };
        await writer.child.save("sessions.json");
      `,
      "src/runtime/top-level-nested-object-wrapper-identifier-property.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 9 }]);
  });

  it("flags top-level nested object wrapper methods copied through property access aliases", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/top-level-nested-object-wrapper-property-access-alias.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 11 }]);
  });

  it("clears top-level object wrapper methods overwritten with undefined", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        function save(filePath: string) {
          return fs.writeFile(filePath, "{}\\n");
        }
        const writer = { save, save: undefined };
        await writer.save?.("sessions.json");
      `,
      "src/runtime/top-level-object-wrapper-undefined-overwrite.ts",
    );

    expect(violations).toEqual([]);
  });

  it("clears top-level nested object wrapper methods overwritten with undefined", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/top-level-nested-object-wrapper-undefined-overwrite.ts",
    );

    expect(violations).toEqual([]);
  });

  it("does not copy object wrapper methods from shadowed objects", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/shadowed-object-wrapper-method-alias.ts",
    );

    expect(violations).toEqual([]);
  });

  it("flags nested object wrapper methods assigned through object properties", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/nested-object-wrapper-property-object-assignment.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 12 }]);
  });

  it("flags top-level nested object wrapper methods assigned through object properties", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        const writer: any = {};
        writer.nested = {
          save(filePath: string) {
            return fs.writeFile(filePath, "{}\\n");
          },
        };
        await writer.nested.save("sessions.json");
      `,
      "src/runtime/top-level-nested-object-wrapper-property-object-assignment.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 9 }]);
  });

  it("flags nested object wrapper methods assigned through deep object properties", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          const writer: any = { nested: {} };
          writer.nested.save = () => fs.writeFile(filePath, "{}\\n");
          return writer.nested.save();
        }
        await persist("sessions.json");
      `,
      "src/runtime/nested-object-wrapper-deep-property-assignment.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 8 }]);
  });

  it("clears stale nested object wrapper methods after property reassignment", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/nested-object-wrapper-property-object-reassignment.ts",
    );

    expect(violations).toEqual([]);
  });

  it("clears object wrapper property aliases overwritten with undefined", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          const save = () => fs.writeFile(filePath, "{}\\n");
          const writer = { save, save: undefined };
          return writer.save?.();
        }
        await persist("sessions.json");
      `,
      "src/runtime/object-wrapper-property-undefined-overwrite.ts",
    );

    expect(violations).toEqual([]);
  });

  it("flags object wrapper methods assigned after declaration", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        let writer: any = {};
        writer = {
          persist(params: { filePath: string }) {
            return writeTextAtomic(params.filePath, "{}\\n");
          },
        };
        await writer.persist({ filePath: "sessions.json" });
      `,
      "src/runtime/assigned-object-wrapper-method.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 9 }]);
  });

  it("clears object wrapper metadata after object reassignment", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        let writer: any = {
          persist(params: { filePath: string }) {
            return writeTextAtomic(params.filePath, "{}\\n");
          },
        };
        writer = customWriter;
        await writer.persist({ filePath: "sessions.json" });
      `,
      "src/runtime/reassigned-object-wrapper-method.ts",
    );

    expect(violations).toEqual([]);
  });

  it("uses branch-local object wrapper metadata after conditional reassignment", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/conditional-object-wrapper-reassignment.ts",
    );

    expect(violations).toEqual([]);
  });

  it("flags object wrapper property assignments", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        const writer: any = {};
        writer.persist = (params: { filePath: string }) => writeTextAtomic(params.filePath, "{}\\n");
        await writer.persist({ filePath: "sessions.json" });
      `,
      "src/runtime/object-wrapper-property-assignment.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 5 }]);
  });

  it("flags nested object wrapper methods copied through property access spreads", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/nested-object-wrapper-property-access-spread.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 11 }]);
  });

  it("flags extracted object wrapper methods", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        const writer = {
          persist(params: { filePath: string }) {
            return writeTextAtomic(params.filePath, "{}\\n");
          },
        };
        const save = writer.persist;
        await save({ filePath: "sessions.json" });
      `,
      "src/runtime/extracted-object-wrapper-method.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 9 }]);
  });

  it("flags extracted bracket object wrapper methods", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        const writer = {
          persist(params: { filePath: string }) {
            return writeTextAtomic(params.filePath, "{}\\n");
          },
        };
        const save = writer["persist"];
        await save({ filePath: "sessions.json" });
      `,
      "src/runtime/extracted-bracket-object-wrapper-method.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 9 }]);
  });

  it("flags reassigned aliases from object wrapper methods", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        const writer = {
          persist(params: { filePath: string }) {
            return writeTextAtomic(params.filePath, "{}\\n");
          },
        };
        let save;
        save = writer.persist;
        await save({ filePath: "sessions.json" });
      `,
      "src/runtime/reassigned-object-wrapper-method-alias.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 10 }]);
  });

  it("flags destructured object wrapper methods", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        const writer = {
          persist(params: { filePath: string }) {
            return writeTextAtomic(params.filePath, "{}\\n");
          },
        };
        const { persist } = writer;
        await persist({ filePath: "sessions.json" });
      `,
      "src/runtime/destructured-object-wrapper-method.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 9 }]);
  });

  it("flags renamed destructured object wrapper methods", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        const writer = {
          persist(params: { filePath: string }) {
            return writeTextAtomic(params.filePath, "{}\\n");
          },
        };
        const { persist: save } = writer;
        await save({ filePath: "sessions.json" });
      `,
      "src/runtime/renamed-destructured-object-wrapper-method.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 9 }]);
  });

  it("flags defaulted destructured object wrapper methods", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          const writer = {};
          const { save = () => fs.writeFile(filePath, "{}\\n") } = writer;
          return save();
        }
        await persist("sessions.json");
      `,
      "src/runtime/defaulted-destructured-object-wrapper-method.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 8 }]);
  });

  it("does not use destructured wrapper defaults when safe callbacks are present", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        const noopParam = async (_path: string) => {};
        function persist(filePath: string) {
          const writer = { save: noopParam };
          const { save = () => fs.writeFile(filePath, "{}\\n") } = writer;
          return save(filePath);
        }
        await persist("sessions.json");
      `,
      "src/runtime/present-safe-callback-destructured-default.ts",
    );

    expect(violations).toEqual([]);
  });

  it("uses destructured wrapper defaults when properties are explicitly undefined", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        function persist(filePath: string) {
          const writer = { save: undefined };
          const { save = () => fs.writeFile(filePath, "{}\\n") } = writer;
          return save();
        }
        await persist("sessions.json");
      `,
      "src/runtime/undefined-callback-destructured-default.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 8 }]);
  });

  it("uses destructured wrapper defaults when properties are aliased undefined", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        const absent = undefined;
        function persist(filePath: string) {
          const writer = { save: absent };
          const { save = () => fs.writeFile(filePath, "{}\\n") } = writer;
          return save();
        }
        await persist("sessions.json");
      `,
      "src/runtime/aliased-undefined-callback-destructured-default.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 9 }]);
  });

  it("does not use destructured wrapper defaults after unknown spreads", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        function persist(filePath: string, options: { save?: () => Promise<void> }) {
          const writer = { save: undefined, ...options };
          const { save = () => fs.writeFile(filePath, "{}\\n") } = writer;
          return save();
        }
        await persist("sessions.json", { save: async () => {} });
      `,
      "src/runtime/object-wrapper-destructuring-default-unknown-spread.ts",
    );

    expect(violations).toEqual([]);
  });

  it("does not force destructured wrapper defaults from unknown spread objects", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        function persist(filePath: string, defaults: { save?: () => Promise<void> }) {
          const writer = { ...defaults };
          const { save = () => fs.writeFile(filePath, "{}\\n") } = writer;
          return save();
        }
        await persist("sessions.json", { save: async () => {} });
      `,
      "src/runtime/object-wrapper-destructuring-default-unknown-spread-object.ts",
    );

    expect(violations).toEqual([]);
  });

  it("does not force closed-over destructured wrapper defaults from unknown spread objects", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/object-wrapper-destructuring-default-unknown-spread-object-closed-over.ts",
    );

    expect(violations).toEqual([]);
  });

  it("keeps branch-only object wrapper methods after exhaustive merge", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/branch-only-object-wrapper-method.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 17 }]);
  });

  it("keeps branch-only property assigned object wrapper methods after exhaustive merge", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/branch-only-property-object-wrapper-method.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 12 }]);
  });

  it("keeps prior nested wrapper values when only one branch assigns", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/prior-wrapper-value-branch-assignment.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 11 }]);
  });

  it("clears wrapper metadata after non-wrapper reassignment", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        let persist = (params: { filePath: string }) => writeTextAtomic(params.filePath, "{}\\n");
        persist = customSink;
        persist({ filePath: "sessions.json" });
      `,
      "src/runtime/cleared-wrapper-variable.ts",
    );

    expect(violations).toEqual([]);
  });

  it("keeps wrapper metadata after conditional non-wrapper reassignment", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        let persist = (params: { filePath: string }) => writeTextAtomic(params.filePath, "{}\\n");
        if (ready) persist = customSink;
        persist({ filePath: "sessions.json" });
      `,
      "src/runtime/conditional-cleared-wrapper-variable.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 5 }]);
  });

  it("clears wrapper metadata after exhaustive non-wrapper reassignments", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        let persist = (params: { filePath: string }) => writeTextAtomic(params.filePath, "{}\\n");
        if (ready) persist = customSink;
        else persist = customSink;
        persist({ filePath: "sessions.json" });
      `,
      "src/runtime/exhaustive-cleared-wrapper-variable.ts",
    );

    expect(violations).toEqual([]);
  });

  it("keeps wrapper metadata after try-block non-wrapper reassignment", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        let persist = (params: { filePath: string }) => writeTextAtomic(params.filePath, "{}\\n");
        try {
          maybeThrow();
          persist = customSink;
        } catch {}
        persist({ filePath: "sessions.json" });
      `,
      "src/runtime/try-cleared-wrapper-variable.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 8 }]);
  });

  it("flags wrapper option paths read through bracket property access", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }) {
          return writeTextAtomic(params["filePath"], "{}\\n");
        }
        persist({ filePath: "sessions.json" });
      `,
      "src/runtime/bracket-wrapper-property.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 6 }]);
  });

  it("does not treat custom writeFile methods as wrapper filesystem writes", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        function persist(writer: { writeFile: (path: string, content: string) => void }, params: { filePath: string }) {
          return writer.writeFile(params.filePath, "{}\\n");
        }
        persist(customWriter, { filePath: "sessions.json" });
      `,
      "src/runtime/custom-writer-method-wrapper.ts",
    );

    expect(violations).toEqual([]);
  });

  it("does not use outer wrapper metadata for shadowed wrapper names", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/shadowed-wrapper-options.ts",
    );

    expect(violations).toEqual([]);
  });

  it("does not let loop-scoped wrapper names shadow outer wrappers", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeJson } from "../infra/json-files.js";
        function persist(options: { store: string }) {
          return writeJson(options.store, {});
        }
        for (const persist of handlers) {
          await persist(currentOptions);
        }
        await persist({ store: "sessions.json" });
      `,
      "src/runtime/loop-scoped-wrapper-name.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 9 }]);
  });

  it("does not use outer wrapper metadata for destructured parameter wrapper names", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeJson } from "../infra/json-files.js";
        function persist(options: { store: string }) {
          return writeJson(options.store, {});
        }
        function caller({ persist }: { persist: (options: { store: string }) => void }) {
          persist({ store: "sessions.json" });
        }
      `,
      "src/runtime/destructured-wrapper-name-parameter.ts",
    );

    expect(violations).toEqual([]);
  });

  it("does not treat sibling object metadata as the wrapper path property", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }) {
          return writeTextAtomic(params.filePath, "{}\\n");
        }
        const params = { label: "sessions.json", filePath: currentSqlitePath };
        await persist(params);
      `,
      "src/runtime/current-path-sibling-metadata.ts",
    );

    expect(violations).toEqual([]);
  });

  it("does not treat custom writeFile methods as direct filesystem writes", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        const params = { filePath: "sessions.json" };
        await customWriter.writeFile(params.filePath, "{}\\n");
      `,
      "src/runtime/custom-writer-method.ts",
    );

    expect(violations).toEqual([]);
  });

  it("flags legacy paths written through injected fs handles", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        const storePath = "sessions.json";
        const params: { deps: { fs: typeof import("node:fs") } } = { deps };
        await params.deps.fs.promises.writeFile(storePath, "{}\\n");
      `,
      "src/runtime/injected-fs-write.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 4 }]);
  });

  it("does not treat custom fs properties as direct filesystem writes", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        const storePath = "sessions.json";
        await client.fs.promises.writeFile(storePath, "{}\\n");
      `,
      "src/runtime/custom-fs-property.ts",
    );

    expect(violations).toEqual([]);
  });

  it("updates object path metadata after property assignment", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        const params = { filePath: currentSqlitePath };
        params.filePath = "sessions.json";
        writeTextAtomic(params.filePath, "{}\\n");
      `,
      "src/runtime/assigned-object-path.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 5 }]);
  });

  it("updates object path metadata after bracket property assignment", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        const params = { filePath: currentSqlitePath };
        params["filePath"] = "sessions.json";
        writeTextAtomic(params["filePath"], "{}\\n");
      `,
      "src/runtime/bracket-assigned-object-path.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 5 }]);
  });

  it("updates outer object path metadata after nested property assignment", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        const params = { filePath: currentSqlitePath };
        {
          params.filePath = "sessions.json";
        }
        writeTextAtomic(params.filePath, "{}\\n");
      `,
      "src/runtime/nested-assigned-object-path.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 7 }]);
  });

  it("flags nested property assignments forwarded through option objects", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        function persist({ paths: { filePath } }: { paths: { filePath: string } }) {
          return fs.writeFile(filePath, "{}\\n");
        }
        const options = { paths: {} };
        options.paths.filePath = "sessions.json";
        await persist(options);
      `,
      "src/runtime/nested-wrapper-option-property-assignment.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 8 }]);
  });

  it("flags nested property assignments read directly by filesystem writes", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        const options = { paths: {} };
        options.paths.filePath = "sessions.json";
        await fs.writeFile(options.paths.filePath, "{}\\n");
      `,
      "src/runtime/nested-direct-property-assignment.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 5 }]);
  });

  it("flags nested parent object assignments forwarded through option objects", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        function persist({ paths: { filePath } }: { paths: { filePath: string } }) {
          return fs.writeFile(filePath, "{}\\n");
        }
        const options = { paths: {} };
        options.paths = { filePath: "sessions.json" };
        await persist(options);
      `,
      "src/runtime/nested-wrapper-option-parent-assignment.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 8 }]);
  });

  it("flags nested defaults after parent object property assignments", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        function persist({ paths: { filePath = "sessions.json" } }: { paths: { filePath?: string } }) {
          return fs.writeFile(filePath, "{}\\n");
        }
        const options = {};
        options.paths = {};
        await persist(options);
      `,
      "src/runtime/nested-wrapper-option-parent-known-empty-assignment.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 8 }]);
  });

  it("clears nested path metadata after parent object assignments", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        function persist({ paths: { filePath } }: { paths: { filePath: string } }) {
          return fs.writeFile(filePath, "{}\\n");
        }
        const options = { paths: { filePath: "sessions.json" } };
        options.paths = { filePath: "current-state.json" };
        await persist(options);
      `,
      "src/runtime/nested-wrapper-option-parent-current-assignment.ts",
    );

    expect(violations).toEqual([]);
  });

  it("keeps maybe missing nested properties after conditional parent object assignments", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        function persist({ paths: { filePath = "sessions.json" } }: { paths: { filePath?: string } }) {
          return fs.writeFile(filePath, "{}\\n");
        }
        const options = { paths: { filePath: "state/openclaw.sqlite" } };
        if (Math.random() > 0.5) {
          options.paths = {};
        }
        await persist(options);
      `,
      "src/runtime/conditional-nested-parent-missing-property.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 10 }]);
  });

  it("clears object path metadata after current-path assignment", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        const params = { filePath: "sessions.json" };
        params.filePath = currentSqlitePath;
        writeTextAtomic(params.filePath, "{}\\n");
      `,
      "src/runtime/reassigned-object-path.ts",
    );

    expect(violations).toEqual([]);
  });

  it("keeps legacy object metadata after conditional current-path assignment", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        const params = { filePath: "sessions.json" };
        if (ready) params.filePath = currentSqlitePath;
        writeTextAtomic(params.filePath, "{}\\n");
      `,
      "src/runtime/conditional-current-object-path.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 5 }]);
  });

  it("keeps maybe missing properties after conditional safe property assignments", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        const options = {};
        if (ready) options.path = currentSqlitePath;
        function writePath(filePath: string, { path = filePath } = {}) {
          return fs.writeFile(path, "{}\\n");
        }
        await writePath("sessions.json", options);
      `,
      "src/runtime/conditional-safe-property-missing-default.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 8 }]);
  });

  it("keeps legacy object metadata after loop current-path assignment", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        const params = { filePath: "sessions.json" };
        while (ready) params.filePath = currentSqlitePath;
        writeTextAtomic(params.filePath, "{}\\n");
      `,
      "src/runtime/loop-current-object-path.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 5 }]);
  });

  it("does not let for-loop object bindings clear outer object metadata", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        const params = { filePath: "sessions.json" };
        for (const params = { filePath: currentSqlitePath }; ready; advance()) {
          await use(params);
        }
        writeTextAtomic(params.filePath, "{}\\n");
      `,
      "src/runtime/for-loop-object-shadow.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 7 }]);
  });

  it("does not leak for-loop legacy object bindings after the loop", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        const params = { filePath: currentSqlitePath };
        for (const params = { filePath: "sessions.json" }; ready; advance()) {
          await use(params);
        }
        writeTextAtomic(params.filePath, "{}\\n");
      `,
      "src/runtime/for-loop-legacy-object-shadow.ts",
    );

    expect(violations).toEqual([]);
  });

  it("keeps legacy object metadata after conditional current-object assignment", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        let params = { filePath: "sessions.json" };
        if (ready) {
          params = { filePath: currentSqlitePath };
        }
        writeTextAtomic(params.filePath, "{}\\n");
      `,
      "src/runtime/conditional-current-object.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 7 }]);
  });

  it("clears object metadata after exhaustive current-object assignments", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        let params = { filePath: "sessions.json" };
        if (ready) {
          params = { filePath: currentSqlitePath };
        } else {
          params = { filePath: currentSqlitePath };
        }
        writeTextAtomic(params.filePath, "{}\\n");
      `,
      "src/runtime/exhaustive-current-object.ts",
    );

    expect(violations).toEqual([]);
  });

  it("keeps outer object metadata after optional exhaustive current-object assignments", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/optional-exhaustive-current-object.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 11 }]);
  });

  it("allows branch-local writes after nested exhaustive current-object assignments", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/branch-local-exhaustive-current-object.ts",
    );

    expect(violations).toEqual([]);
  });

  it("keeps object metadata when one exhaustive branch keeps a legacy object", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        let params = { filePath: "sessions.json" };
        if (ready) {
          params = { filePath: currentSqlitePath };
        } else {
          params = { filePath: "sessions.json" };
        }
        writeTextAtomic(params.filePath, "{}\\n");
      `,
      "src/runtime/exhaustive-mixed-object.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 9 }]);
  });

  it("clears object property metadata after exhaustive current-path assignments", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        const params = { filePath: "sessions.json" };
        if (ready) {
          params.filePath = currentSqlitePath;
        } else {
          params.filePath = currentSqlitePath;
        }
        writeTextAtomic(params.filePath, "{}\\n");
      `,
      "src/runtime/exhaustive-current-object-property.ts",
    );

    expect(violations).toEqual([]);
  });

  it("keeps legacy object metadata after try-block current-object assignment", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        let params = { filePath: "sessions.json" };
        try {
          maybeThrow();
          params = { filePath: currentSqlitePath };
        } catch {}
        writeTextAtomic(params.filePath, "{}\\n");
      `,
      "src/runtime/try-current-object.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 8 }]);
  });

  it("clears outer object path metadata after nested current-path assignment", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        const params = { filePath: "sessions.json" };
        {
          params.filePath = currentSqlitePath;
        }
        writeTextAtomic(params.filePath, "{}\\n");
      `,
      "src/runtime/nested-reassigned-object-path.ts",
    );

    expect(violations).toEqual([]);
  });

  it("allows in-branch writes after object property reassignment to the current path", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        const params = { filePath: "sessions.json" };
        if (ready) {
          params.filePath = currentSqlitePath;
          writeTextAtomic(params.filePath, "{}\\n");
        }
      `,
      "src/runtime/branch-reassigned-object-property.ts",
    );

    expect(violations).toEqual([]);
  });

  it("updates object path metadata after whole-object assignment", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        let params = { filePath: currentSqlitePath };
        params = { filePath: "sessions.json" };
        writeTextAtomic(params.filePath, "{}\\n");
      `,
      "src/runtime/reassigned-object.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 5 }]);
  });

  it("clears object path metadata after whole-object current-path assignment", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        let params = { filePath: "sessions.json" };
        params = { filePath: currentSqlitePath };
        writeTextAtomic(params.filePath, "{}\\n");
      `,
      "src/runtime/reassigned-current-object.ts",
    );

    expect(violations).toEqual([]);
  });

  it("flags legacy paths destructured from tracked object properties", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        const params = { filePath: "sessions.json" };
        const { filePath } = params;
        writeTextAtomic(filePath, "{}\\n");
      `,
      "src/runtime/destructured-tracked-object-path.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 5 }]);
  });

  it("flags legacy paths from nested destructured object properties", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        const params = { nested: { filePath: "sessions.json" } };
        const { nested: { filePath } } = params;
        writeTextAtomic(filePath, "{}\\n");
      `,
      "src/runtime/nested-destructured-tracked-object-path.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 5 }]);
  });

  it("uses tracked nested current paths before destructured defaults", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        const params = { nested: { filePath: currentSqlitePath } };
        const { nested: { filePath = "sessions.json" } } = params;
        writeTextAtomic(filePath, "{}\\n");
      `,
      "src/runtime/nested-destructured-current-object-path.ts",
    );

    expect(violations).toEqual([]);
  });

  it("flags nested defaults after conditional whole-object rewrites omit safe properties", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist({ paths: { filePath = "sessions.json" } }: { paths: { filePath?: string } }) {
          return writeTextAtomic(filePath, "{}\\n");
        }
        let options = { paths: { filePath: currentSqlitePath } };
        if (ready) {
          options = { paths: {} };
        }
        await persist(options);
      `,
      "src/runtime/conditional-whole-object-rewrite-nested-default.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 10 }]);
  });

  it("flags nested defaults after conditional whole-object rewrites from known aliases", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/conditional-whole-object-rewrite-alias-nested-default.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 11 }]);
  });

  it("flags legacy paths from destructured default values", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        const params = {};
        const { filePath = "sessions.json" } = params;
        writeTextAtomic(filePath, "{}\\n");
      `,
      "src/runtime/destructured-default-object-path.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 5 }]);
  });

  it("flags legacy paths from inline object destructured default values", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        const { filePath = "sessions.json" } = {};
        writeTextAtomic(filePath, "{}\\n");
      `,
      "src/runtime/inline-destructured-default-object-path.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 4 }]);
  });

  it("flags legacy paths from inline destructured object descendants", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        const { paths } = { paths: { filePath: "sessions.json" } };
        writeTextAtomic(paths.filePath, "{}\\n");
      `,
      "src/runtime/inline-destructured-object-descendant-path.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 4 }]);
  });

  it("flags legacy paths destructured from tracked nested properties", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        const options = { paths: { filePath: "sessions.json" } };
        const { filePath } = options.paths;
        writeTextAtomic(filePath, "{}\\n");
      `,
      "src/runtime/destructured-tracked-nested-property-path.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 5 }]);
  });

  it("does not force inline object destructured defaults after unknown spreads", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        declare const defaults: { filePath?: string };
        const { filePath = "sessions.json" } = { ...defaults };
        writeTextAtomic(filePath, "{}\\n");
      `,
      "src/runtime/inline-destructured-default-unknown-spread.ts",
    );

    expect(violations).toEqual([]);
  });

  it("flags destructured defaults from explicitly undefined tracked properties", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        const params = { filePath: undefined };
        const { filePath = "sessions.json" } = params;
        writeTextAtomic(filePath, "{}\\n");
      `,
      "src/runtime/destructured-default-explicit-undefined-object-path.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 5 }]);
  });

  it("flags wrapper defaults from destructured missing tracked properties", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        const params = {};
        function persist({ path = "sessions.json" }: { path?: string }) {
          return fs.writeFile(path, "{}\\n");
        }
        const { filePath } = params;
        await persist({ path: filePath });
      `,
      "src/runtime/destructured-missing-property-wrapper-default.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 8 }]);
  });

  it("flags wrapper defaults from inline destructured missing properties", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        function persist({ path = "sessions.json" }: { path?: string }) {
          return fs.writeFile(path, "{}\\n");
        }
        const { filePath } = {};
        await persist({ path: filePath });
      `,
      "src/runtime/inline-destructured-missing-property-wrapper-default.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 7 }]);
  });

  it("flags destructured defaults from aliased undefined tracked properties", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        const absent = undefined;
        const params = { filePath: absent };
        const { filePath = "sessions.json" } = params;
        writeTextAtomic(filePath, "{}\\n");
      `,
      "src/runtime/destructured-default-aliased-undefined-object-path.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 6 }]);
  });

  it("uses tracked object properties before destructured defaults", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        const params = { filePath: currentSqlitePath };
        const { filePath = "sessions.json" } = params;
        writeTextAtomic(filePath, "{}\\n");
      `,
      "src/runtime/destructured-default-current-object-path.ts",
    );

    expect(violations).toEqual([]);
  });

  it("flags wrapper shorthand options destructured from tracked object properties", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }) {
          return writeTextAtomic(params.filePath, "{}\\n");
        }
        const params = { filePath: "sessions.json" };
        const { filePath } = params;
        persist({ filePath });
      `,
      "src/runtime/destructured-shorthand-wrapper-path.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 8 }]);
  });

  it("does not treat unrelated property names as destructured wrapper paths", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist({ filePath }: { filePath: string }) {
          return writeTextAtomic(current.filePath, "{}\\n");
        }
        await persist({ filePath: "sessions.json" });
      `,
      "src/runtime/unrelated-property-name-wrapper.ts",
    );

    expect(violations).toEqual([]);
  });

  it("flags wrapper option paths forwarded through object aliases", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeJson } from "../infra/json-files.js";
        function persist(options: { store: string }) {
          return writeJson(options.store, {});
        }
        const params = { store: "sessions.json" };
        const forwarded = params;
        await persist(forwarded);
      `,
      "src/runtime/forwarded-wrapper-options.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 8 }]);
  });

  it("flags wrapper option paths forwarded through destructured object aliases", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { paths: { filePath: string } }) {
          return writeTextAtomic(params.paths.filePath, "{}\\n");
        }
        const options = { paths: { filePath: "sessions.json" } };
        const { paths } = options;
        await persist({ paths });
      `,
      "src/runtime/wrapper-option-path-destructured-object-alias.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 8 }]);
  });

  it("does not treat sibling nested properties as wrapper option paths", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/wrapper-option-path-nested-sibling-property.ts",
    );

    expect(violations).toEqual([]);
  });

  it("clears nested wrapper option paths after object literal spread overwrites", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        function persist({ paths: { filePath = currentSqlitePath } = {} }) {
          return fs.writeFile(filePath, "{}\\n");
        }
        const params = {
          paths: { filePath: "sessions.json" },
          ...{ paths: {} },
        };
        await persist(params);
      `,
      "src/runtime/wrapper-option-path-object-spread-overwrite.ts",
    );

    expect(violations).toEqual([]);
  });

  it("clears known nested wrapper option paths after parent rewrites", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        declare function loadNested(): { filePath?: string };
        function persist({ paths: { nested: { filePath = "sessions.json" } = {} } }) {
          return fs.writeFile(filePath, "{}\\n");
        }
        const options = { paths: { nested: {} } };
        options.paths = { nested: loadNested() };
        await persist(options);
      `,
      "src/runtime/wrapper-option-path-parent-rewrite-unknown-nested.ts",
    );

    expect(violations).toEqual([]);
  });

  it("flags wrapper option paths forwarded through object spreads", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeJson } from "../infra/json-files.js";
        function persist(options: { store: string }) {
          return writeJson(options.store, {});
        }
        const params = { store: "sessions.json" };
        const forwarded = { ...params };
        await persist(forwarded);
      `,
      "src/runtime/spread-wrapper-options.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 8 }]);
  });

  it("flags wrapper option paths passed through inline object spreads", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeJson } from "../infra/json-files.js";
        function persist(options: { store: string }) {
          return writeJson(options.store, {});
        }
        const params = { store: "sessions.json" };
        await persist({ ...params });
        await persist({ store: currentSqlitePath, ...params });
      `,
      "src/runtime/inline-spread-wrapper-options.ts",
    );

    expect(violations).toEqual([
      { kind: "legacy store filesystem write", line: 7 },
      { kind: "legacy store filesystem write", line: 8 },
    ]);
  });

  it("flags wrapper option paths passed through inline object literal spreads", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeJson } from "../infra/json-files.js";
        function persist(options: { store: string }) {
          return writeJson(options.store, {});
        }
        await persist({ ...{ store: "sessions.json" } });
        const params = { ...{ store: "sessions.json" } };
        await persist(params);
      `,
      "src/runtime/inline-object-literal-spread-wrapper-options.ts",
    );

    expect(violations).toEqual([
      { kind: "legacy store filesystem write", line: 6 },
      { kind: "legacy store filesystem write", line: 8 },
    ]);
  });

  it("allows inline object spreads when a later property overrides the legacy path", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeJson } from "../infra/json-files.js";
        function persist(options: { store: string }) {
          return writeJson(options.store, {});
        }
        const params = { store: "sessions.json" };
        await persist({ ...params, store: currentSqlitePath });
      `,
      "src/runtime/inline-spread-wrapper-options.ts",
    );

    expect(violations).toEqual([]);
  });

  it("allows inline object literal spreads when a later property overrides the legacy path", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeJson } from "../infra/json-files.js";
        function persist(options: { store: string }) {
          return writeJson(options.store, {});
        }
        await persist({ ...{ store: "sessions.json" }, store: currentSqlitePath });
        await persist({ store: "sessions.json", ...{ store: currentSqlitePath } });
      `,
      "src/runtime/inline-object-literal-spread-current-wrapper-options.ts",
    );

    expect(violations).toEqual([]);
  });

  it("allows inline object spreads when a later spread overrides the legacy path", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeJson } from "../infra/json-files.js";
        function persist(options: { store: string }) {
          return writeJson(options.store, {});
        }
        const currentOptions = { store: currentSqlitePath };
        await persist({ store: "sessions.json", ...currentOptions });
      `,
      "src/runtime/inline-current-spread-wrapper-options.ts",
    );

    expect(violations).toEqual([]);
  });

  it("allows nested inline object spreads when a later spread overrides the legacy path", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeJson } from "../infra/json-files.js";
        function persist({ paths: { filePath } }: { paths: { filePath: string } }) {
          return writeJson(filePath, {});
        }
        await persist({
          paths: { filePath: "sessions.json" },
          ...{ paths: { filePath: currentSqlitePath } },
        });
      `,
      "src/runtime/nested-inline-current-spread-wrapper-options.ts",
    );

    expect(violations).toEqual([]);
  });

  it("does not copy wrapper option metadata from shadowed source objects", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/shadowed-forwarded-wrapper-options.ts",
    );

    expect(violations).toEqual([]);
  });

  it("does not treat shadowed fs alias names as wrapper filesystem writes", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeFile } from "node:fs/promises";
        function persist(writeFile: (path: string, value: string) => void, params: { filePath: string }) {
          return writeFile(params.filePath, "{}\\n");
        }
        await persist(customSink, { filePath: "sessions.json" });
      `,
      "src/runtime/shadowed-fs-alias-wrapper.ts",
    );

    expect(violations).toEqual([]);
  });

  it("does not treat block-shadowed fs alias names as wrapper filesystem writes", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeFile } from "node:fs/promises";
        {
          const writeFile = customSink;
          function persist(params: { filePath: string }) {
            return writeFile(params.filePath, "{}\\n");
          }
          persist({ filePath: "sessions.json" });
        }
      `,
      "src/runtime/block-shadowed-fs-alias-wrapper.ts",
    );

    expect(violations).toEqual([]);
  });

  it("does not treat destructures from shadowed fs module names as wrapper filesystem writes", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import fs from "node:fs/promises";
        function persist(params: { filePath: string }) {
          const fs = customFs;
          const { writeFile } = fs;
          return writeFile(params.filePath, "{}\\n");
        }
        persist({ filePath: "sessions.json" });
      `,
      "src/runtime/shadowed-fs-module-wrapper.ts",
    );

    expect(violations).toEqual([]);
  });

  it("does not treat shadowed wrapper parameter objects as argument paths", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }) {
          {
            const params = { filePath: currentSqlitePath };
            writeTextAtomic(params.filePath, "{}\\n");
          }
        }
        await persist({ filePath: "sessions.json" });
      `,
      "src/runtime/shadowed-wrapper-parameter-object.ts",
    );

    expect(violations).toEqual([]);
  });

  it("does not keep object metadata for uninitialized local shadows", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        const params = { filePath: "sessions.json" };
        {
          let params;
          writeTextAtomic(params.filePath, "{}\\n");
        }
      `,
      "src/runtime/uninitialized-object-shadow.ts",
    );

    expect(violations).toEqual([]);
  });

  it("keeps catch binding shadows scoped to the catch block", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        const params = { filePath: "sessions.json" };
        try {
          await load();
        } catch (params) {
          writeTextAtomic(params.filePath, "{}\\n");
        }
        writeTextAtomic(params.filePath, "{}\\n");
      `,
      "src/runtime/catch-object-shadow.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 9 }]);
  });

  it("keeps closed-over catch binding shadows scoped to the catch block", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/nested-wrapper-catch-shadow.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 14 }]);
  });

  it("keeps wrapper catch binding shadows scoped to the catch block", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
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
      `,
      "src/runtime/wrapper-catch-object-shadow.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 11 }]);
  });

  it("does not keep object metadata for destructured local shadows", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        const params = { filePath: "sessions.json" };
        {
          const { params } = source;
          writeTextAtomic(params.filePath, "{}\\n");
        }
      `,
      "src/runtime/destructured-object-shadow.ts",
    );

    expect(violations).toEqual([]);
  });

  it("does not let unrelated nested fs aliases mark custom writes", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import fs from "node:fs/promises";
        import { writeFile } from "./custom-writer.js";
        await writeFile("sessions.json", "{}\\n");
        function later() {
          const { writeFile } = fs;
          return writeFile(currentSqlitePath, "{}\\n");
        }
      `,
      "src/runtime/custom-writer-shadow.ts",
    );

    expect(violations).toEqual([]);
  });

  it("does not use caller block fs aliases for outer wrapper bodies", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import fs from "node:fs/promises";
        import { writeFile } from "./custom-writer.js";
        function persist(params: { filePath: string }) {
          return writeFile(params.filePath, "{}\\n");
        }
        {
          const { writeFile } = fs;
          await persist({ filePath: "sessions.json" });
        }
      `,
      "src/runtime/caller-block-alias-wrapper.ts",
    );

    expect(violations).toEqual([]);
  });

  it("does not leak block-scoped fs aliases across wrapper body scopes", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import fs from "node:fs/promises";
        function persist(params: { filePath: string }) {
          {
            const { writeFile } = fs;
            writeFile(currentSqlitePath, "{}\\n");
          }
          return writeFile(params.filePath, "{}\\n");
        }
        await persist({ filePath: "sessions.json" });
      `,
      "src/runtime/block-scoped-fs-alias-wrapper.ts",
    );

    expect(violations).toEqual([]);
  });

  it("ignores shadowed destructured wrapper option names", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist({ filePath }: { filePath: string }) {
          {
            const filePath = currentSqlitePath;
            writeTextAtomic(filePath, "{}\\n");
          }
        }
        await persist({ filePath: "sessions.json" });
      `,
      "src/runtime/shadowed-destructured-wrapper-options.ts",
    );

    expect(violations).toEqual([]);
  });

  it("keeps earlier destructured wrapper option uses before later shadowing", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist({ filePath }: { filePath: string }) {
          writeTextAtomic(filePath, "{}\\n");
          {
            const filePath = currentSqlitePath;
          }
        }
        await persist({ filePath: "sessions.json" });
      `,
      "src/runtime/late-shadowed-destructured-wrapper-options.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 9 }]);
  });

  it("does not leak legacy path variable names across lexical scopes", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        {
          const storePath = "sessions.json";
        }
        export async function save(storePath: string) {
          await fs.writeFile(storePath, "{}\\n", "utf8");
        }
      `,
      "src/runtime/current-store-writer.ts",
    );

    expect(violations).toEqual([]);
  });

  it("lets inner bindings shadow outer legacy path variables", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        const storePath = "sessions.json";
        {
          const storePath = currentSqlitePath;
          await fs.writeFile(storePath, "{}\\n", "utf8");
        }
      `,
      "src/runtime/current-store-writer.ts",
    );

    expect(violations).toEqual([]);
  });

  it("lets inner object properties shadow outer legacy path properties", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        const params = { filePath: "sessions.json" };
        {
          const params = { filePath: currentSqlitePath };
          await writeTextAtomic(params.filePath, "{}\\n");
        }
      `,
      "src/runtime/current-store-writer.ts",
    );

    expect(violations).toEqual([]);
  });

  it("ignores legacy filenames in write payloads", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        await fs.writeFile(reportPath, "sessions.json\\n", "utf8");
        await fs.appendFile(currentLogPath, "cron/runs/job.jsonl\\n", "utf8");
      `,
      "src/runtime/report-writer.ts",
    );

    expect(violations).toEqual([]);
  });

  it("flags runtime writes to sidecar SQLite and JSONL stores", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import fs from "node:fs";
        fs.appendFileSync("cron/runs/job.jsonl", "{}\\n");
        fs.writeFileSync("plugin-state/state.sqlite", "");
      `,
      "extensions/example/src/store.ts",
    );

    expect(violations).toEqual([
      { kind: "legacy store filesystem write", line: 3 },
      { kind: "legacy store filesystem write", line: 4 },
    ]);
  });

  it("flags new writes in current legacy-debt files", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import fs from "node:fs";
        fs.writeFileSync("sessions.json", "{}\\n");
      `,
      "extensions/memory-wiki/src/compile.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 3 }]);
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

  it("allows doctor and migration owners to import or archive legacy files", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        await fs.rename("cron/jobs.json", "cron/jobs.json.migrated");
        await fs.writeFile("sessions.json", "{}\\n", "utf8");
      `,
      "src/commands/doctor/cron/legacy-store-migration.ts",
    );

    expect(violations).toEqual([]);
  });

  it("allows the workspace Doctor migration owner to claim legacy sidecars", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        await fs.rename("openclaw-workspace-state.json", "openclaw-workspace-state.json.doctor-importing");
        await fs.rename("workspace.attested", "workspace.attested.doctor-importing");
      `,
      "src/infra/state-migrations.workspace-setup.ts",
    );

    expect(violations).toEqual([]);
  });

  it("allows plugin doctor migration owners to archive legacy files", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        const statePath = "plugin-state/state.sqlite";
        await fs.rename(statePath, "plugin-state/state.sqlite.migrated");
      `,
      "extensions/example/doctor-contract-api.ts",
    );

    expect(violations).toEqual([]);
  });

  it("flags extension runtime writes under migration-like directories", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        await fs.writeFile("sessions.json", "{}\\n", "utf8");
      `,
      "extensions/example/src/migrations/runtime.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 3 }]);
  });

  it("allows exact QA fixture owners to materialize legacy files", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        const authStorePath = "auth-profiles.json";
        await fs.writeFile(authStorePath, "{}\\n", "utf8");
      `,
      "extensions/qa-lab/src/providers/shared/auth-store.ts",
    );

    expect(violations).toEqual([]);
  });

  it("flags legacy transcript bridge markers in runtime source", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        export const transcriptLocator = "sqlite-transcript://session";
        export const dynamicLocator = \`sqlite-transcript://\${sessionId}\`;
      `,
      "src/runtime/transcript-bridge.ts",
    );

    expect(violations).toEqual([
      { kind: "legacy transcript bridge marker", line: 2 },
      { kind: "legacy transcript bridge marker", line: 3 },
    ]);
  });
});
