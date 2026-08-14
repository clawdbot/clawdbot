#!/usr/bin/env node
const expected = ["serve", "--yes", "--bg=false", "18789"];
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(expected)) {
  process.stderr.write(`unexpected arguments: ${JSON.stringify(process.argv.slice(2))}\n`);
  process.exit(2);
}
process.stdout.write("Press Ctrl+C to exit.\n");
setInterval(() => {}, 1000);
