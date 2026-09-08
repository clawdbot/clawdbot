import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();
const guard = fileURLToPath(
  new URL("../../scripts/check-install-dependency-ownership.mjs", import.meta.url),
);

function fixture() {
  const root = fs.realpathSync(createTempDir("openclaw-install-ownership-"));
  const checkout = path.join(root, "checkout");
  const donor = path.join(root, "donor");
  fs.mkdirSync(checkout);
  fs.mkdirSync(donor);
  fs.writeFileSync(path.join(donor, "sentinel"), "another task owns these bytes");
  return { checkout, donor };
}

function link(target: string, destination: string) {
  fs.symlinkSync(target, destination, process.platform === "win32" ? "junction" : "dir");
}

function run(checkout: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [guard], { cwd: checkout, env, encoding: "utf8" });
}

it.each(["absent", "physical"])(
  "admits %s owned dependencies without changing the checkout",
  (kind) => {
    const { checkout } = fixture();
    const modules = path.join(checkout, "node_modules");
    if (kind === "physical") {
      fs.mkdirSync(modules);
    }
    const before = fs.readdirSync(checkout);
    expect(run(checkout).status).toBe(0);
    expect(fs.readdirSync(checkout)).toEqual(before);
  },
);

it.each(["modules", "virtual-store", "unrelated-config", "empty-uppercase"])(
  "refuses a borrowed %s before touching the donor",
  (kind) => {
    const { checkout, donor } = fixture();
    const modules = path.join(checkout, "node_modules");
    const env: NodeJS.ProcessEnv = {};
    if (kind === "virtual-store") {
      fs.mkdirSync(modules);
      link(donor, path.join(modules, ".pnpm"));
    } else {
      link(donor, modules);
    }
    if (kind === "unrelated-config") {
      env.PNPM_CONFIG_MODULES_DIR = path.join(checkout, "explicit-modules");
      fs.mkdirSync(env.PNPM_CONFIG_MODULES_DIR);
    } else if (kind === "empty-uppercase") {
      env.PNPM_CONFIG_MODULES_DIR = "";
      env.pnpm_config_modules_dir = donor;
    }
    const before = fs.statSync(donor);
    const result = run(checkout, env);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Refusing to reconcile dependencies");
    expect(fs.statSync(donor).ino).toBe(before.ino);
    expect(fs.statSync(donor).mtimeMs).toBe(before.mtimeMs);
    expect(fs.readFileSync(path.join(donor, "sentinel"), "utf8")).toBe(
      "another task owns these bytes",
    );
  },
);

it.each(["PNPM_CONFIG_MODULES_DIR", "pnpm_config_modules_dir"])(
  "admits an explicitly provisioned hydrated alias through %s without replacing it",
  (key) => {
    const { checkout, donor } = fixture();
    const modules = path.join(checkout, "node_modules");
    link(donor, modules);
    const before = fs.lstatSync(modules);
    expect(run(checkout, { [key]: donor }).status).toBe(0);
    expect(fs.lstatSync(modules).ino).toBe(before.ino);
    expect(fs.realpathSync(modules)).toBe(donor);
  },
);

it("preserves whitespace in an explicit pnpm module-directory path", () => {
  const { checkout } = fixture();
  const directory = path.join(checkout, "modules ");
  fs.mkdirSync(directory);
  link(directory, path.join(checkout, "node_modules"));
  expect(run(checkout, { PNPM_CONFIG_MODULES_DIR: directory }).status).toBe(0);
});
