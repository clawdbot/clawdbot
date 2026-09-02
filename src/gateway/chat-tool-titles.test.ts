// Gateway tests cover cheap-model tool-call title generation and its SQLite cache.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runIsolatedCompletion = vi.hoisted(() => vi.fn());
const prepareUtilityCompletionForAgent = vi.hoisted(() => vi.fn());
const resolveUtilityModelRefForAgent = vi.hoisted(() => vi.fn());

vi.mock("../agents/isolated-completion.js", () => ({ runIsolatedCompletion }));
vi.mock("../agents/utility-completion.js", () => ({ prepareUtilityCompletionForAgent }));

vi.mock("../agents/utility-model.js", () => ({
  resolveUtilityModelRefForAgent,
}));

import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawAgentDatabases } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { generateToolCallTitles } from "./chat-tool-titles.js";

const AGENT_ID = "main";

function mockPreparedModel(): void {
  prepareUtilityCompletionForAgent.mockResolvedValue({
    config: {},
    provider: "openai",
    model: "gpt-test",
    outputTextPolicy: "strict-visible",
    agentId: AGENT_ID,
    agentDir: "/tmp/openclaw-agent",
  });
}

function mockCompletionTitles(titles: Record<string, string>): void {
  runIsolatedCompletion.mockResolvedValue({
    text: JSON.stringify({ titles }),
    provider: "openai",
    model: "gpt-test",
    owner: { kind: "harness", id: "openclaw" },
  });
}

