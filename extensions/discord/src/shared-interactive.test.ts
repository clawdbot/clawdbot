import { describe, expect, it } from "vitest";
import {
  buildDiscordInteractiveComponents,
  buildDiscordPresentationComponents,
} from "./shared-interactive.js";

describe("buildDiscordInteractiveComponents", () => {
  it("maps shared buttons and selects into Discord component blocks", () => {
    expect(
      buildDiscordInteractiveComponents({
        blocks: [
          {
            type: "buttons",
            buttons: [
              { label: "Approve", value: "approve", style: "success" },
              { label: "Reject", value: "reject", style: "danger" },
            ],
          },
          {
            type: "select",
            placeholder: "Pick one",
            options: [{ label: "Alpha", value: "alpha" }],
          },
        ],
      }),
    ).toEqual({
      blocks: [
        {
          type: "actions",
          buttons: [
            { label: "Approve", style: "success", callbackData: "approve" },
            { label: "Reject", style: "danger", callbackData: "reject" },
          ],
        },
        {
          type: "actions",
          select: {
            type: "string",
            placeholder: "Pick one",
            options: [{ label: "Alpha", value: "alpha" }],
          },
        },
      ],
    });
  });

  it("preserves authored shared text blocks around controls", () => {
    expect(
      buildDiscordInteractiveComponents({
        blocks: [
          { type: "text", text: "First" },
          {
            type: "buttons",
            buttons: [{ label: "Approve", value: "approve", style: "success" }],
          },
          { type: "text", text: "Last" },
        ],
      }),
    ).toEqual({
      blocks: [
        { type: "text", text: "First" },
        {
          type: "actions",
          buttons: [{ label: "Approve", style: "success", callbackData: "approve" }],
        },
        { type: "text", text: "Last" },
      ],
    });
  });

  it("preserves URL-only buttons as Discord link buttons", () => {
    expect(
      buildDiscordInteractiveComponents({
        blocks: [
          {
            type: "buttons",
            buttons: [{ label: "Docs", url: "https://example.com/docs" }],
          },
        ],
      }),
    ).toEqual({
      blocks: [
        {
          type: "actions",
          buttons: [{ label: "Docs", style: "link", url: "https://example.com/docs" }],
        },
      ],
    });
  });

  it("splits long shared button rows to stay within Discord action limits", () => {
    expect(
      buildDiscordInteractiveComponents({
        blocks: [
          {
            type: "buttons",
            buttons: [
              { label: "One", value: "1" },
              { label: "Two", value: "2" },
              { label: "Three", value: "3" },
              { label: "Four", value: "4" },
              { label: "Five", value: "5" },
              { label: "Six", value: "6" },
            ],
          },
        ],
      }),
    ).toEqual({
      blocks: [
        {
          type: "actions",
          buttons: [
            { label: "One", style: "secondary", callbackData: "1" },
            { label: "Two", style: "secondary", callbackData: "2" },
            { label: "Three", style: "secondary", callbackData: "3" },
            { label: "Four", style: "secondary", callbackData: "4" },
            { label: "Five", style: "secondary", callbackData: "5" },
          ],
        },
        {
          type: "actions",
          buttons: [{ label: "Six", style: "secondary", callbackData: "6" }],
        },
      ],
    });
  });

  it("does not duplicate presentation text when appending controls", () => {
    expect(
      buildDiscordPresentationComponents({
        title: "Status",
        blocks: [
          { type: "text", text: "Build completed" },
          { type: "context", text: "main branch" },
          {
            type: "buttons",
            buttons: [{ label: "Open", value: "open" }],
          },
        ],
      }),
    ).toEqual({
      blocks: [
        { type: "text", text: "Status" },
        { type: "text", text: "Build completed" },
        { type: "text", text: "-# main branch" },
        {
          type: "actions",
          buttons: [{ label: "Open", style: "secondary", callbackData: "open" }],
        },
      ],
    });
  });
});
