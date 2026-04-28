import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";

export type TalkSpeakTestPayload = {
  audioBase64?: string;
  provider?: string;
  outputFormat?: string;
  mimeType?: string;
  fileExtension?: string;
};

export async function invokeTalkSpeakDirect(params: Record<string, unknown>) {
  const { talkHandlers } = await import("./server-methods/talk.js");
  const { getRuntimeConfig } = await import("../config/config.js");
  let response:
    | {
        ok: boolean;
        payload?: unknown;
        error?: { code?: string; message?: string; details?: unknown };
      }
    | undefined;
  await talkHandlers["talk.speak"]({
    req: { type: "req", id: "test", method: "talk.speak", params },
    params,
    client: null,
    isWebchatConnect: () => false,
    respond: (ok, payload, error) => {
      response = { ok, payload, error };
    },
    context: { getRuntimeConfig: getRuntimeConfig } as never,
  });
  return response;
}

export async function withSpeechProviders<T>(
  speechProviders: NonNullable<ReturnType<typeof createEmptyPluginRegistry>["speechProviders"]>,
  run: () => Promise<T>,
): Promise<T> {
  const previousRegistry = getActivePluginRegistry() ?? createEmptyPluginRegistry();
  setActivePluginRegistry({
    ...createEmptyPluginRegistry(),
    speechProviders,
  });
  try {
    return await run();
  } finally {
    setActivePluginRegistry(previousRegistry);
  }
}
