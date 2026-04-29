import fs from "node:fs";
import JSON5 from "json5";

const [scenario, configPath, expectedWorkspace] = process.argv.slice(2);
if (!scenario || !configPath) {
  throw new Error("usage: assert-config.mjs <scenario> <config-path> [expected-workspace]");
}

const cfg = JSON5.parse(fs.readFileSync(configPath, "utf8"));
const errors = [];
const got = (value) => value ?? "unset";
const expectEqual = (label, actual, expected) => {
  if (actual !== expected) {
    errors.push(`${label} mismatch (got ${got(actual)})`);
  }
};

const assertLocalWizard = () => {
  expectEqual("gateway.mode", cfg?.gateway?.mode, "local");
  expectEqual("wizard.lastRunMode", cfg?.wizard?.lastRunMode, "local");
};

switch (scenario) {
  case "local-basic": {
    expectEqual("agents.defaults.workspace", cfg?.agents?.defaults?.workspace, expectedWorkspace);
    assertLocalWizard();
    expectEqual("gateway.bind", cfg?.gateway?.bind, "loopback");
    expectEqual("gateway.tailscale.mode", cfg?.gateway?.tailscale?.mode ?? "off", "off");
    if (!cfg?.wizard?.lastRunAt) {
      errors.push("wizard.lastRunAt missing");
    }
    if (!cfg?.wizard?.lastRunVersion) {
      errors.push("wizard.lastRunVersion missing");
    }
    expectEqual("wizard.lastRunCommand", cfg?.wizard?.lastRunCommand, "onboard");
    break;
  }
  case "remote-non-interactive":
    expectEqual("gateway.mode", cfg?.gateway?.mode, "remote");
    expectEqual("gateway.remote.url", cfg?.gateway?.remote?.url, "ws://gateway.local:18789");
    expectEqual("gateway.remote.token", cfg?.gateway?.remote?.token, "remote-token");
    expectEqual("wizard.lastRunMode", cfg?.wizard?.lastRunMode, "remote");
    break;
  case "reset":
    assertLocalWizard();
    if (cfg?.gateway?.remote?.url) {
      errors.push(`gateway.remote.url should be cleared (got ${cfg.gateway.remote.url})`);
    }
    break;
  case "channels":
    if (cfg?.telegram?.botToken) {
      errors.push(`telegram.botToken should be unset (got ${cfg.telegram.botToken})`);
    }
    if (cfg?.discord?.token) {
      errors.push(`discord.token should be unset (got ${cfg.discord.token})`);
    }
    if (cfg?.slack?.botToken || cfg?.slack?.appToken) {
      errors.push(
        `slack tokens should be unset (got bot=${got(cfg?.slack?.botToken)}, app=${got(cfg?.slack?.appToken)})`,
      );
    }
    expectEqual("wizard.lastRunCommand", cfg?.wizard?.lastRunCommand, "configure");
    break;
  case "skills":
    expectEqual("skills.install.nodeManager", cfg?.skills?.install?.nodeManager, "bun");
    if (!Array.isArray(cfg?.skills?.allowBundled) || cfg.skills.allowBundled[0] !== "__none__") {
      errors.push("skills.allowBundled missing");
    }
    assertLocalWizard();
    break;
  default:
    throw new Error(`unknown onboard assertion scenario: ${scenario}`);
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exit(1);
}
