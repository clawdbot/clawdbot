import { createDirectoryTestRuntime } from "openclaw/plugin-sdk/channel-test-helpers";
import { describe, expect, it } from "vitest";
import {
  listWhatsAppDirectoryGroupsFromConfig,
  listWhatsAppDirectoryPeersFromConfig,
} from "./directory-config.js";
import type { OpenClawConfig } from "./runtime-api.js";

describe("whatsapp directory", () => {
  const runtimeEnv = createDirectoryTestRuntime() as never;

  it("lists peers and groups from config", async () => {
    const cfg = {
      channels: {
        whatsapp: {
          authDir: "/tmp/wa-auth",
          allowFrom: [
            "whatsapp:+15551230001",
            "15551230002@s.whatsapp.net",
            "120363999999999999@g.us",
          ],
          groups: {
            "120363111111111111@g.us": {},
            "120363222222222222@g.us": {},
          },
        },
      },
    } as unknown as OpenClawConfig;

    await expect(
      listWhatsAppDirectoryPeersFromConfig({
        cfg,
        accountId: undefined,
        query: undefined,
        limit: undefined,
        runtime: runtimeEnv,
      } as never),
    ).resolves.toEqual(
      expect.arrayContaining([
        { kind: "user", id: "+15551230001" },
        { kind: "user", id: "+15551230002" },
      ]),
    );

    await expect(
      listWhatsAppDirectoryGroupsFromConfig({
        cfg,
        accountId: undefined,
        query: undefined,
        limit: undefined,
        runtime: runtimeEnv,
      } as never),
    ).resolves.toEqual(
      expect.arrayContaining([
        { kind: "group", id: "120363111111111111@g.us" },
        { kind: "group", id: "120363222222222222@g.us" },
      ]),
    );
  });
});
