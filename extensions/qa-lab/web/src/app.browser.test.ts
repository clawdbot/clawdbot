/* @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import path from "node:path";
import type { QaBusStateSnapshot } from "openclaw/plugin-sdk/qa-channel-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bootstrap, RunnerSelection } from "./ui-types.js";

const httpMock = vi.hoisted(() => {
  class QaLabHttpError extends Error {
    constructor(
      message: string,
      readonly status: number,
      readonly payload: unknown,
    ) {
      super(message);
    }
  }
  return {
    getJson: vi.fn(),
    getJsonNoStore: vi.fn(),
    postJson: vi.fn(),
    QaLabHttpError,
  };
});

vi.mock("./http.js", () => httpMock);

import { createQaLabApp } from "./app.js";

const scenarios: Bootstrap["scenarios"] = [
  {
    id: "dm-chat-baseline",
    title: "DM baseline",
    surface: "dm",
    objective: "test DM",
    successCriteria: ["reply"],
    execution: { kind: "flow" },
  },
  {
    id: "browser-talk-start-stop",
    title: "Browser Talk start-stop",
    surface: "control-ui",
    objective: "test browser Talk",
    successCriteria: ["playwright pass"],
    execution: { kind: "playwright" },
  },
];

function createBootstrap(selection: RunnerSelection): Bootstrap {
  const selectedScenarioIds = selection.scenarioIds ?? scenarios.map((scenario) => scenario.id);
  return {
    baseUrl: "http://127.0.0.1:43124",
    controlUiEmbeddedUrl: null,
    controlUiUrl: null,
    defaults: {
      conversationId: "qa-operator",
      conversationKind: "direct",
      senderId: "qa-operator",
      senderName: "QA Operator",
    },
    kickoffTask: "Run QA",
    latestReport: null,
    runner: {
      artifacts: null,
      error: null,
      plan: {
        errors: [],
        exclusions: [],
        executionKinds: ["flow", "playwright"],
        explicitScenarioSelection: selection.scenarioIds !== null,
        profile: selection.profile,
        selectedScenarios: scenarios
          .filter((scenario) => selectedScenarioIds.includes(scenario.id))
          .map((scenario) => ({
            declaredChannel: null,
            effectiveChannel: scenario.execution?.kind === "flow" ? "qa-channel" : null,
            executionKind: scenario.execution?.kind ?? "flow",
            id: scenario.id,
            title: scenario.title,
          })),
        status: "ready",
      },
      selection,
      status: "idle",
    },
    runnerCatalog: {
      channels: ["buzz", "matrix", "telegram"],
      profiles: [
        { id: "smoke-ci", evidenceMode: "slim", channelDriver: "crabline", categoryIds: [] },
        { id: "all", evidenceMode: "full", channelDriver: "live", categoryIds: [] },
      ],
      status: "ready",
      real: [
        {
          input: "text",
          key: "openai/gpt-5.6-luna",
          name: "GPT-5.6 Luna",
          preferred: true,
          provider: "openai",
        },
      ],
    },
    scenarios,
  };
}

async function mountRunner(
  selection: RunnerSelection,
  snapshot: QaBusStateSnapshot = {
    conversations: [],
    cursor: 0,
    events: [],
    messages: [],
    threads: [],
  },
) {
  let bootstrap = createBootstrap(selection);
  httpMock.getJson.mockImplementation(async (url: string) => {
    if (url === "/api/bootstrap") {
      return bootstrap;
    }
    if (url === "/api/state") {
      return snapshot;
    }
    if (url === "/api/report") {
      return { report: null };
    }
    if (url === "/api/outcomes") {
      return { run: null };
    }
    if (url === "/api/capture/sessions") {
      return { sessions: [] };
    }
    if (url === "/api/capture/startup-status") {
      return {
        status: {
          gateway: { label: "Gateway", ok: true, url: "http://127.0.0.1:18789" },
          proxy: { label: "Proxy", ok: true, url: "http://127.0.0.1:7799" },
          qaLab: { label: "QA Lab", ok: true, url: bootstrap.baseUrl },
        },
      };
    }
    throw new Error(`unexpected GET ${url}`);
  });
  httpMock.getJsonNoStore.mockResolvedValue({ version: "test" });
  httpMock.postJson.mockImplementation(async (url: string, body: unknown) => {
    if (url !== "/api/scenario/suite") {
      throw new Error(`unexpected POST ${url}`);
    }
    const nextSelection = body as RunnerSelection;
    bootstrap = createBootstrap(nextSelection);
    return { runner: { selection: nextSelection } };
  });
  const root = document.createElement("div");
  document.body.append(root);
  await createQaLabApp(root);
  return root;
}

function selectValue(root: HTMLElement, selector: string, value: string) {
  const select = root.querySelector<HTMLSelectElement>(selector);
  if (!select) {
    throw new Error(`missing select ${selector}`);
  }
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

beforeEach(() => {
  vi.useFakeTimers();
  const styles = document.createElement("style");
  styles.dataset.qaLabTestStyles = "true";
  styles.textContent = readFileSync(
    path.join(process.cwd(), "extensions/qa-lab/web/src/styles.css"),
    "utf8",
  );
  document.head.append(styles);
  httpMock.getJson.mockReset();
  httpMock.getJsonNoStore.mockReset();
  httpMock.postJson.mockReset();
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    clear: () => storage.clear(),
    getItem: (key: string) => storage.get(key) ?? null,
    key: (index: number) => [...storage.keys()][index] ?? null,
    get length() {
      return storage.size;
    },
    removeItem: (key: string) => storage.delete(key),
    setItem: (key: string, value: string) => storage.set(key, value),
  });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  document.querySelector("style[data-qa-lab-test-styles]")?.remove();
});

describe("QA Lab runner browser interactions", () => {
  it("sends group conversation messages from the interactive chat composer", async () => {
    const root = await mountRunner(
      {
        alternateModel: "mock-openai/gpt-5.6-luna-alt",
        channel: null,
        channelDriver: "qa-channel",
        evidenceMode: "full",
        fastMode: false,
        primaryModel: "mock-openai/gpt-5.6-luna",
        profile: "all",
        providerMode: "mock-openai",
        runtimePair: null,
        runtimePairLane: null,
        scenarioIds: ["dm-chat-baseline"],
      },
      {
        conversations: [{ accountId: "default", id: "qa-room", kind: "channel" }],
        cursor: 0,
        events: [],
        messages: [],
        threads: [
          {
            accountId: "default",
            conversationId: "qa-room",
            createdAt: 0,
            createdBy: "qa-operator",
            id: "owned-thread",
            title: "Owned thread",
          },
        ],
      },
    );
    httpMock.postJson.mockResolvedValue({ message: { id: "group-message" } });

    root.querySelector<HTMLButtonElement>("[data-thread-select='owned-thread']")?.click();
    selectValue(root, "#conversation-kind", "group");
    const conversationInput = root.querySelector<HTMLInputElement>("#conversation-id");
    if (!conversationInput) {
      throw new Error("missing group conversation input");
    }
    conversationInput.value = "qa-group";
    conversationInput.dispatchEvent(new Event("input", { bubbles: true }));
    const composer = root.querySelector<HTMLTextAreaElement>("#composer-text");
    if (!composer) {
      throw new Error("missing group message composer");
    }
    composer.value = "hello group";
    composer.dispatchEvent(new Event("input", { bubbles: true }));
    root.querySelector<HTMLButtonElement>("[data-action='send']")?.click();

    await vi.waitFor(() => expect(httpMock.postJson).toHaveBeenCalledTimes(1));
    expect(httpMock.postJson).toHaveBeenCalledWith(
      "/api/inbound/message",
      expect.objectContaining({
        accountId: "default",
        conversation: { id: "qa-group", kind: "group", title: "qa-group" },
        text: "hello group",
      }),
    );
    const submittedPayload = httpMock.postJson.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(submittedPayload).not.toHaveProperty("threadId");
  });

  it("keeps scenario rows from collapsing inside the scrolling list", async () => {
    const root = await mountRunner({
      alternateModel: "mock-openai/gpt-5.6-luna-alt",
      channel: null,
      channelDriver: "qa-channel",
      evidenceMode: "full",
      fastMode: false,
      primaryModel: "mock-openai/gpt-5.6-luna",
      profile: "all",
      providerMode: "mock-openai",
      runtimePair: null,
      runtimePairLane: null,
      scenarioIds: ["dm-chat-baseline"],
    });

    const scroll = root.querySelector<HTMLElement>(".scenario-scroll");
    const row = root.querySelector<HTMLElement>(".scenario-item");
    expect(scroll).not.toBeNull();
    expect(row).not.toBeNull();
    expect(getComputedStyle(scroll!).overflowY).toBe("auto");
    expect(getComputedStyle(row!).flexShrink).toBe("0");
  });

  it("submits live-provider and Crabline selections with non-flow scenarios", async () => {
    const root = await mountRunner({
      alternateModel: "openai/gpt-5.6-luna",
      channel: null,
      channelDriver: "crabline",
      evidenceMode: "full",
      fastMode: true,
      primaryModel: "openai/gpt-5.6-luna",
      profile: "all",
      providerMode: "live-frontier",
      runtimePair: null,
      runtimePairLane: null,
      scenarioIds: ["dm-chat-baseline"],
    });

    root.querySelector<HTMLButtonElement>("[data-action='select-all-scenarios']")?.click();
    root.querySelector<HTMLButtonElement>("[data-action='run-suite']")?.click();

    await vi.waitFor(() => expect(httpMock.postJson).toHaveBeenCalledTimes(1));
    expect(httpMock.postJson).toHaveBeenCalledWith(
      "/api/scenario/suite",
      expect.objectContaining({
        channelDriver: "crabline",
        providerMode: "live-frontier",
        scenarioIds: ["dm-chat-baseline", "browser-talk-start-stop"],
      }),
    );
  });

  it("changes to real channels without changing the mock provider lane", async () => {
    const root = await mountRunner({
      alternateModel: "mock-openai/gpt-5.6-luna-alt",
      channel: null,
      channelDriver: "qa-channel",
      evidenceMode: "full",
      fastMode: false,
      primaryModel: "mock-openai/gpt-5.6-luna",
      profile: "all",
      providerMode: "mock-openai",
      runtimePair: null,
      runtimePairLane: null,
      scenarioIds: ["dm-chat-baseline"],
    });

    root.querySelector<HTMLButtonElement>("[data-sidebar-panel='config']")?.click();
    expect(
      Array.from(
        root.querySelectorAll<HTMLSelectElement>("#execution-channel option"),
        (option) => option.value,
      ),
    ).toEqual(["", "buzz", "matrix", "telegram"]);
    selectValue(root, "#channel-driver", "live");
    selectValue(root, "#execution-channel", "telegram");
    root.querySelector<HTMLButtonElement>("[data-action='run-suite']")?.click();

    await vi.waitFor(() => expect(httpMock.postJson).toHaveBeenCalledTimes(1));
    expect(httpMock.postJson).toHaveBeenCalledWith(
      "/api/scenario/suite",
      expect.objectContaining({
        channelDriver: "live",
        channel: "telegram",
        providerMode: "mock-openai",
      }),
    );
  });

  it("submits profile, evidence, runtime-pair, lane, and channel controls", async () => {
    const root = await mountRunner({
      alternateModel: "mock-openai/gpt-5.6-luna-alt",
      channel: null,
      channelDriver: "live",
      evidenceMode: "full",
      fastMode: false,
      primaryModel: "mock-openai/gpt-5.6-luna",
      profile: "all",
      providerMode: "mock-openai",
      runtimePair: null,
      runtimePairLane: null,
      scenarioIds: ["dm-chat-baseline"],
    });

    root.querySelector<HTMLButtonElement>("[data-sidebar-panel='config']")?.click();
    selectValue(root, "#run-profile", "smoke-ci");
    selectValue(root, "#execution-channel", "telegram");
    selectValue(root, "#evidence-mode", "slim");
    selectValue(root, "#runtime-pair", "openclaw,codex");
    selectValue(root, "#runtime-pair-lane", "core");
    root.querySelector<HTMLButtonElement>("[data-action='run-suite']")?.click();

    await vi.waitFor(() => expect(httpMock.postJson).toHaveBeenCalledTimes(1));
    expect(httpMock.postJson).toHaveBeenCalledWith(
      "/api/scenario/suite",
      expect.objectContaining({
        profile: "smoke-ci",
        channel: "telegram",
        channelDriver: "crabline",
        evidenceMode: "slim",
        runtimePair: ["openclaw", "codex"],
        runtimePairLane: "core",
        scenarioIds: null,
      }),
    );
  });

  it("renders server-resolved exclusions and errors from a rejected launch", async () => {
    const root = await mountRunner({
      alternateModel: "mock-openai/gpt-5.6-luna-alt",
      channel: null,
      channelDriver: "qa-channel",
      evidenceMode: "full",
      fastMode: false,
      primaryModel: "mock-openai/gpt-5.6-luna",
      profile: "all",
      providerMode: "mock-openai",
      runtimePair: null,
      runtimePairLane: null,
      scenarioIds: ["dm-chat-baseline"],
    });
    httpMock.postJson.mockRejectedValueOnce(
      new httpMock.QaLabHttpError("selection rejected", 400, {
        plan: {
          errors: ["Explicit QA scenario selection is not runnable."],
          exclusions: [
            {
              executionKind: "flow",
              reasons: ["channel=telegram"],
              scenarioId: "dm-chat-baseline",
            },
          ],
          executionKinds: [],
          explicitScenarioSelection: true,
          profile: "all",
          selectedScenarios: [],
          status: "invalid",
        },
      }),
    );

    root.querySelector<HTMLButtonElement>("[data-action='run-suite']")?.click();

    await vi.waitFor(() => expect(root.textContent).toContain("1 excluded"));
    expect(root.textContent).toContain("Explicit QA scenario selection is not runnable");

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(root.textContent).toContain("1 excluded"));
    expect(root.textContent).toContain("Explicit QA scenario selection is not runnable");

    root.querySelector<HTMLButtonElement>("[data-sidebar-panel='config']")?.click();
    selectValue(root, "#evidence-mode", "slim");
    root.querySelector<HTMLButtonElement>("[data-sidebar-panel='run']")?.click();
    expect(root.textContent).not.toContain("Explicit QA scenario selection is not runnable");
    expect(root.textContent).not.toContain("Resolved plan:");
  });

  it("starts a dirty profile override without reusing the previous resolved plan", async () => {
    const root = await mountRunner({
      alternateModel: "mock-openai/gpt-5.6-luna-alt",
      channel: null,
      channelDriver: "qa-channel",
      evidenceMode: "full",
      fastMode: false,
      primaryModel: "mock-openai/gpt-5.6-luna",
      profile: "all",
      providerMode: "mock-openai",
      runtimePair: null,
      runtimePairLane: null,
      scenarioIds: ["dm-chat-baseline"],
    });

    root.querySelector<HTMLButtonElement>("[data-sidebar-panel='config']")?.click();
    selectValue(root, "#run-profile", "smoke-ci");
    root.querySelector<HTMLButtonElement>("[data-sidebar-panel='scenarios']")?.click();
    root
      .querySelector<HTMLInputElement>("[data-scenario-toggle-id='browser-talk-start-stop']")
      ?.click();
    root.querySelector<HTMLButtonElement>("[data-action='run-suite']")?.click();

    await vi.waitFor(() => expect(httpMock.postJson).toHaveBeenCalledTimes(1));
    expect(httpMock.postJson).toHaveBeenCalledWith(
      "/api/scenario/suite",
      expect.objectContaining({
        profile: "smoke-ci",
        scenarioIds: ["browser-talk-start-stop"],
      }),
    );
  });

  it("disables launch when an explicit override becomes empty", async () => {
    const root = await mountRunner({
      alternateModel: "mock-openai/gpt-5.6-luna-alt",
      channel: null,
      channelDriver: "qa-channel",
      evidenceMode: "full",
      fastMode: false,
      primaryModel: "mock-openai/gpt-5.6-luna",
      profile: "all",
      providerMode: "mock-openai",
      runtimePair: null,
      runtimePairLane: null,
      scenarioIds: ["dm-chat-baseline"],
    });

    root.querySelector<HTMLInputElement>("[data-scenario-toggle-id='dm-chat-baseline']")?.click();
    const runButton = root.querySelector<HTMLButtonElement>("[data-action='run-suite']");
    expect(runButton?.disabled).toBe(true);
    expect(runButton?.textContent).toContain("Run 0 scenarios");
    runButton?.click();
    expect(httpMock.postJson).not.toHaveBeenCalled();
  });
});
