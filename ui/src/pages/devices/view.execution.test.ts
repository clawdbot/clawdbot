/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  renderDevicesContainer,
  getDevicesSection as getSection,
  getDeviceSettingsRow as getSettingsRow,
} from "../../test-helpers/devices-view.ts";

afterEach(() => document.body.replaceChildren());

describe("devices exec approvals rendering", () => {
  it("renders owner-reported defaults for fresh approval state", () => {
    const container = renderDevicesContainer({
      execApprovalsSnapshot: {
        path: "/tmp/exec-approvals.json",
        exists: false,
        hash: "missing:empty",
        file: { version: 1, agents: {} },
        resolvedDefaults: {
          security: "full",
          ask: "off",
          askFallback: "deny",
          autoAllowSkills: false,
        },
      },
    });
    const section = getSection(container, "Exec approvals");

    expect(
      getSettingsRow(section, "Security").querySelector<HTMLSelectElement>("select")?.value,
    ).toBe("full");
    expect(getSettingsRow(section, "Ask").querySelector<HTMLSelectElement>("select")?.value).toBe(
      "off",
    );
  });

  it("preserves authored wildcard and agent overrides above owner defaults", () => {
    const container = renderDevicesContainer({
      execApprovalsSnapshot: {
        path: "/tmp/exec-approvals.json",
        exists: false,
        hash: "missing:empty",
        file: {
          version: 1,
          agents: {
            "*": { security: "allowlist", ask: "always" },
            main: { ask: "on-miss" },
          },
        },
        resolvedDefaults: {
          security: "full",
          ask: "off",
          askFallback: "deny",
          autoAllowSkills: false,
        },
      },
      execApprovalsSelectedAgent: "main",
    });
    const section = getSection(container, "Exec approvals");
    const security = getSettingsRow(section, "Security").querySelector<HTMLSelectElement>("select");
    const ask = getSettingsRow(section, "Ask").querySelector<HTMLSelectElement>("select");
    const fallback = getSettingsRow(section, "Ask fallback").querySelector<HTMLSelectElement>(
      "select",
    );

    expect(security?.selectedOptions[0]?.textContent?.trim()).toBe("Use default (allowlist)");
    expect(ask?.value).toBe("on-miss");
    expect(fallback?.selectedOptions[0]?.textContent?.trim()).toBe("Use default (deny)");
  });

  it("offers only nodes that support both reading and writing approval policy", () => {
    const container = renderDevicesContainer({
      nodes: [
        {
          nodeId: "get-only",
          displayName: "Get only",
          commands: ["system.execApprovals.get"],
        },
        {
          nodeId: "set-only",
          displayName: "Set only",
          commands: ["system.execApprovals.set"],
        },
        {
          nodeId: "editable",
          displayName: "Editable",
          commands: ["system.execApprovals.get", "system.execApprovals.set"],
        },
      ],
      execApprovalsTarget: "node",
    });
    const section = getSection(container, "Exec approvals");
    const nodeSelect = section.querySelector<HTMLSelectElement>('select[aria-label="Node"]');

    expect(Array.from(nodeSelect?.options ?? [], (option) => option.value)).toEqual([
      "",
      "editable",
    ]);
  });

  it("renders defaults, configured agents, and approval-only agents in the avatar picker", async () => {
    const onExecApprovalsSelectAgent = vi.fn();
    const container = renderDevicesContainer({
      configForm: {
        agents: {
          entries: {
            main: { name: "Main", default: true },
            research: { name: "Research" },
          },
        },
      },
      execApprovalsForm: {
        version: 1,
        defaults: { security: "deny" },
        agents: { retired: { security: "full" } },
      },
      execApprovalsSelectedAgent: "research",
      onExecApprovalsSelectAgent,
    });
    const section = getSection(container, "Exec approvals");
    const picker = section.querySelector<
      HTMLElement & {
        options: Array<{ value: string; badge?: string }>;
        onSelect: (value: string) => void;
        updateComplete: Promise<boolean>;
      }
    >("openclaw-agent-select");
    await picker?.updateComplete;

    expect(picker?.options.map((option) => option.value)).toEqual([
      "__defaults__",
      "main",
      "research",
      "retired",
    ]);
    expect(picker?.options.find((option) => option.value === "main")?.badge).toBe("Default");
    picker?.onSelect("retired");
    expect(onExecApprovalsSelectAgent).toHaveBeenCalledWith("retired");
  });

  it("renders host-native Windows policies as read-only", () => {
    const container = renderDevicesContainer({
      nodes: [
        {
          id: "windows-node",
          label: "Windows node",
          commands: ["system.execApprovals.get", "system.execApprovals.set"],
        },
      ],
      execApprovalsTarget: "node",
      execApprovalsTargetNodeId: "windows-node",
      execApprovalsSnapshot: {
        enabled: true,
        hash: "sha256:current",
        defaultAction: "deny",
        rules: [{ pattern: "hostname", action: "allow" }],
      },
    });
    const section = getSection(container, "Exec approvals");

    expect(section.textContent).toContain("Host-native policy");
    expect(section.textContent).toContain("Read-only here");
    expect(section.textContent).toContain("hostname");
    expect(section.textContent).toContain("deny");
    expect(section.querySelector("button")?.hasAttribute("disabled")).toBe(true);
  });
});

describe("devices agent bindings", () => {
  it("reports node bindings and translates each unbound sentinel", () => {
    const onBindDefault = vi.fn();
    const onBindAgent = vi.fn();
    const container = renderDevicesContainer({
      nodes: [
        {
          nodeId: "worker-node",
          displayName: "Worker node",
          commands: ["system.run"],
        },
      ],
      configForm: {
        agents: {
          entries: {
            MAIN: { default: true },
            research: {},
          },
        },
      },
      onBindDefault,
      onBindAgent,
    });
    const bindingSection = getSection(container, "Exec node binding");
    const selects = bindingSection.querySelectorAll<HTMLSelectElement>("select.settings-select");

    const [defaultBinding, mainBinding] = selects;
    defaultBinding!.value = "worker-node";
    defaultBinding!.dispatchEvent(new Event("change"));
    defaultBinding!.value = "";
    defaultBinding!.dispatchEvent(new Event("change"));
    mainBinding!.value = "worker-node";
    mainBinding!.dispatchEvent(new Event("change"));
    mainBinding!.value = "__default__";
    mainBinding!.dispatchEvent(new Event("change"));

    expect(onBindDefault.mock.calls).toEqual([["worker-node"], [null]]);
    expect(onBindAgent.mock.calls).toEqual([
      ["MAIN", "worker-node"],
      ["MAIN", null],
    ]);
  });
});
