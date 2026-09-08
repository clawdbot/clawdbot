#!/usr/bin/env node
const net = require("node:net");
const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== "mcp" || args[1] !== "--embedded" || args[2] !== "--socket") {
  process.exit(64);
}
if (
  process.env.CUA_DRIVER_EMBEDDED !== undefined ||
  process.env.CUA_DRIVER_PERMISSION_MODE !== undefined ||
  process.env.CUA_DRIVER_DANGEROUSLY_BYPASS_APPROVALS !== undefined ||
  process.env.CUA_DRIVER_RS_TELEMETRY_ENABLED !== "false" ||
  process.env.CUA_DRIVER_RS_UPDATE_CHECK !== "false"
) {
  process.exit(65);
}
const socket = net.createConnection(args[3]);
process.stdin.pipe(socket);
socket.pipe(process.stdout);
socket.on("error", (error) => {
  process.stderr.write(error.message);
  process.exit(66);
});
socket.on("close", () => process.exit(0));
