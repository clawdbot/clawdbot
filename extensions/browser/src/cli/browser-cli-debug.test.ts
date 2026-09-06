// Browser tests cover browser cli debug plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as browserCliSharedModule from "./browser-cli-shared.js";
import {
  createBrowserProgram,
  getBrowserCliRuntime,
  getBrowserCliRuntimeCapture,
} from "./browser-cli.test-support.js";
import * as cliCoreApiModule from "./core-api.js";

const mocks = vi.hoisted(() => ({
  callBrowserRequest: vi.fn(async (..._args: unknown[]) => ({ ok: true })),
}));

vi.spyOn(browserCliSharedModule, "callBrowserRequest").mockImplementation(mocks.callBrowserRequest);
const browserCliRuntime = getBrowserCliRuntime();
vi.spyOn(cliCoreApiModule.defaultRuntime, "writeJson").mockImplementation(
  browserCliRuntime.writeJson,
);
vi.spyOn(cliCoreApiModule.defaultRuntime, "error").mockImplementation(browserCliRuntime.error);
vi.spyOn(cliCoreApiModule.defaultRuntime, "exit").mockImplementation(browserCliRuntime.exit);

const { registerBrowserDebugCommands } = await import("./browser-cli-debug.js");

describe("browser debug command timeouts", () => {
  beforeEach(() => {
    mocks.callBrowserRequest.mockClear();
    getBrowserCliRuntimeCapture().resetRuntimeCapture();
  });

  it.each([
    { args: ["highlight", "e1"], path: "/highlight" },
    { args: ["errors"], path: "/errors" },
    { args: ["requests"], path: "/requests" },
    { args: ["trace", "start"], path: "/trace/start" },
    { args: ["trace", "stop"], path: "/trace/stop" },
  ])("inherits the parent timeout for $path", async ({ args, path }) => {
    for (const timeout of ["30000", "60000"]) {
      const { program, browser, parentOpts } = createBrowserProgram();
      browser.option("--timeout <ms>", "Timeout in ms", "30000");
      registerBrowserDebugCommands(browser, parentOpts);
      const parentArgs = timeout === "30000" ? ["--json"] : ["--json", "--timeout", timeout];

      await program.parseAsync(["browser", ...parentArgs, ...args], { from: "user" });

      expect(mocks.callBrowserRequest).toHaveBeenLastCalledWith(
        expect.objectContaining({ timeout }),
        expect.objectContaining({ path }),
      );
    }
  });
});