describe("generateToolCallTitles", () => {
  let stateDir: string;
  let previousStateDir: string | undefined;

  beforeEach(() => {
    runIsolatedCompletion.mockReset();
    prepareUtilityCompletionForAgent.mockReset();
    resolveUtilityModelRefForAgent.mockReset();
    // Default: canonical utility routing resolves a cheap same-provider model.
    resolveUtilityModelRefForAgent.mockReturnValue("openai/gpt-test");
    // realpath: macOS tmpdir is a /var -> /private/var symlink and DB paths resolve canonically.
    stateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-tool-titles-")));
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;
  });

  afterEach(() => {
    closeOpenClawAgentDatabases();
    closeOpenClawStateDatabaseForTest();
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("generates titles keyed by item id", async () => {
    mockPreparedModel();
    mockCompletionTitles({ "0": "Checked repo status", "1": "Listed source files" });

    const result = await generateToolCallTitles({
      cfg: {} satisfies OpenClawConfig,
      agentId: AGENT_ID,
      items: [
        { id: "item-1", name: "bash", input: "git status --short" },
        { id: "item-2", name: "bash", input: "ls -la src" },
      ],
    });

    expect(result).toEqual({
      "item-1": "Checked repo status",
      "item-2": "Listed source files",
    });
    expect(runIsolatedCompletion).toHaveBeenCalledTimes(1);
  });

  it("redacts secret-bearing inputs before they reach the utility model", async () => {
    mockPreparedModel();
    mockCompletionTitles({ "0": "Pushed with credentials" });
    // Assembled so repo secret scanners do not flag a literal token fixture.
    const token = ["ghp", "a1b2c3d4e5f6a1b2c3d4e5f6"].join("_");

    await generateToolCallTitles({
      cfg: {} satisfies OpenClawConfig,
      agentId: AGENT_ID,
      items: [
        {
          id: "item-1",
          name: "bash",
          input: `curl -H "Authorization: Bearer ${token}" https://api.example.com`,
        },
      ],
    });

    const call = runIsolatedCompletion.mock.calls[0]?.[0] as {
      prompt: string;
    };
    expect(call.prompt).not.toContain(token);
  });

  it("redacts secrets that straddle the prompt truncation boundary", async () => {
    mockPreparedModel();
    mockCompletionTitles({ "0": "Pushed with credentials" });
    const token = ["ghp", "a1b2c3d4e5f6a1b2c3d4e5f6"].join("_");
    // Place the secret so a slice-before-redact would cut it mid-token and
    // leave an unmatchable fragment in the prompt.
    const padding = "x".repeat(1_990);
    const input = `${padding} Authorization: Bearer ${token}`;

    await generateToolCallTitles({
      cfg: {} satisfies OpenClawConfig,
      agentId: AGENT_ID,
      items: [{ id: "item-1", name: "bash", input }],
    });

    const call = runIsolatedCompletion.mock.calls[0]?.[0] as {
      prompt: string;
    };
    const content = call.prompt ?? "";
    expect(content).not.toContain(token);
    expect(content).not.toContain(token.slice(0, 12));
  });

  it("keeps bounded tool input valid before utility-model prompt construction", async () => {
    mockPreparedModel();
    mockCompletionTitles({ "0": "Inspected boundary input" });

    await generateToolCallTitles({
      cfg: {} satisfies OpenClawConfig,
      agentId: AGENT_ID,
      items: [{ id: "item-1", name: "bash", input: `${"a".repeat(1_999)}😀tail` }],
    });

    const call = runIsolatedCompletion.mock.calls[0]?.[0] as {
      prompt: string;
    };
    const promptPayload = JSON.parse(call.prompt ?? "{}") as {
      items?: Array<{ input?: string }>;
    };
    expect(promptPayload.items?.[0]?.input).toBe("a".repeat(1_999));
  });

  it("serves repeated items from the SQLite cache without a second completion", async () => {
    mockPreparedModel();
    mockCompletionTitles({ "0": "Checked repo status" });
    const params = {
      cfg: {} satisfies OpenClawConfig,
      agentId: AGENT_ID,
      items: [{ id: "item-1", name: "bash", input: "git status --short" }],
    };

    const first = await generateToolCallTitles(params);
    const second = await generateToolCallTitles(params);

    expect(first).toEqual({ "item-1": "Checked repo status" });
    expect(second).toEqual(first);
    expect(runIsolatedCompletion).toHaveBeenCalledTimes(1);
  });

  it("fails closed to an empty result when model preparation errors", async () => {
    prepareUtilityCompletionForAgent.mockRejectedValue(new Error("No utility model configured."));

    await expect(
      generateToolCallTitles({
        cfg: {} satisfies OpenClawConfig,
        agentId: AGENT_ID,
        items: [{ id: "item-1", name: "bash", input: "git status --short" }],
      }),
    ).resolves.toEqual({});
    expect(runIsolatedCompletion).not.toHaveBeenCalled();
  });

  it("prepares the canonical utility model ref", async () => {
    mockPreparedModel();
    mockCompletionTitles({ "0": "Checked repo status" });
    const cfg = {} satisfies OpenClawConfig;

    await generateToolCallTitles({
      cfg,
      agentId: AGENT_ID,
      items: [{ id: "item-1", name: "bash", input: "git status --short" }],
    });

    expect(resolveUtilityModelRefForAgent).toHaveBeenCalledWith({
      cfg,
      agentId: AGENT_ID,
      primaryProvider: undefined,
    });
    expect(prepareUtilityCompletionForAgent).toHaveBeenCalledWith({
      cfg,
      agentId: AGENT_ID,
      modelRef: "openai/gpt-test",
      preferredProfile: undefined,
    });
  });

  it("keeps the session auth profile on the utility completion", async () => {
    mockPreparedModel();
    mockCompletionTitles({ "0": "Checked repo status" });
    // The resolver may append the agent primary's profile; the session's
    // profile must replace it so preparation cannot pick the wrong credential.
    resolveUtilityModelRefForAgent.mockReturnValue("openai/gpt-test@default");
    const cfg = {} satisfies OpenClawConfig;

    await generateToolCallTitles({
      cfg,
      agentId: AGENT_ID,
      sessionAuthProfile: "work",
      items: [{ id: "item-1", name: "bash", input: "git status --short" }],
    });

    expect(prepareUtilityCompletionForAgent).toHaveBeenCalledWith(
      expect.objectContaining({ modelRef: "openai/gpt-test@work", preferredProfile: "work" }),
    );
  });

  it("derives utility routing from the session's effective provider", async () => {
    mockPreparedModel();
    mockCompletionTitles({ "0": "Checked repo status" });
    const cfg = {} satisfies OpenClawConfig;

    await generateToolCallTitles({
      cfg,
      agentId: AGENT_ID,
      sessionPrimaryProvider: "anthropic",
      items: [{ id: "item-1", name: "bash", input: "git status --short" }],
    });

    // Per-session model overrides must reach the small-model derivation so
    // titles stay on the provider the session actually talks to.
    expect(resolveUtilityModelRefForAgent).toHaveBeenCalledWith({
      cfg,
      agentId: AGENT_ID,
      primaryProvider: "anthropic",
    });
  });

  it("does not serve cached titles after utility routing is disabled", async () => {
    mockPreparedModel();
    mockCompletionTitles({ "0": "Checked repo status" });
    const params = {
      cfg: {} satisfies OpenClawConfig,
      agentId: AGENT_ID,
      items: [{ id: "item-1", name: "bash", input: "git status --short" }],
    };

    await expect(generateToolCallTitles(params)).resolves.toEqual({
      "item-1": "Checked repo status",
    });
    // Operator later sets utilityModel: "" — cached titles must not outlive
    // the opt-out while the controlUi toggle stays on.
    resolveUtilityModelRefForAgent.mockReturnValue(undefined);
    await expect(generateToolCallTitles(params)).resolves.toEqual({});
  });

  it("fails closed on malformed utility model refs instead of using the primary", async () => {
    // "openai/" cannot parse; preparation would silently fall back to the
    // agent primary, violating the no-primary contract for titles.
    resolveUtilityModelRefForAgent.mockReturnValue("openai/");

    await expect(
      generateToolCallTitles({
        cfg: {} satisfies OpenClawConfig,
        agentId: AGENT_ID,
        items: [{ id: "item-1", name: "bash", input: "git status --short" }],
      }),
    ).resolves.toEqual({});
    expect(prepareUtilityCompletionForAgent).not.toHaveBeenCalled();
    expect(runIsolatedCompletion).not.toHaveBeenCalled();
  });

  it("skips generation when utility routing is disabled or has no default", async () => {
    // Covers both the explicit utilityModel: "" opt-out and providers without
    // a declared small-model default; the resolver returns undefined for both.
    resolveUtilityModelRefForAgent.mockReturnValue(undefined);

    await expect(
      generateToolCallTitles({
        cfg: {} satisfies OpenClawConfig,
        agentId: AGENT_ID,
        items: [{ id: "item-1", name: "bash", input: "git status --short" }],
      }),
    ).resolves.toEqual({});
    expect(prepareUtilityCompletionForAgent).not.toHaveBeenCalled();
    expect(runIsolatedCompletion).not.toHaveBeenCalled();
  });
});
