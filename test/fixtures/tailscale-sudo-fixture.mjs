#!/usr/bin/env node
if (process.argv.includes("status")) {
  process.stdout.write("{}");
  process.exit(0);
}
if (process.argv[2] === "-n") {
  const mode = process.env.OPENCLAW_TEST_TAILSCALE_SUDO_FIXTURE_MODE;
  if (mode === "password") {
    process.stderr.write("sudo: a password is required\n");
  } else if (mode === "route-error") {
    process.stderr.write("Funnel is not enabled on your tailnet.\n");
  } else {
    process.stderr.write("listener already exists for port 443\n");
  }
} else {
  process.stderr.write("Access denied: serve config denied\nUse 'sudo tailscale serve'.\n");
}
process.exit(1);
