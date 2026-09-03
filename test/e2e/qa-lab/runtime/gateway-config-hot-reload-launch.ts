import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { chromium, type BrowserContext } from "playwright";
import type { QaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import { runQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import { waitForHotReloadFact } from "./gateway-config-hot-reload-fixtures.js";

type BrowserStatus = { profile: string; pid: number | null; cdpUrl: string; cdpPort: number };
type Tabs = { running: boolean; tabs: Array<{ title: string }> };

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

async function unusedPort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

async function waitForExit(pid: number) {
  await waitForHotReloadFact(`Chrome ${pid} exit`, () => {
    try {
      process.kill(pid, 0);
      return undefined;
    } catch (error) {
      assert.equal((error as NodeJS.ErrnoException).code, "ESRCH");
      return true;
    }
  });
}

export async function proveHotReloadBrowserLaunch({
  gateway,
  temporaryRoot,
  rpc,
  patch,
  verifyContinuity,
  proveGroup,
}: {
  gateway: QaGatewayChild;
  temporaryRoot: string;
  rpc: <T>(method: string, params?: unknown) => Promise<T>;
  patch: (change: unknown, replacePaths?: string[]) => Promise<unknown>;
  verifyContinuity: (prefix: string, observation: string) => Promise<void>;
  proveGroup: (prefix: string, run: () => Promise<void>) => Promise<void>;
}) {
  const root = await fs.mkdtemp(path.join(temporaryRoot, "browser-launch-"));
  const executablePath = await fs.realpath(chromium.executablePath());
  const launcher = path.join(root, "chromium-forwarder");
  const launcherMarker = path.join(root, "launcher-invoked");
  await fs.writeFile(
    launcher,
    `#!/bin/sh\nprintf 'started' > ${shellQuote(launcherMarker)}\nexec ${shellQuote(executablePath)} "$@"\n`,
    { mode: 0o700 },
  );
  let external: BrowserContext | undefined;
  const request = <T>(route: string, method = "GET", profile?: string) =>
    rpc<T>("browser.request", {
      target: "host",
      method,
      path: route,
      ...(profile ? { query: { profile } } : {}),
      timeoutMs: 30_000,
    });
  const setBrowser = (change: unknown) => patch({ browser: change }, ["browser.extraArgs"]);

  await runQaGatewayFixture(
    async () => {
      assert(
        gateway.runtimeEnv.DISPLAY,
        "Headed Chrome proof requires Gateway DISPLAY from xvfb-run",
      );
      external = await chromium.launchPersistentContext(path.join(root, "external-profile"), {
        executablePath,
        headless: true,
        args: ["--remote-debugging-port=0"],
      });
      const externalBrowser = external.browser();
      assert(externalBrowser);
      const externalPage = await external.newPage();
      await externalPage.setContent(
        "<title>Retained external Chrome</title><p>External browser stays alive</p>",
      );
      const externalCdp = await externalBrowser.newBrowserCDPSession();
      const originalProcesses = await externalCdp.send("SystemInfo.getProcessInfo");
      const externalPid = originalProcesses.processInfo.find(
        (entry) => entry.type === "browser",
      )?.id;
      assert(externalPid);
      const portFile = path.join(root, "external-profile", "DevToolsActivePort");
      const portText = await waitForHotReloadFact("external Chrome CDP listener", async () => {
        try {
          return await fs.readFile(portFile, "utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return undefined;
          }
          throw error;
        }
      });
      const externalUrl = `http://127.0.0.1:${Number(portText.split("\n")[0])}`;
      const checkExternal = async () => {
        assert.equal(await externalPage.title(), "Retained external Chrome");
        const processes = await externalCdp.send("SystemInfo.getProcessInfo");
        assert(
          processes.processInfo.some(
            (entry) => entry.type === "browser" && entry.id === externalPid,
          ),
        );
        const tabs = await request<Tabs>("/tabs", "GET", "retained");
        assert(tabs.running && tabs.tabs.some((tab) => tab.title === "Retained external Chrome"));
      };
      const reset = async () => {
        await setBrowser({
          defaultProfile: "openclaw",
          headless: true,
          executablePath,
          attachOnly: false,
          cdpUrl: null,
          noSandbox: true,
          extraArgs: ["--enable-automation"],
          profiles: { openclaw: null, retained: { cdpUrl: externalUrl, attachOnly: true } },
        });
      };
      const inspect = async () => {
        await request("/start", "POST", "openclaw");
        const status = await request<BrowserStatus>("/", "GET", "openclaw");
        assert(status.pid, "Gateway must own the started Chrome process");
        const browser = await chromium.connectOverCDP(status.cdpUrl);
        try {
          const cdp = await browser.newBrowserCDPSession();
          const processes = await cdp.send("SystemInfo.getProcessInfo");
          assert(
            processes.processInfo.some(
              (entry) => entry.type === "browser" && entry.id === status.pid,
            ),
          );
          const command = await cdp.send("Browser.getBrowserCommandLine");
          const context = browser.contexts()[0];
          assert(context);
          const page = await context.newPage();
          const scale = await page.evaluate(() => devicePixelRatio);
          await page.close();
          return { ...status, pid: status.pid, args: command.arguments, scale };
        } finally {
          // connectOverCDP owns this transport only; close does not stop the Gateway's Chrome.
          await browser.close();
        }
      };
      const finish = async (prefix: string, observation: string) => {
        await checkExternal();
        await verifyContinuity(
          prefix,
          `${observation}; external Chrome PID ${externalPid} and its page/CDP session survived`,
        );
      };

      await proveGroup("browser.defaultProfile", async () => {
        await reset();
        await inspect();
        for (const profile of ["retained", "openclaw"]) {
          await setBrowser({ defaultProfile: profile });
          assert.equal((await request<BrowserStatus>("/")).profile, profile);
        }
        await finish(
          "browser.defaultProfile",
          "The first host request selected each changed default",
        );
      });
      await proveGroup("browser.headless", async () => {
        await reset();
        let previous = await inspect();
        assert(previous.args.some((arg) => arg.startsWith("--headless")));
        for (const headless of [false, true]) {
          await setBrowser({ headless });
          const current = await inspect();
          assert.notEqual(current.pid, previous.pid);
          await waitForExit(previous.pid);
          assert.equal(
            current.args.some((arg) => arg.startsWith("--headless")),
            headless,
          );
          previous = current;
        }
        await finish(
          "browser.headless",
          "Real Chromium replaced headless→headed on Xvfb→headless processes",
        );
      });
      await proveGroup("browser.executablePath", async () => {
        await reset();
        let previous = await inspect();
        for (const selectedPath of [launcher, executablePath]) {
          await fs.rm(launcherMarker, { force: true });
          await setBrowser({ executablePath: selectedPath });
          const current = await inspect();
          assert.notEqual(current.pid, previous.pid);
          await waitForExit(previous.pid);
          assert.equal(current.args[0], executablePath);
          if (selectedPath === launcher) {
            assert.equal(await fs.readFile(launcherMarker, "utf8"), "started");
          } else {
            await assert.rejects(fs.access(launcherMarker), { code: "ENOENT" });
          }
          previous = current;
        }
        await finish(
          "browser.executablePath",
          "The configured forwarding launcher executed real Chrome; restoring the binary bypassed it and replaced the process again",
        );
      });
      await proveGroup("browser.attachOnly", async () => {
        await reset();
        const previous = await inspect();
        await setBrowser({ attachOnly: true });
        await assert.rejects(request("/start", "POST", "openclaw"), /attachOnly.*not running/);
        await waitForExit(previous.pid);
        await setBrowser({ attachOnly: false });
        assert.notEqual((await inspect()).pid, previous.pid);
        await finish(
          "browser.attachOnly",
          "Attach-only drained owned Chrome and rejected launch; disabling it restored a real managed process",
        );
      });
      await proveGroup("browser.cdpUrl", async () => {
        await reset();
        const previous = await inspect();
        const port = await unusedPort();
        await setBrowser({ cdpUrl: `http://127.0.0.1:${port}` });
        const current = await inspect();
        assert.notEqual(current.pid, previous.pid);
        await waitForExit(previous.pid);
        assert.equal(current.cdpPort, port);
        assert(current.args.includes(`--remote-debugging-port=${port}`));
        await finish(
          "browser.cdpUrl",
          "The replacement Chromium served real CDP at the newly configured port",
        );
      });
      await proveGroup("browser.noSandbox", async () => {
        await reset();
        const previous = await inspect();
        assert(previous.args.includes("--no-sandbox"));
        await setBrowser({ noSandbox: false });
        let outcome = "Chrome started with its sandbox enabled";
        let sandboxStarted = true;
        try {
          await request("/start", "POST", "openclaw");
        } catch (error) {
          assert.match(String(error), /sandbox|zygote|Operation not permitted/i);
          sandboxStarted = false;
          outcome = "The host rejected real sandboxed Chrome startup";
        }
        if (sandboxStarted) {
          const current = await inspect();
          assert.notEqual(current.pid, previous.pid);
          assert(!current.args.includes("--no-sandbox"));
        }
        await waitForExit(previous.pid);
        await setBrowser({ noSandbox: true });
        assert((await inspect()).args.includes("--no-sandbox"));
        await finish(
          "browser.noSandbox",
          `${outcome}; restoring noSandbox launched Chrome successfully`,
        );
      });
      await proveGroup("browser.extraArgs", async () => {
        await reset();
        let previous = await inspect();
        for (const scale of [2, 1]) {
          await setBrowser({
            extraArgs: ["--enable-automation", `--force-device-scale-factor=${scale}`],
          });
          const current = await inspect();
          assert.notEqual(current.pid, previous.pid);
          await waitForExit(previous.pid);
          assert.equal(current.scale, scale);
          previous = current;
        }
        await finish(
          "browser.extraArgs",
          "New Chrome arguments changed actual page devicePixelRatio to 2 then 1",
        );
      });
      await reset();
    },
    () => request("/stop", "POST", "openclaw"),
    () => external?.close(),
    () => fs.rm(root, { recursive: true, force: true }),
  );
}
