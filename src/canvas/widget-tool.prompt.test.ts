import { describe, expect, it } from "vitest";
import { createShowWidgetTool } from "./widget-tool.js";

describe("show_widget prompt", () => {
  it("keeps proactive single visualizations inline unless dashboard use meets its threshold", () => {
    const tool = createShowWidgetTool();
    const directoryDescription = tool.description.slice(0, 177);
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
    expect(directoryDescription).toContain("Update HTML by name");
    expect(pinDescription).toContain("explicit dashboard request");
    expect(pinDescription).toContain("multiple non-code visualizations");
    expect(properties?.name?.description).toMatch(/same name.*pin=true.*widget_code/i);
    expect(properties?.widget_code?.description).toMatch(/fit.*iframe width/i);
    expect(properties?.widget_code?.description).toMatch(/avoid fixed.*width/i);
    expect(properties?.widget_code?.description).toMatch(/wrap or stack.*narrow/i);
  });
});
