import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { googlechatPlugin } from "./channel.js";
import { googlechatSetupPlugin } from "./channel.setup.js";

describe("googlechatPlugin config adapter", () => {
  it("keeps setup metadata aligned with the runtime plugin", () => {
    expect(googlechatSetupPlugin.id).toBe(googlechatPlugin.id);
    expect(googlechatSetupPlugin.meta).toEqual(googlechatPlugin.meta);
    expect(googlechatSetupPlugin.capabilities?.chatTypes).toEqual(
      googlechatPlugin.capabilities?.chatTypes,
    );
  });

  it("keeps read-only accessors from resolving service account SecretRefs", () => {
    const cfg = {
      secrets: {
        providers: {
          google_chat_service_account: {
            source: "file",
            path: "/tmp/openclaw-missing-google-chat-service-account",
            mode: "singleValue",
          },
        },
      },
      channels: {
        googlechat: {
          serviceAccount: {
            source: "file",
            provider: "google_chat_service_account",
            id: "value",
          },
          dm: {
            allowFrom: ["users/123"],
          },
          defaultTo: "spaces/AAA",
        },
      },
    } as OpenClawConfig;

    expect(googlechatPlugin.config.resolveAllowFrom?.({ cfg, accountId: "default" })).toEqual([
      "users/123",
    ]);
    expect(googlechatPlugin.config.resolveDefaultTo?.({ cfg, accountId: "default" })).toBe(
      "spaces/AAA",
    );
  });
});
