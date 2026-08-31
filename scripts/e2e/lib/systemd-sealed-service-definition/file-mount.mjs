import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";

// The privileged setup runs only in a disposable container, without host mounts.
// Both the kernel probe and packaged CLI run as the ordinary appuser account.
const uid = Number(execFileSync("id", ["-u", "appuser"], { encoding: "utf8" }).trim());
const gid = Number(execFileSync("id", ["-g", "appuser"], { encoding: "utf8" }).trim());
const home = "/home/appuser";
const state = `${home}/.openclaw`;
const unitDir = `${home}/.config/systemd/user`;
const unit = `${unitDir}/openclaw-gateway.service`;
const fixture = "/tmp/openclaw-file-mount";
const shims = `${fixture}/bin`;
const kernelOnly = process.argv.includes("--kernel-only");

async function kernelProbe() {
  const { default: check } = await import("node:assert/strict");
  const { promises: mountedFs, constants } = await import("node:fs");
  const { default: path } = await import("node:path");
  const file = process.argv[1];
  check.notEqual(process.geteuid(), 0);
  check.equal((await mountedFs.stat(file)).uid, process.geteuid());
  await mountedFs.access(path.dirname(file), constants.W_OK | constants.X_OK);
  const handle = await mountedFs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await mountedFs.readFile(`/proc/self/fdinfo/${handle.fd}`, "utf8");
    const mountId = /^mnt_id:\s+(\d+)$/m.exec(info)?.[1];
    const mount = (await mountedFs.readFile("/proc/self/mountinfo", "utf8"))
      .split("\n")
      .find((line) => line.startsWith(`${mountId} `))
      ?.split(" ");
    check.equal(mount?.[4], file);
    check(mount[5].split(",").includes("ro"));
  } finally {
    await handle.close();
  }
  const temporary = `${file}.kernel-probe`;
  await mountedFs.writeFile(temporary, "replacement");
  try {
    await check.rejects(mountedFs.rename(temporary, file), { code: "EBUSY" });
  } finally {
    await mountedFs.unlink(temporary);
  }
}

async function snapshot() {
  const files = [
    unit,
    `${unit}.bak`,
    `${state}/openclaw.json`,
    `${state}/gateway.systemd.env`,
    `${state}/.env`,
  ];
  return {
    artifacts: await Promise.all(
      files.map(async (file) => {
        try {
          const stat = await fs.stat(file);
          return [
            file,
            stat.uid,
            stat.gid,
            stat.mode,
            stat.ino,
            createHash("sha256")
              .update(await fs.readFile(file))
              .digest("hex"),
          ];
        } catch (error) {
          if (error.code !== "ENOENT") {
            throw error;
          }
          return [file, "missing"];
        }
      }),
    ),
    unitEntries: (await fs.readdir(unitDir)).toSorted(),
    stateEntries: (await fs.readdir(state)).filter((entry) => entry !== "state").toSorted(),
  };
}

try {
  assert.equal(process.geteuid(), 0);
  for (const directory of [
    home,
    `${home}/.config`,
    `${home}/.config/systemd`,
    unitDir,
    state,
    fixture,
    shims,
  ]) {
    await fs.mkdir(directory, { recursive: true });
    await fs.chown(directory, uid, gid);
  }
  await fs.writeFile(
    `${shims}/systemctl`,
    `#!/bin/sh
case "$*" in
  "--user is-enabled "*) echo enabled ;;
  *--property=LoadState*) echo not-found ;;
  *--property=UnitPath*) echo '/etc/systemd/system /usr/lib/systemd/system' ;;
  "--user status") exit 0 ;;
  *) exit 1 ;;
esac
`,
    { mode: 0o755 },
  );
  await fs.writeFile(
    `${shims}/busctl`,
    `#!/bin/sh
printf '%s\n' 'Call failed: Unit openclaw-gateway.service not found.' >&2
exit 1
`,
    { mode: 0o755 },
  );
  const childOptions = {
    uid,
    gid,
    encoding: "utf8",
    timeout: 60_000,
    env: {
      HOME: home,
      USER: "appuser",
      LOGNAME: "appuser",
      PATH: `${shims}:/usr/local/bin:/usr/bin:/bin`,
    },
  };
  for (const mode of [0o400, 0o644]) {
    const source = `${fixture}/source-${mode}`;
    await fs.writeFile(
      source,
      "[Service]\nExecStart=/usr/local/bin/node /app/openclaw.mjs gateway\n",
      { mode },
    );
    await fs.chown(source, uid, gid);
    await fs.writeFile(unit, "");
    for (const [file, contents] of [
      [`${state}/openclaw.json`, '{"gateway":{"mode":"local","auth":{"mode":"token"}}}'],
      [`${state}/gateway.systemd.env`, "OPERATOR_VALUE=unchanged\n"],
      [`${state}/.env`, "OPERATOR_VALUE=unchanged\n"],
    ]) {
      await fs.writeFile(file, contents, { mode: 0o600 });
      await fs.chown(file, uid, gid);
    }
    // Kernel setup must use Debian-owned tools, not PATH/npm fixture replacements.
    execFileSync("/bin/mount", ["--bind", source, unit]);
    try {
      execFileSync("/bin/mount", ["-o", "remount,bind,ro", unit]);
      const probe = spawnSync(
        process.execPath,
        ["--input-type=module", "-e", `await (${kernelProbe.toString()})();`, unit],
        childOptions,
      );
      assert.equal(probe.status, 0, probe.stderr);
      if (!kernelOnly) {
        const before = await snapshot();
        const result = spawnSync(
          process.execPath,
          ["/app/openclaw.mjs", "gateway", "install", "--force", "--json"],
          childOptions,
        );
        assert.notEqual(result.status, null, "packaged CLI must finish normally");
        assert.notEqual(result.status, 0);
        assert.match(`${result.stdout}${result.stderr}`, /SERVICE_DEFINITION_SEALED/);
        assert.deepEqual(
          await snapshot(),
          before,
          "force-install must not mutate config/token/env/unit/backup",
        );
      }
      console.log(
        `${kernelOnly ? "Kernel contract only" : "Packaged force-install denial"}: same-UID read-only file mount, mode=${mode.toString(8)}.`,
      );
    } finally {
      execFileSync("/bin/umount", [unit]);
    }
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
