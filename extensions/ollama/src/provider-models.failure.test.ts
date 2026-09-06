import { afterEach, describe, expect, it, vi } from "vitest";
import { buildOllamaProvider } from "./provider-models.js";

afterEach(() => vi.unstubAllGlobals());

describe("Ollama model discovery failures", () => {
  it.each([401, 403, 503, "invalid-json", "missing-models", "offline"])(
    "preserves advisory discovery while strict catalogs reject %s",
    async (failure) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          if (failure === "offline") {
            throw new Error("Ollama endpoint unavailable");
          }
          return new Response(failure === "invalid-json" ? "{" : "{}", {
            status: typeof failure === "number" ? failure : 200,
          });
        }),
      );

      await expect(
        buildOllamaProvider("http://127.0.0.1:11434", { quiet: true }),
      ).resolves.toMatchObject({ models: [] });
      await expect(
        buildOllamaProvider("http://127.0.0.1:11434", { discoveryMode: "strict" }),
      ).rejects.toThrow();
    },
  );
});
