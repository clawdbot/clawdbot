import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginGatewayMethodDescriptor } from "../gateway/methods/descriptor.js";
import { registerPluginDashboardCapabilities } from "../plugins/dashboard-capabilities.js";
import { createPluginRecord } from "../plugins/loader-records.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import * as processExec from "../process/exec.js";
import { createShowWidgetTool } from "./widget-tool.js";

describe("show_widget prompt", () => {
  afterEach(() => {
    resetPluginRuntimeStateForTest();
    vi.restoreAllMocks();
  });

  it("discovers active host capabilities with usable contracts", () => {
    const registry = createEmptyPluginRegistry();
    const handler = () => {};
    registry.gatewayHandlers["fixture.list"] = handler;
    registry.gatewayHandlers["fixture.dispatch"] = handler;
    registry.gatewayMethodDescriptors.push(
      createPluginGatewayMethodDescriptor({
        pluginId: "fixture",
        name: "fixture.list",
        scope: "operator.read",
        handler,
      }),
      createPluginGatewayMethodDescriptor({
        pluginId: "fixture",
        name: "fixture.dispatch",
        scope: "operator.write",
        handler,
      }),
    );
    registerPluginDashboardCapabilities({
      registry,
      record: createPluginRecord({
        id: "fixture",
        source: "fixture",
        origin: "bundled",
        enabled: true,
        configSchema: false,
        dashboard: {
          dataBindings: [
            { id: "large", method: "fixture.list", description: "Too large ".repeat(500) },
            { id: "list", method: "fixture.list", description: "List fixture items" },
          ],
          actionVerbs: [
            {
              id: "dispatch",
              method: "fixture.dispatch",
              description: "Dispatch items",
              paramShape: { type: "object", properties: { force: { type: "boolean" } } },
            },
          ],
        },
      }),
    });
    setActivePluginRegistry(registry);
    const tool = createShowWidgetTool();
    const instructions = JSON.stringify(tool.parameters) + tool.description;
    expect(instructions).toContain("With a usable connected agent GitHub identity");
    expect(instructions).toContain("Identity is checked before save");
    expect(instructions).toContain("github.actions.runs");
    expect(instructions).toContain("github.actions.runs:owner/repo");
    expect(instructions).toContain("fixture.list");
    expect(instructions).toContain("List fixture items");
    expect(instructions).toContain("fixture.dispatch");
    expect(instructions).toContain("force");
    expect(instructions).toContain("1 plugin capabilities omitted");
    const guidance = (
      tool.parameters as {
        properties: { capabilities: { properties: { tools: { description: string } } } };
      }
    ).properties.capabilities.properties.tools.description;
    expect(guidance.length).toBeLessThanOrEqual(1200);
    expect(guidance.indexOf("fixture.dispatch")).toBeLessThan(guidance.indexOf("fixture.list"));
    expect(guidance).not.toContain("Too large");
    setActivePluginRegistry(createEmptyPluginRegistry());
    expect(JSON.stringify(createShowWidgetTool())).not.toContain("fixture.list");
    expect(JSON.stringify(createShowWidgetTool())).not.toContain("fixture.dispatch");
  });
  it("constructs synchronously without probing GitHub identity", () => {
    const http = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Unexpected HTTP probe"));
    const native = vi
      .spyOn(processExec, "runCommandBuffered")
      .mockRejectedValue(new Error("Unexpected native probe"));
    expect(createShowWidgetTool().name).toBe("show_widget");
    expect(http).not.toHaveBeenCalled();
    expect(native).not.toHaveBeenCalled();
  });
  it("keeps proactive single visualizations inline unless dashboard use meets its threshold", () => {
    const tool = createShowWidgetTool();
    const directoryDescription = tool.description.slice(0, 184);
    const properties = (
      tool.parameters as {
        properties?: {
          pin?: { description?: string };
          name?: { description?: string };
          widget_code?: { description?: string };
        };
      }
    ).properties;
    const pinDescription = properties?.pin?.description;

    expect(directoryDescription).toMatch(/^Visual helps\? Make widget\. Do not wait for ask\./);
    expect(directoryDescription).toMatch(
      /(?:single|one[- ]off|ad hoc).{0,40}visualizations?.{0,40}inline/i,
    );
    expect(directoryDescription).toContain("explicit dashboard request");
    expect(directoryDescription).toContain("multiple non-code visualizations");
    expect(directoryDescription).toContain("Update pinned HTML by name");
    expect(pinDescription).toContain("explicit dashboard request");
    expect(pinDescription).toContain("multiple non-code visualizations");
    expect(properties?.name?.description).toMatch(/same name.*pin=true.*widget_code/i);
    expect(properties?.widget_code?.description).toContain("fluid widths");
    expect(properties?.widget_code?.description).toMatch(/wrap or stack.*narrow/i);
  });

  it("offers native reports for a session dashboard with a bounded data contract", () => {
    const tool = createShowWidgetTool({ agentSessionKey: "agent:main:report" });
    const description = tool.description;
    expect(description).toContain("Prefer the report argument with pin=true");
    expect(description).toContain("dashboard-only");
    const schema = JSON.stringify(tool.parameters);
    expect(schema).toContain("Maximum 8KB JSON");
    expect(schema).toContain("Metric values and table cells are strings");
    expect(createShowWidgetTool().description).not.toContain("Prefer the report argument");
  });
});
