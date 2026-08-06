const path = require("node:path");
const { spawnSync } = require("node:child_process");

const mountPath = (process.env.STATE_mountPath ?? "").trim();
if (!mountPath || !path.isAbsolute(mountPath) || /[\r\n]/u.test(mountPath)) {
  console.error("::error::Saved bind mount cleanup path is invalid");
  process.exit(1);
}

const mountpoint = spawnSync("mountpoint", ["-q", mountPath], { stdio: "inherit" });
if (mountpoint.error) {
  console.error(`::error::Failed to inspect bind mount: ${mountpoint.error.message}`);
  process.exit(1);
}
if (mountpoint.status === 32) {
  console.log(`Bind mount already absent: ${mountPath}`);
  process.exit(0);
}
if (mountpoint.status !== 0) {
  console.error(`::error::mountpoint exited with status ${mountpoint.status}`);
  process.exit(1);
}

const unmount = spawnSync("sudo", ["umount", mountPath], { stdio: "inherit" });
if (unmount.error || unmount.status !== 0) {
  const detail = unmount.error?.message ?? `status ${unmount.status}`;
  console.error(`::error::Failed to unmount ${mountPath}: ${detail}`);
  process.exit(1);
}

console.log(`Unmounted bind mount: ${mountPath}`);
