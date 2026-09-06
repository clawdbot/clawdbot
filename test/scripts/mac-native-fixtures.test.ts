import { once } from "node:events";
import { createServer } from "node:net";
import { expect } from "vitest";
import { runMacFixtureTool } from "./mac-native-fixtures.test-support.js";
import { createMacScriptTest } from "./mac-script-fixture.test-support.js";

const it = createMacScriptTest();

it("services parent events while an owned native fixture tool waits for release", ({ mac }) =>
  mac.lifetime.run(async () => {
    const root = mac.createTempDir("mac-native-handshake-");
    const server = createServer((socket) => socket.end("released"));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Missing fixture listener address");
      }
      const output = await runMacFixtureTool(
        process.execPath,
        [
          "--eval",
          `
const socket = require("node:net").connect(${address.port}, "127.0.0.1");
const deadline = setTimeout(() => {
  console.error("parent could not service fixture handshake");
  process.exit(73);
}, 1500);
socket.on("data", (data) => process.stdout.write(data));
socket.on("end", () => clearTimeout(deadline));
`,
        ],
        root,
        mac,
      );
      expect(output).toBe("released");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }));
