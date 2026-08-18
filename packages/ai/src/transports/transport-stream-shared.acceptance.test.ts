import type { Model, StreamOptions } from "@openclaw/llm-core";
import { describe, expect, it, vi } from "vitest";
import { notifyProviderHttpResponse } from "./transport-stream-shared.js";

const model = { id: "acceptance-test", provider: "test" } as Model;

describe("notifyProviderHttpResponse", () => {
  it.each(["onProviderAccepted", "onResponse"] as const)(
    "cancels an unread response when %s fails",
    async (hookName) => {
      const hookError = new Error(`${hookName} failed`);
      const cancel = vi.fn();
      const response = new Response(
        new ReadableStream<Uint8Array>({
          cancel,
        }),
        { status: 200 },
      );
      const options: StreamOptions = {
        [hookName]: vi.fn(() => Promise.reject(hookError)),
      };

      await expect(notifyProviderHttpResponse({ options, response, model })).rejects.toBe(
        hookError,
      );

      expect(cancel).toHaveBeenCalledWith(hookError);
    },
  );
});
