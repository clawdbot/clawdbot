// Control UI root tests protect packaged UI root validation, including global
// package hardlink rejection for unsafe configured roots.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { installGatewayTestHooks, testState, withGatewayServer } from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

async function withGlobalControlUiHardlinkFixture<T>(run: (rootPath: string) => Promise<T>) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gateway-ui-hardlink-"));
  try {
    const packageRoot = path.join(tmp, "pnpm-global", "5", "node_modules", "openclaw");
    const controlUiRoot = path.join(packageRoot, "dist", "control-ui");
    await fs.mkdir(controlUiRoot, { recursive: true });
    await fs.writeFile(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "openclaw" }),
    );

    const storeDir = path.join(tmp, "pnpm-store", "files");
    await fs.mkdir(storeDir, { recursive: true });
    const storeIndex = path.join(storeDir, "index.html");
    await fs.writeFile(storeIndex, "<html><body>pnpm-hardlink-ui</body></html>\n");
    await fs.link(storeIndex, path.join(controlUiRoot, "index.html"));

    return await run(controlUiRoot);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

describe("gateway.controlUi.root", () => {
  test("rejects hardlinked index.html when configured root points at global OpenClaw package control-ui", async () => {
    await withGlobalControlUiHardlinkFixture(async (rootPath) => {
      testState.gatewayControlUi = { root: rootPath };
      await withGatewayServer(
        async ({ port }) => {
          const res = await fetch(`http://127.0.0.1:${port}/`);
          expect(res.status).toBe(404);
          expect(await res.text()).toBe("Not Found");
        },
        { serverOptions: { controlUiEnabled: true } },
      );
    });
  });
});
