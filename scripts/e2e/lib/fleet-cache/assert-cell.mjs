import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const [cache, keys, tmpdir, stateDir, tenant] = process.argv.slice(2);
const [cell] = JSON.parse(readFileSync(0, "utf8"));
const environment = Object.fromEntries(
  cell.Config.Env.map((entry) => {
    const separator = entry.indexOf("=");
    return [entry.slice(0, separator), entry.slice(separator + 1)];
  }),
);

assert.equal(cell.State.Running, true);
if (cache === "") {
  assert.equal(Object.hasOwn(environment, "XDG_CACHE_HOME"), false);
} else {
  assert.equal(environment.XDG_CACHE_HOME, cache);
}
if (tmpdir === "") {
  assert.equal(Object.hasOwn(environment, "TMPDIR"), false);
} else {
  assert.equal(environment.TMPDIR, tmpdir);
}
assert.equal(cell.Config.Labels["openclaw.fleet.env-keys"], keys);
assert.equal(environment.HOME, "/home/node");
assert.equal(environment.OPENCLAW_STATE_DIR, "/home/node/.openclaw");
for (const [directory, destination] of [
  ["cells", "/home/node/.openclaw"],
  ["auth-profile-secrets", "/home/node/.config/openclaw"],
]) {
  const mount = cell.Mounts.find((entry) => entry.Destination === destination);
  assert.ok(mount);
  assert.equal(mount.Type, "bind");
  assert.equal(mount.Source, path.join(stateDir, "fleet", directory, tenant));
  assert.equal(mount.RW, true);
}
assert.ok(cell.HostConfig.CapDrop.includes("ALL"));
assert.ok(cell.HostConfig.SecurityOpt.includes("no-new-privileges"));
assert.ok(cell.HostConfig.SecurityOpt.every((option) => !option.includes("unconfined")));
assert.equal(cell.HostConfig.Privileged, false);
const network = `openclaw-cell-${tenant}-net`;
assert.equal(cell.HostConfig.NetworkMode, network);
assert.deepEqual(Object.keys(cell.NetworkSettings.Networks), [network]);
for (const bindings of Object.values(cell.HostConfig.PortBindings)) {
  assert.ok(bindings.every((binding) => binding.HostIp === "127.0.0.1"));
}
