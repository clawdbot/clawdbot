import { describe, expect, it } from "vitest";
import {
  resolveLegacyDaemonCliAccessors,
  resolveLegacyDaemonCliRegisterAccessor,
  resolveLegacyDaemonCliRunnerAccessors,
} from "./daemon-cli-compat.js";

describe("resolveLegacyDaemonCliAccessors", () => {
  it("resolves aliased daemon-cli exports from a bundled chunk", () => {
    const bundle = `
      var daemon_cli_exports = /* @__PURE__ */ __exportAll({ registerDaemonCli: () => registerDaemonCli });
      export { runDaemonStop as a, runDaemonStart as i, runDaemonStatus as n, runDaemonUninstall as o, runDaemonRestart as r, runDaemonInstall as s, daemon_cli_exports as t };
    `;

    expect(resolveLegacyDaemonCliAccessors(bundle)).toEqual({
      registerDaemonCli: "t.registerDaemonCli",
      runDaemonInstall: "s",
      runDaemonRestart: "r",
      runDaemonStart: "i",
      runDaemonStatus: "n",
      runDaemonStop: "a",
      runDaemonUninstall: "o",
    });
  });

  it("returns null when required aliases are missing", () => {
    const bundle = `
      var daemon_cli_exports = /* @__PURE__ */ __exportAll({ registerDaemonCli: () => registerDaemonCli });
      export { runDaemonRestart as r, daemon_cli_exports as t };
    `;

    expect(resolveLegacyDaemonCliAccessors(bundle)).toEqual({
      registerDaemonCli: "t.registerDaemonCli",
      runDaemonRestart: "r",
    });
  });

  it("returns null when the required restart alias is missing", () => {
    const bundle = `
      var daemon_cli_exports = /* @__PURE__ */ __exportAll({ registerDaemonCli: () => registerDaemonCli });
      export { daemon_cli_exports as t };
    `;

    expect(resolveLegacyDaemonCliAccessors(bundle)).toBeNull();
  });

  it("resolves split register and runner bundles", () => {
    const daemonBundle = `
      var daemon_cli_exports = /* @__PURE__ */ __exportAll({ registerDaemonCli: () => registerDaemonCli });
      export { addGatewayServiceCommands as n, daemon_cli_exports as t };
    `;
    const runnerBundle = `
      export { runDaemonInstall as a, runDaemonUninstall as i, runDaemonStart as n, runDaemonStop as r, runDaemonRestart as t, runDaemonStatus as u };
    `;

    expect(resolveLegacyDaemonCliRegisterAccessor(daemonBundle)).toBe("t.registerDaemonCli");
    expect(resolveLegacyDaemonCliRunnerAccessors(runnerBundle)).toEqual({
      runDaemonInstall: "a",
      runDaemonRestart: "t",
      runDaemonStart: "n",
      runDaemonStatus: "u",
      runDaemonStop: "r",
      runDaemonUninstall: "i",
    });
  });

  it("resolves partial runner bundles for split runtime chunks", () => {
    const installRuntimeBundle = `
      export { runDaemonInstall };
    `;
    const lifecycleRuntimeBundle = `
      export { runDaemonRestart as t, runDaemonStart as n, runDaemonStop as r, runDaemonUninstall as i };
    `;

    expect(resolveLegacyDaemonCliRunnerAccessors(installRuntimeBundle)).toEqual({
      runDaemonInstall: "runDaemonInstall",
    });
    expect(resolveLegacyDaemonCliRunnerAccessors(lifecycleRuntimeBundle)).toEqual({
      runDaemonRestart: "t",
      runDaemonStart: "n",
      runDaemonStop: "r",
      runDaemonUninstall: "i",
    });
  });
});
