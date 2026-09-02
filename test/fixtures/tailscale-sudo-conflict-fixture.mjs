#!/usr/bin/env node
if (process.argv.includes("status")) {
  process.stdout.write("{}");
  process.exit(0);
}
if (process.argv[2] === "-n") {
  process.stderr.write("listener already exists for port 443\n");
} else {
  process.stderr.write("Access denied: serve config denied\nUse 'sudo tailscale serve'.\n");
}
process.exit(1);
