/**
 * Integration tests for QA runner runtime public surface loading.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setTestEnvValue } from "../test-utils/env.js";
import * as activationCheckRuntime from "./facade-activation-check.runtime.js";
import {
  testing as facadeRuntimeTesting,
  resetFacadeRuntimeStateForTest,
} from "./facade-runtime.js";
import { listQaRunnerCliContributions } from "./qa-runner-runtime.js";

const ORIGINAL_ENV = {
  OPENCLAW_ENABLE_PRIVATE_QA_CLI: process.env.OPENCLAW_ENABLE_PRIVATE_QA_CLI,
  OPENCLAW_DISABLE_BUNDLED_PLUGINS: process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS,
  OPENCLAW_CONFIG_PATH: process.env.OPENCLAW_CONFIG_PATH,
  OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR,
  OPENCLAW_TEST_FAST: process.env.OPENCLAW_TEST_FAST,
} as const;

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function resetQaRunnerRuntimeState() {
  resetFacadeRuntimeStateForTest();
  facadeRuntimeTesting.setFacadeActivationCheckRuntimeForTest(activationCheckRuntime);
}

describe("plugin-sdk qa-runner-runtime linked plugin smoke", () => {
  beforeEach(() => {
    resetQaRunnerRuntimeState();
    process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = "1";
    process.env.OPENCLAW_TEST_FAST = "1";
  });

  afterEach(() => {
    resetQaRunnerRuntimeState();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        setTestEnvValue(key, value);
      }
    }
  });

  it("loads an activated qa runner from a linked plugin path without a bundled install fallback", async () => {
    const stateDir = makeTempDir("openclaw-qa-runner-state-");
    const pluginDir = path.join(stateDir, "extensions", "qa-linked");
    const configPath = path.join(stateDir, "openclaw.json");

    fs.writeFileSync(
      configPath,
      JSON.stringify({
        plugins: {},
      }),
      "utf8",
    );
    process.env.OPENCLAW_CONFIG_PATH = configPath;
    process.env.OPENCLAW_STATE_DIR = stateDir;

    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "qa-linked",
        qaRunners: [
          {
            commandName: "linked",
            description: "Run the linked QA lane",
          },
        ],
        configSchema: {
          type: "object",
          additionalProperties: false,
          properties: {},
        },
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify({
        name: "@openclaw/qa-linked",
        type: "module",
        openclaw: {
          extensions: ["./index.js"],
          install: {
            npmSpec: "@openclaw/qa-linked",
          },
        },
      }),
      "utf8",
    );
    fs.writeFileSync(path.join(pluginDir, "index.js"), "export default {};\n", "utf8");
    fs.writeFileSync(
      path.join(pluginDir, "runtime-api.js"),
      [
        "export const qaRunnerCliRegistrations = [",
        "  {",
        '    commandName: "linked",',
        '    adapterFactory: { id: "linked", matches() { return true; }, async create(context) { return { id: "linked", label: "Linked", accountId: "sut", requiredPluginIds: [], supportedActions: [], async sendInbound(input) { return await context.messages.addInboundMessage(input); }, createGatewayConfig() { return {}; }, async waitReady() {}, buildAgentDelivery({ target }) { return { channel: "linked", to: target, replyChannel: "linked", replyTo: target }; }, async handleAction() {}, createReportNotes() { return []; } }; } },',
        "    register() {}",
        "  }",
        "];",
      ].join("\n"),
      "utf8",
    );

    const contributions = listQaRunnerCliContributions();
    const contribution = contributions[0];
    expect(contribution?.status).toBe("available");
    if (!contribution || contribution.status !== "available") {
      throw new Error("Expected linked QA runner contribution to be available");
    }
    const register = contribution.registration["register"];
    expect(typeof register).toBe("function");
    expect(contributions).toEqual([
      {
        pluginId: "qa-linked",
        commandName: "linked",
        description: "Run the linked QA lane",
        status: "available",
        registration: {
          commandName: "linked",
          adapterFactory: expect.objectContaining({
            id: "linked",
          }),
          register,
        },
      },
    ]);
  });

  it("ignores operator runner metadata and state during private QA discovery", () => {
    const stateDir = makeTempDir("openclaw-private-qa-operator-state-");
    const pluginDir = path.join(stateDir, "extensions", "operator-runner");
    const stateDatabasePath = path.join(stateDir, "openclaw.sqlite");
    const stateDatabaseSentinel = "operator-state-must-remain-unopened";

    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(stateDatabasePath, stateDatabaseSentinel, "utf8");
    fs.writeFileSync(
      path.join(pluginDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "operator-runner",
        qaRunners: [{ commandName: "operator-sentinel" }],
        configSchema: {
          type: "object",
          additionalProperties: false,
          properties: {},
        },
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify({
        name: "@openclaw/operator-runner",
        type: "module",
        openclaw: { extensions: ["./index.js"] },
      }),
      "utf8",
    );
    fs.writeFileSync(path.join(pluginDir, "index.js"), "export default {};\n", "utf8");

    process.env.OPENCLAW_ENABLE_PRIVATE_QA_CLI = "1";
    process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = "0";
    process.env.OPENCLAW_STATE_DIR = stateDir;
    process.env.OPENCLAW_CONFIG_PATH = path.join(stateDir, "openclaw.json");

    const contributions = listQaRunnerCliContributions();

    expect(contributions.some((runner) => runner.pluginId === "operator-runner")).toBe(false);
    expect(fs.readFileSync(stateDatabasePath, "utf8")).toBe(stateDatabaseSentinel);
  });
});
