import { describe, expect, it } from "vitest";
import { createShowWidgetTool } from "./widget-tool.js";

describe("show_widget prompt", () => {
  it("routes explicit dashboard requests to the native Split surface", () => {
    const tool = createShowWidgetTool();
    const directoryDescription = tool.description.slice(0, 240);
    const properties = (
      tool.parameters as {
        properties?: {
          pin?: { description?: string };
          name?: { description?: string };
        };
      }
    ).properties;
    const pinDescription = properties?.pin?.description;

    expect(directoryDescription).toMatch(/^Visual helps\? Make widget\. Do not wait for ask\./);
    expect(directoryDescription).toMatch(
      /(?:single|one[- ]off|ad hoc).{0,40}visualizations?.{0,40}inline/i,
    );
    expect(directoryDescription).toContain("Explicit dashboard request");
    expect(directoryDescription).toMatch(/pin=true.*stable name/i);
    expect(directoryDescription).toMatch(/focus.*tab.*native Split view/i);
    expect(directoryDescription).toContain("multiple non-code visualizations");
    expect(directoryDescription).toContain("Update HTML by name");
    expect(tool.description).toMatch(/preserve.*visible chat dock/i);
    expect(tool.description).toMatch(/do not replace.*standalone server preview/i);
    expect(pinDescription).toContain("explicit dashboard request");
    expect(pinDescription).toContain("multiple non-code visualizations");
    expect(properties?.name?.description).toMatch(/same name.*pin=true.*widget_code/i);
  });
});
