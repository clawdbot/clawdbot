#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";

const args = process.argv.slice(2);
const marker = process.env.OPENCLAW_TEST_TAILSCALE_FIXTURE_MARKER;
const mode = process.env.OPENCLAW_TEST_TAILSCALE_FIXTURE_MODE;
if (!marker || (mode !== "serve" && mode !== "funnel")) {
  process.stderr.write("missing fixture state\n");
  process.exit(2);
}

if (JSON.stringify(args) === JSON.stringify(["status", "--json"])) {
  process.stdout.write(JSON.stringify({ Self: { DNSName: "fixture.tailnet.ts.net." } }));
  process.exit(0);
}

if (JSON.stringify(args) === JSON.stringify(["serve", "status", "--json"])) {
  process.stdout.write(await readFile(marker, "utf8"));
  process.exit(0);
}

if (
  JSON.stringify(args) === JSON.stringify(["serve", "--yes", "--https=443", "--set-path=/", "off"])
) {
  const status = JSON.parse(await readFile(marker, "utf8"));
  const host = "fixture.tailnet.ts.net:443";
  delete status.Web[host].Handlers["/"];
  if (Object.keys(status.Web[host].Handlers).length === 0) {
    delete status.Web[host];
    delete status.TCP["443"];
    if (status.AllowFunnel) delete status.AllowFunnel[host];
  }
  for (const key of ["Web", "TCP", "AllowFunnel"]) {
    if (status[key] && Object.keys(status[key]).length === 0) delete status[key];
  }
  await writeFile(marker, JSON.stringify(status));
  process.exit(0);
}

if (JSON.stringify(args) === JSON.stringify([mode, "--yes", "--bg=false", "19000"])) {
  const state = await readFile(marker, "utf8");
  const status = JSON.parse(state);
  if ([status, ...Object.values(status.Foreground ?? {})].some((config) => config.TCP?.["443"])) {
    process.stderr.write("listener already exists for port 443\n");
    process.exit(1);
  }
  process.stdout.write("Press Ctrl+C to exit.\n");
  setInterval(() => {}, 1000);
} else {
  process.stderr.write(`unexpected arguments: ${JSON.stringify(args)}\n`);
  process.exit(2);
}
