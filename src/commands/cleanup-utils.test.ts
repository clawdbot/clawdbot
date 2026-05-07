import path from "node:path";
import { describe, expect, it, test, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  applyAgentDefaultPrimaryModel,
  applyPrimaryModel,
} from "../plugins/provider-model-primary.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  buildCleanupPlan,
  removeStateAndLinkedPaths,
  removeWorkspaceDirs,
} from "./cleanup-utils.js";

describe("buildCleanupPlan", () => {
  test("resolves inside-state flags and workspace dirs", () => {
    const tmpRoot = path.join(path.parse(process.cwd()).root, "tmp");
    const cfg = {
      agents: {
        defaults: { workspace: path.join(tmpRoot, "openclaw-workspace-1") },
        list: [{ workspace: path.join(tmpRoot, "openclaw-workspace-2") }],
      },
    };
    const plan = buildCleanupPlan({
      cfg: cfg as unknown as OpenClawConfig,
      stateDir: path.join(tmpRoot, "openclaw-state"),
      configPath: path.join(tmpRoot, "openclaw-state", "openclaw.json"),
      oauthDir: path.join(tmpRoot, "openclaw-oauth"),
    });

    expect(plan.configInsideState).toBe(true);
    expect(plan.oauthInsideState).toBe(false);
    expect(new Set(plan.workspaceDirs)).toEqual(
      new Set([
        path.join(tmpRoot, "openclaw-workspace-1"),
        path.join(tmpRoot, "openclaw-workspace-2"),
      ]),
    );
  });
});

describe("applyAgentDefaultPrimaryModel", () => {
  it("does not mutate when already set", () => {
    const cfg = { agents: { defaults: { model: { primary: "a/b" } } } } as OpenClawConfig;
    const result = applyAgentDefaultPrimaryModel({ cfg, model: "a/b" });
    expect(result.changed).toBe(false);
    expect(result.next).toBe(cfg);
  });

  it("normalizes legacy models", () => {
    const cfg = { agents: { defaults: { model: { primary: "legacy" } } } } as OpenClawConfig;
    const result = applyAgentDefaultPrimaryModel({
      cfg,
      model: "a/b",
      legacyModels: new Set(["legacy"]),
    });
    expect(result.changed).toBe(false);
    expect(result.next).toBe(cfg);
  });
});

describe("applyPrimaryModel", () => {
  it("leaves OpenAI model selections on the existing runtime", () => {
    const next = applyPrimaryModel({ agents: { defaults: {} } }, "openai/gpt-5.5");

    expect(next.agents?.defaults?.model).toMatchObject({ primary: "openai/gpt-5.5" });
    expect(next.agents?.defaults?.agentRuntime).toBeUndefined();
  });

  it("pins OpenAI Codex model selections to the Codex runtime", () => {
    const next = applyPrimaryModel({ agents: { defaults: {} } }, "openai-codex/gpt-5.5");

    expect(next.agents?.defaults?.model).toMatchObject({ primary: "openai-codex/gpt-5.5" });
    expect(next.agents?.defaults?.agentRuntime).toEqual({ id: "codex" });
  });

  it("does not pin custom OpenAI-compatible selections to Codex", () => {
    const next = applyPrimaryModel(
      {
        agents: { defaults: {} },
        models: {
          providers: {
            openai: {
              baseUrl: "https://compatible.example.test/v1",
              api: "openai-responses",
              models: [],
            },
          },
        },
      },
      "openai/custom-gpt",
    );

    expect(next.agents?.defaults?.model).toMatchObject({ primary: "openai/custom-gpt" });
    expect(next.agents?.defaults?.agentRuntime).toBeUndefined();
  });
});

describe("cleanup path removals", () => {
  function createRuntimeMock() {
    return {
      log: vi.fn<(message: string) => void>(),
      error: vi.fn<(message: string) => void>(),
    } as unknown as RuntimeEnv & {
      log: ReturnType<typeof vi.fn<(message: string) => void>>;
      error: ReturnType<typeof vi.fn<(message: string) => void>>;
    };
  }

  it("removes state and only linked paths outside state", async () => {
    const runtime = createRuntimeMock();
    const tmpRoot = path.join(path.parse(process.cwd()).root, "tmp", "openclaw-cleanup");
    await removeStateAndLinkedPaths(
      {
        stateDir: path.join(tmpRoot, "state"),
        configPath: path.join(tmpRoot, "state", "openclaw.json"),
        oauthDir: path.join(tmpRoot, "oauth"),
        configInsideState: true,
        oauthInsideState: false,
      },
      runtime,
      { dryRun: true },
    );

    const joinedLogs = runtime.log.mock.calls
      .map(([line]) => line.replaceAll("\\", "/"))
      .join("\n");
    expect(joinedLogs).toContain("/tmp/openclaw-cleanup/state");
    expect(joinedLogs).toContain("/tmp/openclaw-cleanup/oauth");
    expect(joinedLogs).not.toContain("openclaw.json");
  });

  it("removes every workspace directory", async () => {
    const runtime = createRuntimeMock();
    const workspaces = ["/tmp/openclaw-workspace-1", "/tmp/openclaw-workspace-2"];

    await removeWorkspaceDirs(workspaces, runtime, { dryRun: true });

    const logs = runtime.log.mock.calls.map(([line]) => line);
    expect(logs).toContain("[dry-run] remove /tmp/openclaw-workspace-1");
    expect(logs).toContain("[dry-run] remove /tmp/openclaw-workspace-2");
  });
});
