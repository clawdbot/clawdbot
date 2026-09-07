import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [uid, gid] = process.argv.slice(2).map(Number);
assert.equal(process.getuid(), uid);
assert.equal(process.getgid(), gid);
const cache = process.env.XDG_CACHE_HOME;
assert.equal(fs.statSync(cache).uid, uid);
assert.equal(os.tmpdir(), "/tmp");
for (const directory of [cache, os.tmpdir()]) {
  const probe = fs.mkdtempSync(path.join(directory, "fleet-write-probe-"));
  try {
    fs.writeFileSync(path.join(probe, "data"), "writable");
    assert.equal(fs.readFileSync(path.join(probe, "data"), "utf8"), "writable");
  } finally {
    fs.rmSync(probe, { recursive: true });
  }
}
const status = Object.fromEntries(
  fs
    .readFileSync("/proc/1/status", "utf8")
    .trim()
    .split("\n")
    .map((line) => {
      const separator = line.indexOf(":");
      return [line.slice(0, separator), line.slice(separator + 1).trim()];
    }),
);
assert.equal(BigInt(`0x${status.CapEff}`), 0n);
assert.equal(BigInt(`0x${status.CapBnd}`), 0n);
assert.equal(status.NoNewPrivs, "1");
assert.equal(status.Seccomp, "2");
const memoryMax = fs.readFileSync("/sys/fs/cgroup/memory.max", "utf8").trim();
const pidsMax = fs.readFileSync("/sys/fs/cgroup/pids.max", "utf8").trim();
const cpuMax = fs.readFileSync("/sys/fs/cgroup/cpu.max", "utf8").trim();
assert.equal(memoryMax, String(2 * 1024 ** 3));
assert.equal(pidsMax, "512");
const [quota, period] = cpuMax.split(" ").map(Number);
assert.equal(quota / period, 2);
console.log(
  JSON.stringify({
    control: "podman",
    uid,
    gid,
    cache,
    tmpdir: os.tmpdir(),
    cacheWrite: true,
    temporaryWrite: true,
    capEff: status.CapEff,
    capBnd: status.CapBnd,
    noNewPrivs: status.NoNewPrivs,
    seccomp: status.Seccomp,
    memoryMax,
    pidsMax,
    cpuMax,
  }),
);
