import { describe, expect, it } from "vitest";
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
});
