#!/usr/bin/env node
import fs from "node:fs";

const [, , wrapperPath, npmBin, logPath = `${process.env.HOME}/openclaw-wrapper-argv.log`] =
  process.argv;

if (!wrapperPath || !npmBin || !logPath || logPath.startsWith("undefined/")) {
  console.error("usage: write-wrapper.mjs <wrapper-path> <npm-bin> [log-path]");
  process.exit(1);
}

function shellSingleQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

fs.writeFileSync(
  wrapperPath,
  `#!/usr/bin/env bash
set -euo pipefail
printf "%s\\n" "$@" >> ${shellSingleQuote(logPath)}
exec ${shellSingleQuote(npmBin)} "$@"
`,
  { mode: 0o755 },
);
