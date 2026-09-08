import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const [stateDir, tenant, image, uidText, gidText, imageFile] = process.argv.slice(2);
const uid = Number(uidText);
const gid = Number(gidText);
const [cell] = JSON.parse(fs.readFileSync(0, "utf8"));
const [selectedImage] = JSON.parse(fs.readFileSync(imageFile, "utf8"));
const environment = Object.fromEntries(
  cell.Config.Env.map((entry) => {
    const separator = entry.indexOf("=");
    return [entry.slice(0, separator), entry.slice(separator + 1)];
  }),
);
assert.equal(cell.State.Running, true);
assert.equal(cell.Config.User, `${uid}:${gid}`);
assert.match(image, /@sha256:[a-f0-9]{64}$/u);
assert.equal(cell.ImageName, image);
assert.equal(cell.Image, selectedImage.Id);
assert.equal(cell.ImageDigest, selectedImage.Digest);
assert.equal(environment.XDG_CACHE_HOME, "/home/node/.openclaw/cache");
assert.equal(Object.hasOwn(environment, "TMPDIR"), false);
assert.equal(environment.HOME, "/home/node");
assert.equal(environment.OPENCLAW_STATE_DIR, "/home/node/.openclaw");
assert.equal(cell.Config.Labels["openclaw.fleet.env-keys"], "");
assert.equal(cell.Config.Labels["openclaw.fleet.tenant"], tenant);
assert.equal(cell.Mounts.length, 2);
for (const [directory, destination] of [
  ["cells", "/home/node/.openclaw"],
  ["auth-profile-secrets", "/home/node/.config/openclaw"],
]) {
  const mount = cell.Mounts.find((entry) => entry.Destination === destination);
  assert.ok(mount);
  assert.equal(mount.Type, "bind");
  assert.equal(mount.Source, path.join(stateDir, "fleet", directory, tenant));
  assert.equal(mount.RW, true);
  const stat = fs.statSync(mount.Source);
  assert.equal(stat.mode & 0o777, 0o700);
  assert.equal(stat.uid, uid);
  assert.equal(stat.gid, gid);
}
// Podman's Go slice fields encode an empty capability set as [] or null.
assert.ok(
  cell.EffectiveCaps === null ||
    (Array.isArray(cell.EffectiveCaps) && cell.EffectiveCaps.length === 0),
);
assert.ok(
  cell.BoundingCaps === null ||
    (Array.isArray(cell.BoundingCaps) && cell.BoundingCaps.length === 0),
);
assert.deepEqual(cell.HostConfig.CapAdd, []);
assert.equal(cell.HostConfig.Privileged, false);
assert.ok(cell.HostConfig.SecurityOpt.includes("no-new-privileges"));
assert.ok(cell.HostConfig.SecurityOpt.every((option) => !option.includes("unconfined")));
assert.equal(cell.HostConfig.NetworkMode, "bridge");
assert.deepEqual(Object.keys(cell.NetworkSettings.Networks), [`openclaw-cell-${tenant}-net`]);
assert.deepEqual(Object.keys(cell.HostConfig.PortBindings), ["18789/tcp"]);
assert.ok(cell.HostConfig.PortBindings["18789/tcp"].length > 0);
assert.ok(
  cell.HostConfig.PortBindings["18789/tcp"].every((binding) => binding.HostIp === "127.0.0.1"),
);
assert.equal(cell.HostConfig.Init, true);
assert.equal(cell.HostConfig.CgroupManager, "systemd");
assert.equal(cell.HostConfig.Cgroups, "default");
assert.equal(cell.HostConfig.Memory, 2 * 1024 ** 3);
assert.equal(cell.HostConfig.PidsLimit, 512);

// Read mappings from the host namespace; nested keep-id inspect mappings are relative to their parent.
const mappings = {};
for (const [kind, id] of [
  ["uid", uid],
  ["gid", gid],
]) {
  const rows = fs
    .readFileSync(`/proc/${cell.State.Pid}/${kind}_map`, "utf8")
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/u).map(Number));
  const row = rows.find(([inside, , length]) => id >= inside && id < inside + length);
  assert.ok(row);
  assert.equal(row[1] + id - row[0], id);
  mappings[kind] = row;
}
const cache = fs.statSync(path.join(stateDir, "fleet", "cells", tenant, "cache"));
assert.equal(cache.uid, uid);
assert.equal(cache.gid, gid);
console.log(
  JSON.stringify({
    control: "podman",
    containerId: cell.Id,
    startedAt: cell.State.StartedAt,
    environmentKeys: cell.Config.Labels["openclaw.fleet.env-keys"],
    environment: cell.Config.Env.filter((entry) => !entry.startsWith("OPENCLAW_GATEWAY_TOKEN=")),
    mounts: cell.Mounts,
    requestedImage: image,
    imageId: cell.Image,
    selectedManifestDigest: cell.ImageDigest,
    user: cell.Config.User,
    cache: environment.XDG_CACHE_HOME,
    cacheOwnerUid: cache.uid,
    mappings,
    effectiveCaps: cell.EffectiveCaps,
    boundingCaps: cell.BoundingCaps,
    securityOpt: cell.HostConfig.SecurityOpt,
    networkMode: cell.HostConfig.NetworkMode,
    ports: cell.HostConfig.PortBindings,
    memory: cell.HostConfig.Memory,
    pidsLimit: cell.HostConfig.PidsLimit,
  }),
);
