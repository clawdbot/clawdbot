import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  FUTURE_FIXTURE_VERSION,
  LEGACY_UPDATE_COMPAT_CHUNKS,
  markFutureUpdateFixture,
  packFutureUpdateFixture,
  removeLegacyUpdateCompatChunks,
} from "../../scripts/e2e/lib/update-first-hop-package-fixtures.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function makePackageFixture() {
  const root = tempDirs.make("openclaw-first-hop-package-");
  writeJson(path.join(root, "package.json"), {
    name: "openclaw",
    version: "2026.8.1",
    dependencies: { "@openclaw/ai": "2026.8.1" },
  });
  writeJson(path.join(root, "dist", "build-info.json"), {
    version: "2026.8.1",
    commit: "a".repeat(40),
    builtAt: "2026-09-02T00:00:00.000Z",
    buildId: "old-build",
  });
  const inventory = [
    "dist/build-info.json",
    ...LEGACY_UPDATE_COMPAT_CHUNKS.map((name) => `dist/${name}`),
    "dist/index.js",
  ];
  writeJson(path.join(root, "dist", "postinstall-inventory.json"), inventory);
  for (const name of LEGACY_UPDATE_COMPAT_CHUNKS) {
    fs.writeFileSync(path.join(root, "dist", name), "export function resolveNodeRunner() {}\n");
  }
  fs.writeFileSync(path.join(root, "dist", "index.js"), "export {};\n");
  return root;
}

