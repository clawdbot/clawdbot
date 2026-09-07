#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import net from "node:net";

const [command, ...args] = process.argv.slice(2);
if (command === "gateway") {
  const { claimTailscaleRoute } = await import(args[0]);
  const claim = await claimTailscaleRoute("serve", 18791, 18791, () => {});
  process.send({ type: "ready" });
  process.once("message", async () => {
    await claim.stop();
    process.exit(0);
  });
} else if (command === "serve" && args[0] === "status") {
  process.stdout.write("{}");
} else if (command === "serve") {
  const server = net.createServer((socket) => socket.end());
  server.listen(Number(process.env.OPENCLAW_TEST_ROUTE_PORT ?? 0), "127.0.0.1", () => {
    writeFileSync(
      process.env.OPENCLAW_TEST_ROUTE_MARKER,
      JSON.stringify({ pid: process.pid, ownerPid: process.ppid, port: server.address().port }),
    );
    process.stdout.write("Press Ctrl+C to exit.\n");
  });
} else {
  throw new Error(`Unexpected fixture command: ${command}`);
}
