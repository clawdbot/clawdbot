#!/usr/bin/env node
const args = process.argv.slice(2);
const serveArgs = ["serve", "--yes", "--bg=false", "18789"];
const stalledFunnelArgs = ["funnel", "--yes", "--bg=false", "18790"];
if (
  JSON.stringify(args) !== JSON.stringify(serveArgs) &&
  JSON.stringify(args) !== JSON.stringify(stalledFunnelArgs)
) {
  process.stderr.write(`unexpected arguments: ${JSON.stringify(process.argv.slice(2))}\n`);
  process.exit(2);
}
if (JSON.stringify(args) === JSON.stringify(serveArgs)) {
  process.stdout.write("Press Ctrl+C to exit.\n");
} else {
  process.stderr.write("Funnel is not enabled on your tailnet.\n");
  const marker = process.env.OPENCLAW_TEST_TAILSCALE_FIXTURE_MARKER;
  if (marker) {
    await import("node:fs/promises").then(({ writeFile }) => writeFile(marker, "ready"));
  }
}
setInterval(() => {}, 1000);
