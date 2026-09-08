import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { resolveTsxImport } from "../../scripts/lib/tsx-cli-shim.mjs";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();
afterEach(() => vi.unstubAllEnvs());

function fixture() {
  vi.stubEnv("PNPM_CONFIG_MODULES_DIR", undefined);
  vi.stubEnv("pnpm_config_modules_dir", undefined);
  vi.stubEnv("npm_config_modules_dir", undefined);
  const root = fs.realpathSync(createTempDir("openclaw-toolchain-ownership-"));
  const primary = path.join(root, "primary");
  const checkout = path.join(root, "checkout");
  fs.mkdirSync(checkout);
  expect(spawnSync("git", ["init", "--quiet", primary]).status).toBe(0);
  const gitdir = path.join(primary, ".git", "worktrees", "task");
  fs.mkdirSync(gitdir, { recursive: true });
  fs.writeFileSync(path.join(gitdir, "commondir"), "../..\n");
  fs.writeFileSync(path.join(gitdir, "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(gitdir, "gitdir"), `${checkout}/.git\n`);
  fs.writeFileSync(path.join(checkout, ".git"), `gitdir: ${gitdir}\n`);
  const modules = path.join(primary, "node_modules");
  const tsx = path.join(modules, "tsx");
  fs.mkdirSync(tsx, { recursive: true });
  fs.writeFileSync(
    path.join(tsx, "package.json"),
    JSON.stringify({ name: "tsx", type: "module", exports: { "./esm": "./esm.mjs" } }),
  );
  fs.writeFileSync(path.join(tsx, "esm.mjs"), "export {};\n");
  return { checkout, modules, entry: pathToFileURL(path.join(tsx, "esm.mjs")).href };
}

it.each([false, true])(
  "refuses a missing worktree install with an empty override=%s",
  (emptyOverride) => {
    const { checkout, modules } = fixture();
    if (emptyOverride) {
      vi.stubEnv("PNPM_CONFIG_MODULES_DIR", "");
      vi.stubEnv("pnpm_config_modules_dir", modules);
    }
    const before = fs.statSync(modules);
    expect(() => resolveTsxImport(checkout)).toThrow("pnpm install --frozen-lockfile");
    expect(fs.existsSync(path.join(checkout, "node_modules"))).toBe(false);
    expect(fs.statSync(modules).ino).toBe(before.ino);
    expect(fs.statSync(modules).mtimeMs).toBe(before.mtimeMs);
  },
);

it("keeps an existing explicit borrow readable without replacing its link", () => {
  const { checkout, modules, entry } = fixture();
  const link = path.join(checkout, "node_modules");
  fs.symlinkSync(modules, link, process.platform === "win32" ? "junction" : "dir");
  const before = fs.lstatSync(link);
  const target = fs.readlinkSync(link);
  expect(resolveTsxImport(checkout)).toBe(entry);
  expect(fs.lstatSync(link).ino).toBe(before.ino);
  expect(fs.readlinkSync(link)).toBe(target);
});

it("uses owned checkout dependencies when the configured directory contains only metadata", () => {
  const { checkout, modules } = fixture();
  const localModules = path.join(checkout, "node_modules");
  fs.cpSync(modules, localModules, { recursive: true });
  const metadata = path.join(path.dirname(checkout), "metadata");
  fs.mkdirSync(metadata);
  fs.writeFileSync(path.join(metadata, ".modules.yaml"), "virtualStoreDir: .pnpm\n");
  vi.stubEnv("PNPM_CONFIG_MODULES_DIR", metadata);
  const before = fs.lstatSync(localModules);
  expect(resolveTsxImport(checkout)).toBe(
    pathToFileURL(path.join(localModules, "tsx", "esm.mjs")).href,
  );
  expect(fs.lstatSync(localModules).ino).toBe(before.ino);
  expect(fs.lstatSync(localModules).isSymbolicLink()).toBe(false);
});

it.each(["PNPM_CONFIG_MODULES_DIR", "pnpm_config_modules_dir", "npm_config_modules_dir"])(
  "preserves the explicitly configured hydrated toolchain through %s",
  (key) => {
    const { checkout, modules, entry } = fixture();
    vi.stubEnv(key, modules);
    expect(resolveTsxImport(checkout)).toBe(entry);
    expect(fs.realpathSync(path.join(checkout, "node_modules"))).toBe(modules);
  },
);

it("preserves leading whitespace in an explicitly configured module directory", () => {
  const { checkout, modules } = fixture();
  const configured = " modules";
  const target = path.join(checkout, configured);
  fs.renameSync(modules, target);
  vi.stubEnv("PNPM_CONFIG_MODULES_DIR", configured);
  expect(resolveTsxImport(checkout)).toBe(pathToFileURL(path.join(target, "tsx", "esm.mjs")).href);
  expect(fs.realpathSync(path.join(checkout, "node_modules"))).toBe(target);
});
