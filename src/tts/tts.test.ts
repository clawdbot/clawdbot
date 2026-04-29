import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

describe("tts runtime facade", () => {
  it("keeps speech-core behind the lazy runtime facade", () => {
    const publicFacadeSource = readSource("./tts.ts");
    const runtimeFacadeSource = readSource("../plugin-sdk/tts-runtime.ts");

    expect(publicFacadeSource).toContain('} from "../plugin-sdk/tts-runtime.js";');
    expect(publicFacadeSource).not.toContain("speech-core");
    expect(runtimeFacadeSource).toContain("function loadFacadeModule()");
    expect(runtimeFacadeSource).toContain('dirName: "speech-core"');
    expect(runtimeFacadeSource).toContain(
      'createLazyFacadeRuntimeValue(loadFacadeModule, "buildTtsSystemPromptHint")',
    );
  });
});
