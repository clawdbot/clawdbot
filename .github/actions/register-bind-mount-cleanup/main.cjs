const fs = require("node:fs");
const path = require("node:path");

const mountPath = (process.env.INPUT_PATH ?? "").trim();
const statePath = process.env.GITHUB_STATE;

if (!mountPath || !path.isAbsolute(mountPath) || /[\r\n]/u.test(mountPath)) {
  console.error("::error::Bind mount cleanup path must be an absolute single-line path");
  process.exit(1);
}
if (!statePath) {
  console.error("::error::GITHUB_STATE is unavailable");
  process.exit(1);
}

fs.appendFileSync(statePath, `mountPath=${mountPath}\n`, "utf8");
console.log(`Registered bind mount cleanup for ${mountPath}`);
