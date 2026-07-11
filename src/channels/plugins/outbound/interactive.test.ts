// Interactive outbound tests cover channel outbound interactive payload construction.
import { describe, expect, it } from "vitest";
import { renderMessagePresentationChartFallbackText } from "../../../interactive/payload.js";
import {
  adaptMessagePresentationForChannel,
  applyPresentationActionLimits,
  presentationPageSize,
  reduceInteractiveReply,
} from "./interactive.js";

describe("reduceInteractiveReply", () => {
  it("walks authored blocks in order", () => {
    const order = reduceInteractiveReply(
      {
        blocks: [
          { type: "text", text: "first" },
          { type: "buttons", buttons: [{ label: "Retry", value: "retry" }] },
          { type: "select", options: [{ label: "Alpha", value: "alpha" }] },
        ],
      },
      [] as string[],
      (state, block) => {
        state.push(block.type);
        return state;
      },
    );

    expect(order).toEqual(["text", "buttons", "select"]);
  });

  it("returns the initial state when interactive payload is missing", () => {
    expect(reduceInteractiveReply(undefined, 3, (value) => value + 1)).toBe(3);
  });
});

describe("presentation capability limits", () => {
  it("keeps highest-priority buttons inside action capacity", () => {
    const buttons = applyPresentationActionLimits(
      [
        { label: "Low", value: "low", priority: -1 },
        { label: "Default", value: "default" },
        { label: "High", value: "high", priority: 10 },
        { label: "Next", value: "next", priority: 5 },
      ],
      {
        limits: {
          actions: {
            maxActions: 2,
            maxLabelLength: 4,
            supportsStyles: false,
          },
        },
      },
    );

    expect(buttons).toEqual([
      { label: "High", value: "high", priority: 10 },
      { label: "Next", value: "next", priority: 5 },
    ]);
  });

  it("keeps authored button order when nothing is dropped", () => {
    const buttons = applyPresentationActionLimits(
      [
        { label: "First", value: "first", priority: 1 },
        { label: "Second", value: "second", priority: 100 },
        { label: "Third", value: "third" },
      ],
      {
        limits: {
          actions: {
            maxActionsPerRow: 5,
          },
        },
      },
    );

    expect(buttons).toEqual([
      { label: "First", value: "first", priority: 1 },
      { label: "Second", value: "second", priority: 100 },
      { label: "Third", value: "third" },
    ]);
  });

  it("applies callback byte limits to typed command actions", () => {
    const buttons = applyPresentationActionLimits(
      [
        {
          label: "Keep",
          action: { type: "command", command: "/codex plugins menu" },
        },
        {
          label: "Drop",
          action: { type: "command", command: `/codex plugins enable ${"x".repeat(20)}` },
        },
      ],
      {
        limits: {
          actions: {
            maxValueBytes: 24,
          },
        },
      },
    );

    expect(buttons).toEqual([
      {
        label: "Keep",
        action: { type: "command", command: "/codex plugins menu" },
      },
    ]);
  });

  it("keeps typed button actions when only the legacy fallback exceeds value limits", () => {
    const buttons = applyPresentationActionLimits(
      [
        {
          label: "Keep",
          value: "legacy-value-that-is-too-long",
          action: { type: "command", command: "/short" },
        },
      ],
      {
        limits: {
          actions: {
            maxValueBytes: 8,
          },
        },
      },
    );

    expect(buttons).toEqual([
      {
        label: "Keep",
        action: { type: "command", command: "/short" },
      },
    ]);
  });

  it("keeps typed select actions when only the legacy fallback exceeds value limits", () => {
    const presentation = adaptMessagePresentationForChannel({
      presentation: {
        blocks: [
          {
            type: "select",
            options: [
              {
                label: "Keep",
                value: "legacy-value-that-is-too-long",
                action: { type: "callback", value: "short" },
              },
            ],
          },
        ],
      },
      capabilities: {
        limits: {
          selects: {
            maxValueBytes: 8,
          },
        },
      },
    });

    expect(presentation.blocks).toEqual([
      {
        type: "select",
        options: [{ label: "Keep", action: { type: "callback", value: "short" } }],
      },
    ]);
  });

  it("adapts button and select blocks without touching text blocks", () => {
    const presentation = adaptMessagePresentationForChannel({
      presentation: {
        title: "Deploy",
        blocks: [
          { type: "text", text: "Ready" },
          {
            type: "buttons",
            buttons: [
              {
                label: "Approve deployment",
                value: "approve",
                style: "success",
              },
              { label: "Reject", value: "x".repeat(12), priority: 10 },
            ],
          },
          {
            type: "select",
            placeholder: "Environment target",
            options: [
              { label: "Canary cluster", value: "canary" },
              { label: "Production cluster", value: "production" },
            ],
          },
        ],
      },
      capabilities: {
        limits: {
          actions: {
            maxActions: 2,
            maxLabelLength: 7,
            maxValueBytes: 8,
            supportsStyles: false,
            supportsDisabled: false,
          },
          selects: {
            maxOptions: 1,
            maxLabelLength: 6,
            maxValueBytes: 20,
          },
        },
      },
    });

    expect(presentation).toEqual({
      title: "Deploy",
      blocks: [
        { type: "text", text: "Ready" },
        {
          type: "buttons",
          buttons: [{ label: "Approve", value: "approve" }],
        },
        { type: "context", text: "Actions:\n- Reject" },
        {
          type: "select",
          placeholder: "Enviro",
          options: [{ label: "Canary", value: "canary" }],
        },
        { type: "context", text: "Environment target:\n- Produc" },
      ],
    });
  });

  it("keeps visible fallback labels when controls exceed channel value limits", () => {
    const presentation = adaptMessagePresentationForChannel({
      presentation: {
        blocks: [
          {
            type: "buttons",
            buttons: [
              { label: "Approve deployment", value: "approve-prod" },
              { label: "Rollback deployment", value: "rollback-prod" },
            ],
          },
          {
            type: "select",
            placeholder: "Environment",
            options: [
              { label: "Canary cluster", value: "canary-target" },
              { label: "Production cluster", value: "production-target" },
            ],
          },
        ],
      },
      capabilities: {
        limits: {
          actions: {
            maxValueBytes: 4,
            maxLabelLength: 8,
          },
          selects: {
            maxValueBytes: 4,
            maxLabelLength: 7,
          },
        },
      },
    });

    expect(presentation.blocks).toEqual([
      { type: "context", text: "Actions:\n- Approve\n- Rollback" },
      { type: "context", text: "Environment:\n- Canary\n- Product" },
    ]);
  });

  it("keeps fallback labels for invalid buttons in mixed button blocks", () => {
    const presentation = adaptMessagePresentationForChannel({
      presentation: {
        blocks: [
          {
            type: "buttons",
            buttons: [
              { label: "Approve", value: "ok" },
              { label: "Audit trail", value: "x".repeat(20) },
              { label: "Docs", value: "x".repeat(20), url: "https://docs.example.test" },
            ],
          },
        ],
      },
      capabilities: {
        limits: {
          actions: {
            maxValueBytes: 4,
          },
        },
      },
    });

    expect(presentation.blocks).toEqual([
      {
        type: "buttons",
        buttons: [
          { label: "Approve", value: "ok" },
          { label: "Docs", url: "https://docs.example.test" },
        ],
      },
      { type: "context", text: "Actions:\n- Audit trail" },
    ]);
  });

  it("degrades disabled buttons unless the channel supports disabled controls", () => {
    const unsupported = adaptMessagePresentationForChannel({
      presentation: {
        blocks: [
          {
            type: "buttons",
            buttons: [{ label: "Wait", value: "wait", disabled: true }],
          },
        ],
      },
      capabilities: {
        limits: {
          actions: {},
        },
      },
    });
    const supported = adaptMessagePresentationForChannel({
      presentation: {
        blocks: [
          {
            type: "buttons",
            buttons: [{ label: "Wait", value: "wait", disabled: true }],
          },
        ],
      },
      capabilities: {
        limits: {
          actions: {
            supportsDisabled: true,
          },
        },
      },
    });

    expect(unsupported.blocks).toEqual([{ type: "context", text: "Actions:\n- Wait" }]);
    expect(supported.blocks).toEqual([
      {
        type: "buttons",
        buttons: [{ label: "Wait", value: "wait", disabled: true }],
      },
    ]);
  });

  it("degrades unsupported controls before channel rendering", () => {
    const presentation = adaptMessagePresentationForChannel({
      presentation: {
        blocks: [
          {
            type: "buttons",
            buttons: [{ label: "Approve", value: "approve" }],
          },
          {
            type: "select",
            placeholder: "Target",
            options: [{ label: "Canary", value: "canary" }],
          },
          { type: "divider" },
          { type: "context", text: "Muted details" },
        ],
      },
      capabilities: {
        buttons: false,
        selects: false,
        context: false,
        divider: false,
        limits: {
          actions: { maxLabelLength: 4 },
          selects: { maxLabelLength: 6 },
        },
      },
    });

    expect(presentation.blocks).toEqual([
      { type: "text", text: "Actions:\n- Appr" },
      { type: "text", text: "Target:\n- Canary" },
      { type: "text", text: "Muted details" },
    ]);
  });

  it("keeps fallback labels for invalid or overflowed select options", () => {
    const presentation = adaptMessagePresentationForChannel({
      presentation: {
        blocks: [
          {
            type: "select",
            placeholder: "Target",
            options: [
              { label: "Canary", value: "canary" },
              { label: "Production", value: "prod" },
              { label: "Long callback", value: "x".repeat(20) },
            ],
          },
        ],
      },
      capabilities: {
        limits: {
          selects: {
            maxOptions: 1,
            maxValueBytes: 8,
          },
        },
      },
    });

    expect(presentation.blocks).toEqual([
      {
        type: "select",
        placeholder: "Target",
        options: [{ label: "Canary", value: "canary" }],
      },
      { type: "context", text: "Target:\n- Production\n- Long callback" },
    ]);
  });

  it("applies advertised text limits to titles, text, context, and generated fallback", () => {
    const presentation = adaptMessagePresentationForChannel({
      presentation: {
        title: "abcdef",
        blocks: [
          { type: "text", text: "hello world" },
          { type: "context", text: "abcdef" },
          {
            type: "buttons",
            buttons: [{ label: "Deploy", value: "toolong" }],
          },
        ],
      },
      capabilities: {
        limits: {
          actions: {
            maxValueBytes: 2,
          },
          text: {
            maxLength: 5,
            encoding: "characters",
          },
        },
      },
    });

    expect(presentation).toEqual({
      title: "abcde",
      blocks: [
        { type: "text", text: "hello" },
        { type: "context", text: "abcde" },
        { type: "context", text: "Actio" },
      ],
    });
  });

  it("does not split code points when applying utf8 byte text limits", () => {
    const presentation = adaptMessagePresentationForChannel({
      presentation: {
        blocks: [{ type: "text", text: "abc😀def" }],
      },
      capabilities: {
        limits: {
          text: {
            maxLength: 6,
            encoding: "utf8-bytes",
          },
        },
      },
    });

    expect(presentation.blocks).toEqual([{ type: "text", text: "abc" }]);
  });

  it("does not split code points when applying label limits", () => {
    const presentation = adaptMessagePresentationForChannel({
      presentation: {
        blocks: [
          {
            type: "buttons",
            buttons: [{ label: "😀😀😀", value: "ok" }],
          },
          {
            type: "select",
            placeholder: "🚀🚀🚀",
            options: [{ label: "👍👍👍", value: "yes" }],
          },
        ],
      },
      capabilities: {
        limits: {
          actions: {
            maxLabelLength: 2,
          },
          selects: {
            maxLabelLength: 2,
          },
        },
      },
    });

    expect(presentation.blocks).toEqual([
      {
        type: "buttons",
        buttons: [{ label: "😀😀", value: "ok" }],
      },
      {
        type: "select",
        placeholder: "🚀🚀",
        options: [{ label: "👍👍", value: "yes" }],
      },
    ]);
  });

  it("preserves link buttons by dropping only over-limit callback values", () => {
    const presentation = adaptMessagePresentationForChannel({
      presentation: {
        blocks: [
          {
            type: "buttons",
            buttons: [{ label: "Open report", value: "x".repeat(20), url: "https://example.test" }],
          },
        ],
      },
      capabilities: {
        limits: {
          actions: {
            maxValueBytes: 4,
          },
        },
      },
    });

    expect(presentation.blocks).toEqual([
      {
        type: "buttons",
        buttons: [{ label: "Open report", url: "https://example.test" }],
      },
    ]);
  });

  it("applies button priority across the shared action budget", () => {
    const presentation = adaptMessagePresentationForChannel({
      presentation: {
        blocks: [
          {
            type: "buttons",
            buttons: [{ label: "Low", value: "low" }],
          },
          {
            type: "buttons",
            buttons: [{ label: "High", value: "high", priority: 10 }],
          },
        ],
      },
      capabilities: {
        limits: {
          actions: {
            maxActions: 1,
          },
        },
      },
    });

    expect(presentation.blocks).toEqual([
      { type: "context", text: "Actions:\n- Low" },
      {
        type: "buttons",
        buttons: [{ label: "High", value: "high", priority: 10 }],
      },
    ]);
  });

  it("keeps link targets when overflowed buttons become fallback text", () => {
    const presentation = adaptMessagePresentationForChannel({
      presentation: {
        blocks: [
          {
            type: "buttons",
            buttons: [{ label: "One", value: "one" }],
          },
          {
            type: "buttons",
            buttons: [{ label: "Docs", url: "https://docs.example.test" }],
          },
        ],
      },
      capabilities: {
        limits: {
          actions: {
            maxActions: 1,
            maxLabelLength: 4,
          },
        },
      },
    });

    expect(presentation.blocks).toEqual([
      {
        type: "buttons",
        buttons: [{ label: "One", value: "one" }],
      },
      { type: "context", text: "Actions:\n- Docs: https://docs.example.test" },
    ]);
  });

  it("preserves callback button values when actions do not declare a value limit", () => {
    const presentation = adaptMessagePresentationForChannel({
      presentation: {
        blocks: [
          {
            type: "buttons",
            buttons: [{ label: "Approve", value: "x".repeat(180) }],
          },
        ],
      },
      capabilities: {
        limits: {
          actions: {
            maxActions: 5,
            maxActionsPerRow: 5,
          },
        },
      },
    });

    expect(presentation.blocks).toEqual([
      {
        type: "buttons",
        buttons: [{ label: "Approve", value: "x".repeat(180) }],
      },
    ]);
  });

  it("reserves action row capacity for select blocks", () => {
    const presentation = adaptMessagePresentationForChannel({
      presentation: {
        blocks: [
          {
            type: "buttons",
            buttons: [
              { label: "One", value: "one" },
              { label: "Two", value: "two" },
              { label: "Three", value: "three" },
            ],
          },
          {
            type: "select",
            placeholder: "Extra",
            options: [{ label: "Four", value: "four" }],
          },
        ],
      },
      capabilities: {
        limits: {
          actions: {
            maxActionsPerRow: 2,
            maxRows: 2,
          },
          selects: {
            maxOptions: 25,
          },
        },
      },
    });

    expect(presentation.blocks).toEqual([
      {
        type: "buttons",
        buttons: [
          { label: "One", value: "one" },
          { label: "Two", value: "two" },
        ],
      },
      { type: "context", text: "Actions:\n- Three" },
      {
        type: "select",
        placeholder: "Extra",
        options: [{ label: "Four", value: "four" }],
      },
    ]);
  });

  it("splits button blocks by per-row limits even when rows are unlimited", () => {
    const presentation = adaptMessagePresentationForChannel({
      presentation: {
        blocks: [
          {
            type: "buttons",
            buttons: [
              { label: "One", value: "one" },
              { label: "Two", value: "two" },
              { label: "Three", value: "three" },
              { label: "Four", value: "four" },
              { label: "Five", value: "five" },
              { label: "Six", value: "six" },
            ],
          },
        ],
      },
      capabilities: {
        limits: {
          actions: {
            maxActions: 20,
            maxActionsPerRow: 5,
          },
        },
      },
    });

    expect(presentation.blocks).toEqual([
      {
        type: "buttons",
        buttons: [
          { label: "One", value: "one" },
          { label: "Two", value: "two" },
          { label: "Three", value: "three" },
          { label: "Four", value: "four" },
          { label: "Five", value: "five" },
        ],
      },
      {
        type: "buttons",
        buttons: [{ label: "Six", value: "six" }],
      },
    ]);
  });

  it("counts selects against the shared action capacity", () => {
    const presentation = adaptMessagePresentationForChannel({
      presentation: {
        blocks: [
          {
            type: "select",
            placeholder: "Target",
            options: [{ label: "Canary", value: "canary" }],
          },
          {
            type: "buttons",
            buttons: [
              { label: "One", value: "one" },
              { label: "Two", value: "two" },
              { label: "Three", value: "three" },
            ],
          },
        ],
      },
      capabilities: {
        limits: {
          actions: {
            maxActions: 3,
            maxActionsPerRow: 5,
            maxRows: 5,
          },
        },
      },
    });

    expect(presentation.blocks).toEqual([
      {
        type: "select",
        placeholder: "Target",
        options: [{ label: "Canary", value: "canary" }],
      },
      {
        type: "buttons",
        buttons: [
          { label: "One", value: "one" },
          { label: "Two", value: "two" },
        ],
      },
      { type: "context", text: "Actions:\n- Three" },
    ]);
  });

  it("resolves page size from available action capacity", () => {
    expect(
      presentationPageSize(
        {
          limits: {
            actions: { maxActionsPerRow: 5, maxRows: 2 },
          },
        },
        1,
        20,
      ),
    ).toBe(9);
  });

  it("keeps charts only for channels that explicitly advertise native support", () => {
    const chart = {
      type: "chart" as const,
      chartType: "bar" as const,
      title: "Quarterly revenue",
      categories: ["Q1", "Q2"],
      series: [{ name: "Revenue", values: [120, 145] }],
    };

    expect(
      adaptMessagePresentationForChannel({
        presentation: { blocks: [chart] },
        capabilities: { charts: true },
      }).blocks,
    ).toEqual([chart]);
    expect(
      adaptMessagePresentationForChannel({
        presentation: { blocks: [chart] },
        capabilities: { context: true },
      }).blocks,
    ).toEqual([
      {
        type: "context",
        text: "Quarterly revenue (bar chart)\n- Revenue: Q1: 120; Q2: 145",
      },
    ]);
    expect(
      adaptMessagePresentationForChannel({
        presentation: { blocks: [chart] },
        capabilities: { context: false },
      }).blocks[0]?.type,
    ).toBe("text");
  });

  it("splits chart fallback without losing the final series or category", () => {
    const categories = Array.from(
      { length: 20 },
      (_, index) => `Category-${String(index).padStart(2, "0")}`,
    );
    const series = Array.from({ length: 12 }, (_, seriesIndex) => ({
      name: `Series-${String(seriesIndex).padStart(2, "0")}`,
      values: categories.map((_category, categoryIndex) => seriesIndex * 100 + categoryIndex),
    }));
    const chart = {
      type: "chart" as const,
      chartType: "line" as const,
      title: "Quarterly revenue",
      categories,
      series,
    };
    const maxLength = 500;
    const presentation = adaptMessagePresentationForChannel({
      presentation: { blocks: [chart] },
      capabilities: {
        context: true,
        limits: { text: { maxLength, encoding: "characters" } },
      },
    });
    const fallbackBlocks = presentation.blocks.map((block) => {
      expect(block.type).toBe("context");
      return block.type === "context" ? block.text : "";
    });

    expect(fallbackBlocks.length).toBeGreaterThan(1);
    expect(fallbackBlocks.every((text) => Array.from(text).length <= maxLength)).toBe(true);
    const fallbackText = fallbackBlocks.join("");
    expect(fallbackText).toBe(renderMessagePresentationChartFallbackText(chart));
    expect(fallbackText).toContain("Category-19: 1119");
  });

  it("keeps tables only for channels that explicitly advertise native support", () => {
    const table = {
      type: "table" as const,
      caption: "Pipeline report",
      headers: ["Account", "Stage", "ARR"],
      rows: [
        ["Acme", "Won", 125000],
        ["Globex", "Review", 82000],
      ],
      rowHeaderColumnIndex: 0,
    };

    expect(
      adaptMessagePresentationForChannel({
        presentation: { blocks: [table] },
        capabilities: { tables: true },
      }).blocks,
    ).toEqual([table]);
    expect(
      adaptMessagePresentationForChannel({
        presentation: { blocks: [table] },
        capabilities: { context: true },
      }).blocks,
    ).toEqual([
      {
        type: "context",
        text: [
          "Pipeline report (table)",
          "- Account: Acme; Stage: Won; ARR: 125000",
          "- Account: Globex; Stage: Review; ARR: 82000",
        ].join("\n"),
      },
    ]);
    expect(
      adaptMessagePresentationForChannel({
        presentation: { blocks: [table] },
        capabilities: { context: false },
      }).blocks[0]?.type,
    ).toBe("text");
  });

  it.each([
    {
      encoding: "characters" as const,
      length: (value: string) => Array.from(value).length,
    },
    {
      encoding: "utf8-bytes" as const,
      length: (value: string) => Buffer.byteLength(value, "utf8"),
    },
    {
      encoding: "utf16-units" as const,
      length: (value: string) => value.length,
    },
  ])(
    "splits table fallback by line without losing rows for $encoding limits",
    ({ encoding, length }) => {
      const rows = Array.from({ length: 12 }, (_, index) => [
        `Account-${String(index).padStart(2, "0")}`,
        `Stage-${index}`,
      ]);
      const maxLength = 64;
      const presentation = adaptMessagePresentationForChannel({
        presentation: {
          blocks: [
            {
              type: "table",
              caption: "Pipeline report",
              headers: ["Account", "Stage"],
              rows,
            },
          ],
        },
        capabilities: {
          context: true,
          limits: { text: { maxLength, encoding } },
        },
      });
      const fallbackBlocks = presentation.blocks.map((block) => {
        expect(block.type).toBe("context");
        return block.type === "context" ? block.text : "";
      });

      expect(fallbackBlocks.length).toBeGreaterThan(1);
      expect(fallbackBlocks.every((text) => length(text) <= maxLength)).toBe(true);
      expect(fallbackBlocks.join("")).toBe(
        [
          "Pipeline report (table)",
          ...rows.map(([account, stage]) => `- Account: ${account}; Stage: ${stage}`),
        ].join("\n"),
      );
    },
  );

  it("hard-splits an oversized table row without breaking UTF-16 surrogate pairs", () => {
    const value = "😀".repeat(20);
    const maxLength = 10;
    const presentation = adaptMessagePresentationForChannel({
      presentation: {
        blocks: [
          {
            type: "table",
            caption: "R",
            headers: ["Value"],
            rows: [[value]],
          },
        ],
      },
      capabilities: {
        context: false,
        limits: { text: { maxLength, encoding: "utf16-units" } },
      },
    });
    const fallbackBlocks = presentation.blocks.map((block) => {
      expect(block.type).toBe("text");
      return block.type === "text" ? block.text : "";
    });

    expect(fallbackBlocks.every((text) => text.length <= maxLength)).toBe(true);
    expect(
      fallbackBlocks.every((text) => {
        const first = text.charCodeAt(0);
        const last = text.charCodeAt(text.length - 1);
        return !(first >= 0xdc00 && first <= 0xdfff) && !(last >= 0xd800 && last <= 0xdbff);
      }),
    ).toBe(true);
    expect(fallbackBlocks[0]).toBe("R (table)\n");
    expect(fallbackBlocks.slice(1).join("")).toBe(`- Value: ${value}`);
  });
});
