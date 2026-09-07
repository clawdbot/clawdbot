import { describe, expect, it } from "vitest";
import {
  buildSlackDataVisualizationBlock,
  canRenderSlackDataVisualization,
  renderSlackDataVisualizationFallbackText,
} from "./data-visualization.js";

describe("Slack data visualization blocks", () => {
  it("maps portable series charts to Slack's exact native shape", () => {
    expect(
      buildSlackDataVisualizationBlock({
        type: "chart",
        chartType: "line",
        title: "Quarterly revenue",
        categories: ["Q1", "Q2"],
        series: [
          { name: "Product", values: [120, 145] },
          { name: "Services", values: [80, 95] },
        ],
        xLabel: "Quarter",
        yLabel: "Revenue",
      }),
    ).toEqual({
      type: "data_visualization",
      title: "Quarterly revenue",
      chart: {
        type: "line",
        series: [
          {
            name: "Product",
            data: [
              { label: "Q1", value: 120 },
              { label: "Q2", value: 145 },
            ],
          },
          {
            name: "Services",
            data: [
              { label: "Q1", value: 80 },
              { label: "Q2", value: 95 },
            ],
          },
        ],
        axis_config: {
          categories: ["Q1", "Q2"],
          x_label: "Quarter",
          y_label: "Revenue",
        },
      },
    });
  });

  it("maps portable pie charts without inventing image or color fields", () => {
    expect(
      buildSlackDataVisualizationBlock({
        type: "chart",
        chartType: "pie",
        title: "Requests by region",
        segments: [
          { label: "Americas", value: 52 },
          { label: "Europe", value: 31 },
        ],
      }),
    ).toEqual({
      type: "data_visualization",
      title: "Requests by region",
      chart: {
        type: "pie",
        segments: [
          { label: "Americas", value: 52 },
          { label: "Europe", value: 31 },
        ],
      },
    });
  });

  it("rejects values that Slack would reject instead of clipping or changing data", () => {
    expect(
      canRenderSlackDataVisualization({
        type: "chart",
        chartType: "pie",
        title: "Invalid",
        segments: [{ label: "Zero", value: 0 }],
      }),
    ).toBe(false);
    expect(
      canRenderSlackDataVisualization({
        type: "chart",
        chartType: "bar",
        title: "Invalid",
        categories: ["Q1", "Q2"],
        series: [{ name: "Revenue", values: [1] }],
      }),
    ).toBe(false);
    expect(
      canRenderSlackDataVisualization({
        type: "chart",
        chartType: "area",
        title: "Invalid",
        categories: ["Q1"],
        series: Array.from({ length: 13 }, (_, index) => ({
          name: `Series ${String(index)}`,
          values: [index],
        })),
      }),
    ).toBe(false);
  });

  it("extracts full chart data from inbound or provider-native Slack blocks", () => {
    expect(
      renderSlackDataVisualizationFallbackText({
        type: "data_visualization",
        title: "Quarterly revenue",
        chart: {
          type: "bar",
          series: [
            {
              name: "Revenue",
              data: [
                { label: "Q1", value: 120 },
                { label: "Q2", value: 145 },
              ],
            },
          ],
          axis_config: { categories: ["Q1", "Q2"] },
        },
      }),
    ).toBe("Quarterly revenue (bar chart)\n- Revenue: Q1: 120; Q2: 145");
  });

  it("orders inbound data by axis categories instead of array position", () => {
    expect(
      renderSlackDataVisualizationFallbackText({
        type: "data_visualization",
        title: "Quarterly revenue",
        chart: {
          type: "line",
          series: [
            {
              name: "Revenue",
              data: [
                { label: "Q2", value: 145 },
                { label: "Q1", value: 120 },
              ],
            },
          ],
          axis_config: { categories: ["Q1", "Q2"] },
        },
      }),
    ).toBe("Quarterly revenue (line chart)\n- Revenue: Q1: 120; Q2: 145");
  });
});
