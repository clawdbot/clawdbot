import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import {
  executeCrestodianOperation,
  parseCrestodianOperation,
  type CrestodianOperationResult,
} from "./operations.js";

function createRuntime(): { runtime: RuntimeEnv; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    runtime: {
      log: (...args) => lines.push(args.join(" ")),
      error: (...args) => lines.push(args.join(" ")),
      exit: (code) => {
        throw new Error(`exit ${code}`);
      },
    },
  };
}

describe("parseCrestodianOperation", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("parses typed model writes", () => {
    expect(parseCrestodianOperation("set default model openai/gpt-5.2")).toEqual({
      kind: "set-default-model",
      model: "openai/gpt-5.2",
    });
    expect(parseCrestodianOperation("configure models openai/gpt-5.2")).toEqual({
      kind: "set-default-model",
      model: "openai/gpt-5.2",
    });
  });

  it("parses verbal agent switching", () => {
    expect(parseCrestodianOperation("talk to work agent")).toEqual({
      kind: "open-tui",
      agentId: "work",
    });
  });

  it("keeps ambiguous model requests read-only", () => {
    expect(parseCrestodianOperation("models please")).toEqual({ kind: "models" });
  });

  it("parses gateway lifecycle operations", () => {
    expect(parseCrestodianOperation("gateway status")).toEqual({ kind: "gateway-status" });
    expect(parseCrestodianOperation("restart gateway")).toEqual({ kind: "gateway-restart" });
    expect(parseCrestodianOperation("start gateway")).toEqual({ kind: "gateway-start" });
    expect(parseCrestodianOperation("stop gateway")).toEqual({ kind: "gateway-stop" });
  });

  it("parses config and doctor repair operations", () => {
    expect(parseCrestodianOperation("validate config")).toEqual({ kind: "config-validate" });
    expect(parseCrestodianOperation("config set gateway.port 19001")).toEqual({
      kind: "config-set",
      path: "gateway.port",
      value: "19001",
    });
    expect(parseCrestodianOperation("config set-ref gateway.auth.token env GATEWAY_TOKEN")).toEqual(
      {
        kind: "config-set-ref",
        path: "gateway.auth.token",
        source: "env",
        id: "GATEWAY_TOKEN",
      },
    );
    expect(parseCrestodianOperation("doctor fix")).toEqual({ kind: "doctor-fix" });
  });

  it("parses agent creation requests", () => {
    expect(
      parseCrestodianOperation("create agent Work workspace /tmp/work model openai/gpt-5.2"),
    ).toEqual({
      kind: "create-agent",
      agentId: "work",
      workspace: "/tmp/work",
      model: "openai/gpt-5.2",
    });
    expect(parseCrestodianOperation("add agent ops")).toEqual({
      kind: "create-agent",
      agentId: "ops",
    });
    expect(parseCrestodianOperation("setup workspace /tmp/work model openai/gpt-5.5")).toEqual({
      kind: "setup",
      workspace: "/tmp/work",
      model: "openai/gpt-5.5",
    });
    expect(parseCrestodianOperation("setup agent ops")).toEqual({
      kind: "create-agent",
      agentId: "ops",
    });
  });

  it("requires approval before restarting gateway", async () => {
    const { runtime, lines } = createRuntime();
    const runGatewayRestart = vi.fn(async () => {});

    const result = await executeCrestodianOperation({ kind: "gateway-restart" }, runtime, {
      deps: { runGatewayRestart },
    });

    expect(result).toMatchObject<CrestodianOperationResult>({
      applied: false,
      message: "Plan: restart the Gateway. Say yes to apply.",
    });
    expect(lines.join("\n")).toContain("Plan: restart the Gateway");
    expect(runGatewayRestart).not.toHaveBeenCalled();
  });

  it("restarts gateway through typed deps and writes an audit entry", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "crestodian-gateway-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDir);
    const { runtime, lines } = createRuntime();
    const runGatewayRestart = vi.fn(async () => {});

    await expect(
      executeCrestodianOperation({ kind: "gateway-restart" }, runtime, {
        approved: true,
        deps: { runGatewayRestart },
        auditDetails: { rescue: true, channel: "whatsapp" },
      }),
    ).resolves.toMatchObject({ applied: true });

    expect(runGatewayRestart).toHaveBeenCalledTimes(1);
    expect(lines.join("\n")).toContain("[crestodian] done: gateway.restart");
    const auditPath = path.join(tempDir, "audit", "crestodian.jsonl");
    const audit = JSON.parse((await fs.readFile(auditPath, "utf8")).trim());
    expect(audit).toMatchObject({
      operation: "gateway.restart",
      summary: "Restarted Gateway",
      details: { rescue: true, channel: "whatsapp" },
    });
  });

  it("creates agents through typed deps and writes an audit entry", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "crestodian-agent-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDir);
    const { runtime, lines } = createRuntime();
    const runAgentsAdd = vi.fn(async () => {});

    await expect(
      executeCrestodianOperation(
        {
          kind: "create-agent",
          agentId: "work",
          workspace: "/tmp/work",
          model: "openai/gpt-5.2",
        },
        runtime,
        {
          approved: true,
          deps: { runAgentsAdd },
          auditDetails: { rescue: true, channel: "whatsapp" },
        },
      ),
    ).resolves.toMatchObject({ applied: true });

    expect(runAgentsAdd).toHaveBeenCalledWith(
      {
        name: "work",
        workspace: "/tmp/work",
        model: "openai/gpt-5.2",
        nonInteractive: true,
      },
      runtime,
      { hasFlags: true },
    );
    expect(lines.join("\n")).toContain("[crestodian] done: agents.create");
    const auditPath = path.join(tempDir, "audit", "crestodian.jsonl");
    const audit = JSON.parse((await fs.readFile(auditPath, "utf8")).trim());
    expect(audit).toMatchObject({
      operation: "agents.create",
      summary: "Created agent work",
      details: {
        rescue: true,
        channel: "whatsapp",
        agentId: "work",
        workspace: "/tmp/work",
        model: "openai/gpt-5.2",
      },
    });
  });

  it("validates missing config without exiting the process", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "crestodian-validate-"));
    vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(tempDir, "openclaw.json"));
    const { runtime, lines } = createRuntime();

    await expect(
      executeCrestodianOperation({ kind: "config-validate" }, runtime),
    ).resolves.toMatchObject({ applied: false });

    expect(lines.join("\n")).toContain("Config missing:");
  });

  it("applies config set through typed deps and writes an audit entry", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "crestodian-config-set-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDir);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(tempDir, "openclaw.json"));
    const { runtime, lines } = createRuntime();
    const runConfigSet = vi.fn(async () => {});

    await expect(
      executeCrestodianOperation(
        { kind: "config-set", path: "gateway.port", value: "19001" },
        runtime,
        {
          approved: true,
          deps: { runConfigSet },
          auditDetails: { rescue: true, channel: "whatsapp" },
        },
      ),
    ).resolves.toMatchObject({ applied: true });

    expect(runConfigSet).toHaveBeenCalledWith({
      path: "gateway.port",
      value: "19001",
      cliOptions: {},
    });
    expect(lines.join("\n")).toContain("[crestodian] done: config.set");
    const auditPath = path.join(tempDir, "audit", "crestodian.jsonl");
    const audit = JSON.parse((await fs.readFile(auditPath, "utf8")).trim());
    expect(audit).toMatchObject({
      operation: "config.set",
      summary: "Set config gateway.port",
      details: {
        rescue: true,
        channel: "whatsapp",
        path: "gateway.port",
      },
    });
  });

  it("applies SecretRef config set through typed deps and writes an audit entry", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "crestodian-config-ref-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDir);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(tempDir, "openclaw.json"));
    const { runtime, lines } = createRuntime();
    const runConfigSet = vi.fn(async () => {});

    await expect(
      executeCrestodianOperation(
        {
          kind: "config-set-ref",
          path: "gateway.auth.token",
          source: "env",
          id: "OPENCLAW_GATEWAY_TOKEN",
        },
        runtime,
        {
          approved: true,
          deps: { runConfigSet },
          auditDetails: { rescue: true, channel: "whatsapp" },
        },
      ),
    ).resolves.toMatchObject({ applied: true });

    expect(runConfigSet).toHaveBeenCalledWith({
      path: "gateway.auth.token",
      cliOptions: {
        refProvider: "default",
        refSource: "env",
        refId: "OPENCLAW_GATEWAY_TOKEN",
      },
    });
    expect(lines.join("\n")).toContain("[crestodian] done: config.setRef");
    const auditPath = path.join(tempDir, "audit", "crestodian.jsonl");
    const audit = JSON.parse((await fs.readFile(auditPath, "utf8")).trim());
    expect(audit).toMatchObject({
      operation: "config.setRef",
      summary: "Set config gateway.auth.token SecretRef",
      details: {
        rescue: true,
        channel: "whatsapp",
        path: "gateway.auth.token",
        source: "env",
        provider: "default",
      },
    });
  });

  it("runs setup bootstrap only after approval and audits it", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "crestodian-setup-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDir);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(tempDir, "openclaw.json"));
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    const { runtime, lines } = createRuntime();

    const plan = await executeCrestodianOperation(
      { kind: "setup", workspace: "/tmp/work" },
      runtime,
    );
    expect(plan).toMatchObject({
      applied: false,
    });
    expect(lines.join("\n")).toContain("Model choice: openai/gpt-5.5 (OPENAI_API_KEY).");

    await expect(
      executeCrestodianOperation({ kind: "setup", workspace: "/tmp/work" }, runtime, {
        approved: true,
        auditDetails: { rescue: true },
      }),
    ).resolves.toMatchObject({ applied: true });

    expect(lines.join("\n")).toContain("[crestodian] done: crestodian.setup");
    const config = JSON.parse(
      await fs.readFile(path.join(tempDir, "openclaw.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(config).toMatchObject({
      agents: {
        defaults: {
          workspace: "/tmp/work",
          model: { primary: "openai/gpt-5.5" },
        },
      },
    });
    const auditPath = path.join(tempDir, "audit", "crestodian.jsonl");
    const audit = JSON.parse((await fs.readFile(auditPath, "utf8")).trim());
    expect(audit).toMatchObject({
      operation: "crestodian.setup",
      summary: "Bootstrapped setup with openai/gpt-5.5",
      details: {
        rescue: true,
        workspace: "/tmp/work",
        model: "openai/gpt-5.5",
        modelSource: "OPENAI_API_KEY",
      },
    });
  });

  it("runs doctor repairs only after approval and audits them", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "crestodian-doctor-fix-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDir);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(tempDir, "openclaw.json"));
    const { runtime, lines } = createRuntime();
    const runDoctor = vi.fn(async () => {});

    const plan = await executeCrestodianOperation({ kind: "doctor-fix" }, runtime, {
      deps: { runDoctor },
    });
    expect(plan).toMatchObject({
      applied: false,
      message: "Plan: run doctor repairs. Say yes to apply.",
    });
    expect(runDoctor).not.toHaveBeenCalled();

    await expect(
      executeCrestodianOperation({ kind: "doctor-fix" }, runtime, {
        approved: true,
        deps: { runDoctor },
        auditDetails: { rescue: true },
      }),
    ).resolves.toMatchObject({ applied: true });

    expect(runDoctor).toHaveBeenCalledWith(runtime, {
      nonInteractive: true,
      repair: true,
      yes: true,
    });
    expect(lines.join("\n")).toContain("[crestodian] done: doctor.fix");
    const auditPath = path.join(tempDir, "audit", "crestodian.jsonl");
    const audit = JSON.parse((await fs.readFile(auditPath, "utf8")).trim().split("\n").at(-1)!);
    expect(audit).toMatchObject({
      operation: "doctor.fix",
      summary: "Ran doctor repairs",
      details: { rescue: true },
    });
  });

  it("returns from the agent TUI back to Crestodian", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "crestodian-tui-return-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDir);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(tempDir, "openclaw.json"));
    await fs.writeFile(
      path.join(tempDir, "openclaw.json"),
      JSON.stringify(
        {
          agents: {
            defaults: { model: { primary: "openai/gpt-5.2" } },
            list: [{ id: "main", default: true }, { id: "work" }],
          },
        },
        null,
        2,
      ),
    );
    const { runtime, lines } = createRuntime();
    const runTui = vi.fn(async () => ({
      exitReason: "return-to-crestodian" as const,
      crestodianMessage: "restart gateway",
    }));

    const result = await executeCrestodianOperation(
      { kind: "open-tui", agentId: "work" },
      runtime,
      {
        deps: { runTui },
      },
    );

    expect(runTui).toHaveBeenCalledWith({
      local: true,
      session: "agent:work:main",
      deliver: false,
      historyLimit: 200,
    });
    expect(result).toMatchObject({
      applied: false,
      nextInput: "restart gateway",
    });
    expect(lines.join("\n")).toContain(
      "[crestodian] returned from agent with request: restart gateway",
    );
  });
});
