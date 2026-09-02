import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

export async function runUpdateSnapshotIsolationProof(
  fixtureRoot: string,
  selection: "home" | "state" | "explicit" | "profile",
): Promise<void> {
  const root = fs.realpathSync(fixtureRoot);
  const repo = fileURLToPath(new URL("../../../", import.meta.url));
  const homeA = path.join(root, "A");
  const homeB = path.join(root, "B");
  const configA = path.join(homeA, ".openclaw", "openclaw.json");
  const defaultB = path.join(homeB, ".openclaw", "openclaw.json");
  const configB =
    selection === "explicit"
      ? path.join(homeB, "custom.json")
      : selection === "state"
        ? path.join(homeB, "selected-state", "openclaw.json")
        : selection === "profile"
          ? path.join(homeB, ".openclaw-snapshot-proof", "openclaw.json")
          : defaultB;
  const sourceA = '{ "canary": "synthetic-A" }\n';
  const sourceB = '{ "canary": "synthetic-B" }\n';
  const oldBackupA = "synthetic-old-backup-A\n";
  const sources = new Map([
    [configA, sourceA],
    [defaultB, "synthetic-unselected-default-B\n"],
    [configB, sourceB],
    [`${configA}.pre-update`, oldBackupA],
  ]);
  for (const [file, content] of sources) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, { mode: 0o600 });
  }
  const before = fs.readdirSync(root, { recursive: true, encoding: "utf8" });
  const selectHome = (home: string) => {
    Object.assign(process.env, {
      HOME: home,
      USERPROFILE: home,
      OPENCLAW_HOME: home,
      OPENCLAW_STATE_DIR: path.join(home, ".openclaw"),
      OPENCLAW_CONFIG_PATH: path.join(home, ".openclaw", "openclaw.json"),
    });
  };
  selectHome(homeA);

  // Guard before importing production: even the broken owner may only write synthetic fixtures.
  // Deny other mutation APIs, and check real parents so a symlink cannot escape the fixture.
  const writes: string[] = [];
  const blocked: string[] = [];
  function checkTarget(value: unknown): asserts value is string {
    assert.equal(typeof value, "string");
    assert.ok(typeof value === "string" && path.resolve(value).startsWith(root + path.sep));
    assert.ok(fs.realpathSync(path.dirname(value)).startsWith(root + path.sep));
    if (fs.existsSync(value)) {
      assert.equal(fs.lstatSync(value).isSymbolicLink(), false);
    }
  }
  const writeFile = fsp.writeFile.bind(fsp);
  const copyFile = fsp.copyFile.bind(fsp);
  const openSync = fs.openSync.bind(fs);
  for (const name of [
    "appendFile",
    "chmod",
    "chown",
    "lchmod",
    "lchown",
    "lutimes",
    "mkdir",
    "mkdtemp",
    "open",
    "rename",
    "rm",
    "rmdir",
    "symlink",
    "link",
    "truncate",
    "unlink",
    "utimes",
    "write",
    "writev",
    "writeFile",
    "copyFile",
    "cp",
    "createWriteStream",
  ]) {
    for (const owner of [fs, fsp]) {
      for (const key of [name, `${name}Sync`]) {
        if (typeof Object.getOwnPropertyDescriptor(owner, key)?.value !== "function") {
          continue;
        }
        Object.defineProperty(owner, key, {
          configurable: true,
          writable: true,
          value: () => {
            blocked.push(key);
            throw new Error(`Snapshot proof blocked mutation: ${key}`);
          },
        });
      }
    }
  }
  fsp.writeFile = async (file, ...args) => {
    checkTarget(file);
    writes.push(file);
    return writeFile(file, ...args);
  };
  fsp.copyFile = async (source, destination, ...args) => {
    checkTarget(source);
    checkTarget(destination);
    writes.push(destination);
    return copyFile(source, destination, ...args);
  };
  fs.openSync = (file, flags, ...args) => {
    assert.ok(flags === "r" || flags === 0, "Only read-only opens are allowed");
    const filename = file instanceof URL ? fileURLToPath(file) : file.toString();
    assert.ok(filename.startsWith(repo) || filename.startsWith(root + path.sep));
    return openSync(file, flags, ...args);
  };
  syncBuiltinESMExports();
  const outside = path.join(root, "..", "synthetic-outside-snapshot-fixture");
  await assert.rejects(() => fsp.writeFile(outside, "must never be written"));
  await assert.rejects(() => fsp.copyFile(configA, outside));
  assert.deepEqual(writes, []);

  const { CONFIG_PATH } = await import("../../config/paths.js");
  assert.equal(CONFIG_PATH, configA);
  checkTarget(CONFIG_PATH);
  const { createUpdateConfigSnapshot } = await import("./update-command-config-snapshot.js");
  selectHome(homeB);
  if (selection === "home") {
    delete process.env.OPENCLAW_STATE_DIR;
    delete process.env.OPENCLAW_CONFIG_PATH;
  } else if (selection === "state") {
    process.env.OPENCLAW_STATE_DIR = path.dirname(configB);
    delete process.env.OPENCLAW_CONFIG_PATH;
  } else if (selection === "explicit") {
    process.env.OPENCLAW_CONFIG_PATH = configB;
  } else {
    const { applyCliProfileEnv } = await import("../profile.js");
    applyCliProfileEnv({ profile: "snapshot-proof" });
    assert.equal(process.env.OPENCLAW_CONFIG_PATH, configB);
  }
  await createUpdateConfigSnapshot();
  console.log(JSON.stringify({ selection, importedConfig: CONFIG_PATH, configB, writes, blocked }));
  for (const [file, content] of sources) {
    assert.equal(await fsp.readFile(file, "utf8"), content, `Unselected file changed: ${file}`);
  }
  assert.equal(await fsp.readFile(`${configB}.pre-update`, "utf8"), sourceB);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(`${configB}.pre-update`).mode & 0o777, 0o600);
  }
  assert.deepEqual(writes, [`${configB}.pre-update`]);
  assert.deepEqual(blocked, []);
  assert.deepEqual(
    new Set(fs.readdirSync(root, { recursive: true, encoding: "utf8" })),
    new Set([...before, path.relative(root, `${configB}.pre-update`)]),
  );
}
