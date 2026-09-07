// Feishu tests cover docx color-text markup lookup.
import type * as Lark from "@larksuiteoapi/node-sdk";
import { describe, expect, it } from "vitest";
import { updateColorText } from "./docx-color-text.js";

type PatchRequest = {
  data?: {
    update_text_elements?: {
      elements?: Array<{
        text_run?: {
          content?: string;
          text_element_style?: {
            background_color?: unknown;
            text_color?: unknown;
            bold?: boolean;
          };
        };
      }>;
    };
  };
};

function createPatchClient() {
  const patches: PatchRequest[] = [];
  const client = {
    docx: {
      documentBlock: {
        patch: async (req: PatchRequest) => {
          patches.push(req);
          return { code: 0, data: { block: {} } };
        },
      },
    },
  } as unknown as Lark.Client;
  return { client, patches };
}

describe("updateColorText color lookup", () => {
  it("does not treat Object.prototype keys as background colors", async () => {
    const { client, patches } = createPatchClient();

    await updateColorText(client, "doc", "block", "Revenue [bg:constructor]secret[/bg] YoY");

    const elements = patches[0]?.data?.update_text_elements?.elements ?? [];
    expect(elements.map((el) => el.text_run?.content)).toEqual(["Revenue ", "secret", " YoY"]);
    const secretStyle = elements[1]?.text_run?.text_element_style;
    expect(typeof secretStyle?.background_color).not.toBe("function");
    expect(secretStyle?.background_color).toBeUndefined();
  });

  it("still applies own background and text color keys", async () => {
    const { client, patches } = createPatchClient();

    await updateColorText(
      client,
      "doc",
      "block",
      "Revenue [bg:yellow]secret[/bg] [green]+15%[/green]",
    );

    const elements = patches[0]?.data?.update_text_elements?.elements ?? [];
    expect(elements.map((el) => el.text_run?.content)).toEqual(["Revenue ", "secret", " ", "+15%"]);
    expect(elements[1]?.text_run?.text_element_style?.background_color).toBe(3);
    expect(elements[3]?.text_run?.text_element_style?.text_color).toBe(4);
  });
});
