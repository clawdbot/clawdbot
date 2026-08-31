import { expect, it, vi } from "vitest";
import { relayTestKey } from "../../chrome-extension/relay-key.test-support.js";
import { runExtensionRelayDaemon } from "./relay-daemon.js";

vi.mock("./extension-relay/relay-server.js", () => ({
  startExtensionRelayServer: async () => ({
    port: 18799,
    bridge: { extensionConnected: false, cdpClientCount: 0 },
    close: async () => {
      throw new Error("native cleanup refused");
    },
  }),
}));

it("reports failed owner cleanup through done instead of acknowledging daemon shutdown", async () => {
  const run = await runExtensionRelayDaemon({ port: 18799, readToken: () => relayTestKey(1) });
  const failed = expect(run.done).rejects.toThrow("native cleanup refused");
  run.stop();
  await failed;
});