describe("first-hop package fixtures", () => {
  it("removes only the declared legacy compatibility inputs", () => {
    const root = makePackageFixture();
    removeLegacyUpdateCompatChunks(root);

    const inventory = JSON.parse(
      fs.readFileSync(path.join(root, "dist", "postinstall-inventory.json"), "utf8"),
    ) as string[];
    expect(inventory).toEqual(["dist/build-info.json", "dist/index.js"]);
    for (const name of LEGACY_UPDATE_COMPAT_CHUNKS) {
      expect(fs.existsSync(path.join(root, "dist", name))).toBe(false);
    }
    expect(fs.readFileSync(path.join(root, "dist", "index.js"), "utf8")).toBe("export {};\n");
  });

  it("marks a distinct future package after the compatibility window closes", () => {
    const root = makePackageFixture();
    markFutureUpdateFixture(root);

    const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    const buildInfo = JSON.parse(
      fs.readFileSync(path.join(root, "dist", "build-info.json"), "utf8"),
    );
    expect(packageJson.version).toBe(FUTURE_FIXTURE_VERSION);
    expect(packageJson.dependencies).toEqual({ "@openclaw/ai": "2026.8.1" });
    expect(buildInfo.version).toBe(FUTURE_FIXTURE_VERSION);
    expect(buildInfo.buildId).toContain("future-fixture");
    const inventory = JSON.parse(
      fs.readFileSync(path.join(root, "dist", "postinstall-inventory.json"), "utf8"),
    ) as string[];
    expect(inventory).toEqual(["dist/build-info.json", "dist/index.js"]);
    for (const name of LEGACY_UPDATE_COMPAT_CHUNKS) {
      expect(fs.existsSync(path.join(root, "dist", name))).toBe(false);
    }
  });

  it("packs distinct self-update targets without changing the candidate artifact", () => {
    const root = tempDirs.make("openclaw-same-schema-fixtures-");
    fs.cpSync(makePackageFixture(), path.join(root, "package"), { recursive: true });
    const candidate = path.join(root, "candidate.tgz");
    execFileSync("tar", ["-czf", candidate, "-C", root, "package"]);
    const original = fs.readFileSync(candidate);
    const receipts = [0, 1].map((sequence) => {
      const output = path.join(root, `future-${sequence}.tgz`);
      const receipt = packFutureUpdateFixture(candidate, output, sequence);
      const pkg = JSON.parse(
        execFileSync("tar", ["-xOf", output, "package/package.json"], { encoding: "utf8" }),
      );
      expect(pkg.version).toBe(receipt.targetVersion);
      expect(pkg.dependencies).toEqual({ "@openclaw/ai": "2026.8.1" });
      expect(
        execFileSync("tar", ["-xOf", output, "package/dist/index.js"], { encoding: "utf8" }),
      ).toBe("export {};\n");
      expect(receipt.sourceVersion).toBe("2026.8.1");
      return receipt;
    });
    expect(receipts.map((receipt) => receipt.targetVersion)).toEqual([
      "2026.9.99-first-hop.0",
      "2026.9.99-first-hop.1",
    ]);
    expect(new Set(receipts.map((receipt) => receipt.targetSha256)).size).toBe(2);
    expect(fs.readFileSync(candidate)).toEqual(original);
    expect(() => packFutureUpdateFixture(candidate, candidate)).toThrow("new tarball path");
    expect(fs.readFileSync(candidate)).toEqual(original);
  });

  it.each([0, 1])(
    "packs the runtime plugin in future cohort %s without changing its payload",
    (sequence) => {
      const root = tempDirs.make("openclaw-runtime-cohort-");
      const manifest = {
        name: "@openclaw/codex",
        version: "2026.9.3",
        dependencies: { "@openai/codex": "0.153.4" },
        openclaw: {
          extensions: ["./dist/index.js"],
          compat: { pluginApi: ">=2026.9.3" },
          build: { openclawVersion: "2026.9.3", bundledDist: true },
        },
      };
      writeJson(path.join(root, "package", "package.json"), manifest);
      writeJson(path.join(root, "package", "openclaw.plugin.json"), {
        id: "codex",
        configSchema: { type: "object" },
      });
      fs.mkdirSync(path.join(root, "package", "dist"));
      fs.writeFileSync(
        path.join(root, "package", "dist", "index.js"),
        "export const runtime = 'unchanged';\n",
      );
      const source = path.join(root, "source.tgz");
      const output = path.join(root, "future.tgz");
      execFileSync("tar", ["-czf", source, "-C", root, "package"]);
      const before = fs.readFileSync(source);
      const result = spawnSync(
        process.execPath,
        [
          "scripts/e2e/lib/update-first-hop-package-fixtures.mjs",
          "future-runtime-tarball",
          source,
          output,
          String(sequence),
        ],
        { encoding: "utf8" },
      );
      expect(result.status, result.stderr).toBe(0);
      const receipt = JSON.parse(result.stdout);
      const targetVersion = `2026.9.99-first-hop.${sequence}`;
      expect(receipt).toMatchObject({
        method: "candidate-same-schema-runtime-fixture",
        name: "@openclaw/codex",
        sourceVersion: "2026.9.3",
        targetVersion,
      });
      const readEntry = (archive: string, entry: string) =>
        execFileSync("tar", ["-xOf", archive, entry]);
      expect(JSON.parse(readEntry(output, "package/package.json").toString())).toEqual({
        ...manifest,
        version: targetVersion,
        openclaw: {
          ...manifest.openclaw,
          build: { ...manifest.openclaw.build, openclawVersion: targetVersion },
        },
      });
      for (const entry of ["package/dist/index.js", "package/openclaw.plugin.json"]) {
        expect(readEntry(output, entry)).toEqual(readEntry(source, entry));
      }
      expect(fs.readFileSync(source)).toEqual(before);
      expect(receipt.sourceSha256).toBe(createHash("sha256").update(before).digest("hex"));
      expect(receipt.targetSha256).toBe(
        createHash("sha256").update(fs.readFileSync(output)).digest("hex"),
      );
      expect(receipt.targetSha256).not.toBe(receipt.sourceSha256);
    },
  );

  it.each([
    {
      name: "other package",
      packageName: "@openclaw/other",
      version: "2026.9.3",
      buildVersion: "2026.9.3",
      sequence: "0",
    },
    {
      name: "mismatched build",
      packageName: "@openclaw/codex",
      version: "2026.9.3",
      buildVersion: "2026.9.2",
      sequence: "0",
    },
    {
      name: "missing build",
      packageName: "@openclaw/codex",
      version: "2026.9.3",
      buildVersion: undefined,
      sequence: "0",
    },
    {
      name: "invalid version",
      packageName: "@openclaw/codex",
      version: "latest",
      buildVersion: "latest",
      sequence: "0",
    },
    {
      name: "invalid sequence",
      packageName: "@openclaw/codex",
      version: "2026.9.3",
      buildVersion: "2026.9.3",
      sequence: "10",
    },
  ])(
    "rejects runtime fixture $name before creating an output",
    ({ packageName, version, buildVersion, sequence }) => {
      const root = tempDirs.make("openclaw-runtime-cohort-rejected-");
      writeJson(path.join(root, "package", "package.json"), {
        name: packageName,
        version,
        openclaw: { build: { openclawVersion: buildVersion } },
      });
      const source = path.join(root, "source.tgz");
      const output = path.join(root, "future.tgz");
      execFileSync("tar", ["-czf", source, "-C", root, "package"]);
      const before = fs.readFileSync(source);
      const result = spawnSync(
        process.execPath,
        [
          "scripts/e2e/lib/update-first-hop-package-fixtures.mjs",
          "future-runtime-tarball",
          source,
          output,
          sequence,
        ],
        { encoding: "utf8" },
      );
      expect(result.status).toBe(1);
      expect(fs.existsSync(output)).toBe(false);
      expect(fs.readFileSync(source)).toEqual(before);
    },
  );

  it.skipIf(process.platform === "win32")(
    "carries the candidate registry into the first-hop Docker lane",
    () => {
      const root = fs.realpathSync(tempDirs.make("openclaw-first-hop-docker-"));
      const bin = path.join(root, "bin");
      const registry = path.join(root, "registry");
      const dockerArgs = path.join(root, "docker-args.json");
      const tarball = path.join(root, "candidate.tgz");
      fs.mkdirSync(bin);
      fs.cpSync(makePackageFixture(), path.join(root, "package"), { recursive: true });
      execFileSync("tar", ["-czf", tarball, "-C", root, "package"]);
      writeJson(path.join(registry, "prepublish-plugin-registry.json"), {
        candidateVersion: "2026.8.1",
        sourceSha: "a".repeat(40),
        packages: [],
      });
      fs.writeFileSync(
        path.join(bin, "docker"),
        `#!${process.execPath}
import fs from "node:fs";
if (process.argv[2] === "run") fs.writeFileSync(process.env.DOCKER_ARGS_FILE, JSON.stringify(process.argv.slice(3)));
`,
        { mode: 0o755 },
      );
      const result = spawnSync("bash", ["scripts/e2e/update-first-hop-compat-docker.sh"], {
        encoding: "utf8",
        timeout: 30_000,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          DOCKER_ARGS_FILE: dockerArgs,
          OPENCLAW_QA_ALLOW_UPDATE_FIRST_HOP: "1",
          OPENCLAW_UPDATE_FIRST_HOP_E2E_SKIP_BUILD: "1",
          OPENCLAW_UPDATE_FIRST_HOP_SOURCE_PACKAGE_TGZ: tarball,
          OPENCLAW_UPDATE_FIRST_HOP_CANDIDATE_PACKAGE_TGZ: tarball,
          OPENCLAW_UPDATE_FIRST_HOP_ARTIFACT_DIR: path.join(root, "artifacts"),
          OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR: registry,
          OPENCLAW_DOCKER_E2E_SELECTED_SHA: "a".repeat(40),
          OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_CANDIDATE_VERSION: "2026.8.1",
          OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_MANIFEST_SHA256: "",
        },
      });
      expect(result.status, result.stdout + result.stderr).toBe(0);
      const args: string[] = JSON.parse(fs.readFileSync(dockerArgs, "utf8"));
      expect(args[args.indexOf("--entrypoint") + 1]).toBe(
        "/opt/openclaw-e2e/scripts/e2e/lib/prepublish-plugin-registry.sh",
      );
      expect(args).toContain(`${registry}:/tmp/openclaw-prepublish-plugin-registry:ro`);
      expect(args).toContain(`${tarball}:/tmp/openclaw-update-first-hop-candidate.tgz:ro`);
      expect(args).toContain("OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_CANDIDATE_VERSION=2026.8.1");
      expect(args).toContain("bash");
      expect(args).toContain("scripts/e2e/lib/upgrade-survivor/update-first-hop-compat.sh");
    },
  );
});

