import { withRuntimeImageHistory } from "@openclaw/media-core";
import { describe, expect, it } from "vitest";
import { buildCodexUserInput } from "./user-input.js";

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
const BMP = "Qk06AAAAAAAAADYAAAAoAAAAAQAAAAEAAAABABgAAAAAAAQAAAATCwAAEwsAAAAAAAAAAAAAAAD/AA==";

describe("Codex retained image input", () => {
  it("describes only retained images that survive native input validation", () => {
    const current = { type: "image" as const, mimeType: "image/png", data: PNG };
    const omitted = withRuntimeImageHistory(
      { type: "image" as const, mimeType: "image/bmp", data: BMP },
      { key: "omitted", sourceText: "from Grace, message omitted" },
    );
    const retained = withRuntimeImageHistory(
      { type: "image" as const, mimeType: "image/png", data: PNG },
      { key: "retained", sourceText: "from Ada, message retained" },
    );
    const images = [current, omitted, retained];
    const original = JSON.stringify(images);

    expect(buildCodexUserInput("Compare the photos", images)).toEqual([
      {
        type: "text",
        text:
          "Compare the photos\n\n" +
          "[Recent image 1 from Ada, message retained, attached as media.]",
        text_elements: [],
      },
      { type: "image", url: `data:image/png;base64,${PNG}` },
      {
        type: "text",
        text: "[codex user input] omitted image payload: invalid inline image data",
        text_elements: [],
      },
      { type: "image", url: `data:image/png;base64,${PNG}` },
    ]);
    expect(JSON.stringify(images)).toBe(original);
  });
});
