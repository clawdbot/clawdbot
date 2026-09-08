import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

const repoRoot = process.cwd();
const tsxImport = new URL("../../scripts/tsx.mjs", import.meta.url).href;

it("compares real UI builds with canonical compression and keeps artifacts after a growth failure", () => {
  const temporaryRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ui-budget-proof-")));
  const root = path.join(temporaryRoot, "repo");
  const scratch = path.join(temporaryRoot, "scratch");
  const identityCapture = path.join(temporaryRoot, "build-identities.jsonl");
  const write = (file: string, text: string) => {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  };
  const git = (...args: string[]) => {
    const result = spawnSync(
      "git",
      ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args],
      {
        cwd: root,
        encoding: "utf8",
      },
    );
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  const css = (count: number) =>
    Array.from({ length: count }, (_, index) => {
      const hash = createHash("sha256").update(String(index)).digest("hex");
      return `.rule-${hash.slice(0, 12)}{color:#${hash.slice(12, 18)};padding:${index % 97}px}`;
    }).join("\n");
  try {
    fs.mkdirSync(scratch, { recursive: true });
    for (const directory of [
      "scripts/lib",
      "ui",
      "packages/styles/node_modules/sizing-library",
      "extensions",
    ]) {
      fs.mkdirSync(path.join(root, directory), { recursive: true });
    }
    for (const directory of ["node_modules", "ui/node_modules"]) {
      fs.symlinkSync(path.join(repoRoot, directory), path.join(root, directory), "junction");
    }
    for (const script of [
      "check-control-ui-performance-base.mts",
      "check-control-ui-performance.mts",
      "check-control-ui-precompressed-assets.mts",
      "lib/repo-root.mjs",
      "lib/output-root-guard.mjs",
    ]) {
      fs.copyFileSync(path.join(repoRoot, "scripts", script), path.join(root, "scripts", script));
    }
    write("scripts/tsx.mjs", `await import(${JSON.stringify(tsxImport)});\n`);
    write(".gitignore", "node_modules\ndist/\n");
    write("package.json", '{"name":"ui-budget-proof","version":"1.0.0","type":"module"}');
    write("pnpm-workspace.yaml", 'packages: ["ui", "packages/*"]\n');
    write("ui/package.json", '{"name":"ui-budget-proof-ui","type":"module"}');
    write("ui/index.html", '<script type="module" src="/main.js"></script>');
    write(
      "ui/main.js",
      'import "./style.css"; import "../packages/styles/main.js"; document.body.textContent = "ready";',
    );
    write("packages/styles/main.js", 'import "sizing-library/style.css";');
    write(
      "packages/styles/node_modules/sizing-library/package.json",
      '{"name":"sizing-library","exports":{"./style.css":"./style.css"}}',
    );
    write("packages/styles/node_modules/sizing-library/style.css", ".package-style{display:flex}");
    write(
      "config/control-ui-startup-budget-baseline.json",
      JSON.stringify({
        startupJsGzipBytes: 10_000,
        reason: "synthetic fixture",
        updatedAt: "2026-09-02",
      }),
    );
    const config = `
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { brotliCompressSync } from "node:zlib";
import { gzip } from "pako";
const outDir = path.resolve(import.meta.dirname, "../dist/control-ui");
function recordBuildIdentity() {
  const identityCapture = process.env.OPENCLAW_TEST_BUILD_IDENTITY_CAPTURE;
  if (!identityCapture) return;
  fs.appendFileSync(identityCapture, JSON.stringify({
    identity: ["GIT_COMMIT", "OPENCLAW_BUILD_TIMESTAMP", "GIT_BRANCH", "OPENCLAW_CONTROL_UI_BUILD_ID", "OPENCLAW_CONTROL_UI_RELEASE_BUILD"].map((key) => process.env[key]),
    gitDisabled: !fs.existsSync(process.env.GIT_DIR ?? "") && spawnSync("git", ["rev-parse", "HEAD"]).status !== 0,
    packageVersion: JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../package.json"), "utf8")).version,
  }) + "\\n");
}
export function createControlUiPrecompressedAssetVariants(fileName, source) {
  return [
    { fileName: fileName + ".gz", source: gzip(source, { level: 0, legacyHash: true }) },
    { fileName: fileName + ".br", source: brotliCompressSync(source) },
  ];
}
export default {
  build: { outDir, emptyOutDir: true },
  plugins: [{ name: "fixture-precompression", buildStart: recordBuildIdentity, writeBundle(_options, bundle) {
    for (const output of Object.values(bundle)) {
      if (!/\\.(css|js)$/.test(output.fileName)) continue;
      for (const variant of createControlUiPrecompressedAssetVariants(output.fileName, fs.readFileSync(path.join(outDir, output.fileName)))) {
        fs.writeFileSync(path.join(outDir, variant.fileName), variant.source);
      }
    }
  } }],
};
`;
    write("ui/vite.config.ts", config);
    write("ui/style.css", css(1_000));
    git("init", "--quiet");
    git("add", ".");
    git("commit", "--quiet", "-m", "base");
    const base = git("rev-parse", "HEAD");
    write("package.json", '{"name":"ui-budget-proof","version":"1.0.1","type":"module"}');
    write("ui/vite.config.ts", config.replace("level: 0", "level: 9"));

    const runComparison = () => {
      fs.rmSync(identityCapture, { force: true });
      return spawnSync(
        process.execPath,
        [
          "--import",
          tsxImport,
          path.join(root, "scripts/check-control-ui-performance-base.mts"),
          base,
        ],
        {
          cwd: root,
          env: {
            ...process.env,
            OPENCLAW_TEST_BUILD_IDENTITY_CAPTURE: identityCapture,
            TMPDIR: scratch,
            TMP: scratch,
            TEMP: scratch,
          },
          encoding: "utf8",
          timeout: 30_000,
        },
      );
    };
    for (const [count, expectedExit] of [
      [1_001, 0],
      [1_400, 1],
    ] as const) {
      write("ui/style.css", css(count));
      git("add", ".");
      git("commit", "--quiet", "-m", `candidate ${count}`);
      const head = git("rev-parse", "HEAD");
      expect(head).not.toBe(base);
      const result = runComparison();
      const output = `${result.stdout}${result.stderr}`;
      expect(result.status, output).toBe(expectedExit);
      expect(output).toContain(`head ${head}; base ${base}; Node ${process.version}; Vite `);
      expect(output).toContain("Pako ");
      expect(output).toMatch(/startup CSS gzip vs base: \d+ B -> \d+ B \(\+\d+ B/u);
      expect(output.includes("startup CSS gzip growth:")).toBe(expectedExit !== 0);
      const identities = fs
        .readFileSync(identityCapture, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)) as Array<{
        gitDisabled: boolean;
        identity: unknown;
        packageVersion: string;
      }>;
      expect(identities).toHaveLength(2);
      expect(identities.map(({ packageVersion }) => packageVersion)).toEqual(["1.0.1", "1.0.0"]);
      expect(identities[0]?.identity).toEqual(identities[1]?.identity);
      expect(identities.every(({ gitDisabled }) => gitDisabled)).toBe(true);
      expect(fs.existsSync(path.join(root, "dist/control-ui/index.html"))).toBe(true);
      expect(
        fs.readdirSync(scratch).filter((name) => name.startsWith("openclaw-ui-performance-base-")),
      ).toEqual([]);
    }
    const protectedRoot = path.join(temporaryRoot, "protected");
    fs.mkdirSync(protectedRoot);
    fs.writeFileSync(path.join(protectedRoot, "sentinel"), "keep");
    for (const outputRoot of ["dist", "dist/control-ui"]) {
      const target = path.join(root, outputRoot);
      fs.rmSync(target, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.symlinkSync(protectedRoot, target, "junction");
      const result = runComparison();
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(1);
      expect(result.stderr).toContain("is a symbolic link; refusing to mutate it");
      expect(fs.readFileSync(path.join(protectedRoot, "sentinel"), "utf8")).toBe("keep");
      fs.unlinkSync(target);
    }
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}, 60_000);