const transitionHelper = path.resolve("scripts/e2e/lib/external-package-transition.mjs");
const refusal =
  "Updater-owned Doctor cannot migrate shared state from schema 15 to 16 while the older updater owns completion.";

function makeTransitionEvidenceFixture() {
  const root = tempDirs.make("openclaw-external-transition-");
  const file = (name: string, value: unknown) => {
    const target = path.join(root, name);
    fs.writeFileSync(target, JSON.stringify(value));
    return target;
  };
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [transitionHelper, ...args], {
      encoding: "utf8",
      env: { ...process.env, OPENCLAW_STATE_DIR: root },
    });
  return { root, file, run };
}

describe("external package transition evidence", () => {
  it("refuses a changed shared schema before accepting the negative control", () => {
    const { root, run } = makeTransitionEvidenceFixture();
    fs.mkdirSync(path.join(root, "state"));
    const database = new DatabaseSync(path.join(root, "state", "openclaw.sqlite"));
    database.exec("PRAGMA user_version = 15");
    expect(run("schema", "15").status).toBe(0);
    database.exec("PRAGMA user_version = 16");
    database.close();
    const changed = run("schema", "15");
    expect(changed.status).toBe(1);
    expect(changed.stderr).toContain("shared schema changed");
  });

  it.each([
    { exit: "0", reason: "openclaw doctor", detail: refusal },
    { exit: "1", reason: "network-failed", detail: refusal },
    { exit: "1", reason: "openclaw doctor", detail: "download timed out" },
  ])(
    "rejects unrelated or successful updates as refusal proof: $reason/$exit/$detail",
    ({ exit, reason, detail }) => {
      const { run, file } = makeTransitionEvidenceFixture();
      const result = run(
        "refusal",
        exit,
        file("stdout.json", { status: "error", reason, steps: [{ stderrTail: detail }] }),
        file("stderr.txt", ""),
      );
      expect(result.status).toBe(1);
    },
  );

  it("records the exact old-parent failure as negative self-update evidence", () => {
    const { run, file } = makeTransitionEvidenceFixture();
    const result = run(
      "refusal",
      "1",
      file("stdout.json", {
        status: "error",
        reason: "openclaw doctor",
        steps: [{ stderrTail: refusal }],
      }),
      file("stderr.txt", ""),
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      status: "safely-refused",
      method: "in-process-self-update",
      exitCode: 1,
    });
  });

  it("requires both persisted user and assistant messages", () => {
    const { run, file } = makeTransitionEvidenceFixture();
    const user = { role: "user", content: "Return marker RETAINED" };
    const missing = run("history", file("missing.json", { messages: [user] }), "RETAINED");
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("durable assistant message");
    const retained = run(
      "history",
      file("retained.json", {
        messages: [user, { role: "assistant", content: [{ type: "text", text: "RETAINED" }] }],
      }),
      "RETAINED",
    );
    expect(retained.status).toBe(0);
  });

  it("refuses an ambiguous retained session identity", () => {
    const { run, file } = makeTransitionEvidenceFixture();
    const result = run(
      "session-key",
      file("sessions.json", {
        sessions: [
          { key: "first", sessionId: "retained" },
          { key: "second", sessionId: "retained" },
        ],
      }),
      "retained",
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("expected one retained session identity");
  });
});
