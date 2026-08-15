// Guards config schema startup imports against loading heavy runtime modules.
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";

const providersWhatsappImportMock = vi.hoisted(() => vi.fn());

describe("OpenClawSchema startup imports", () => {
  beforeEach(() => {
    providersWhatsappImportMock.mockClear();
    vi.doMock("./zod-schema.providers-whatsapp.js", () => {
      providersWhatsappImportMock();
      return {};
    });
  });

  it("does not load provider-specific channel schemas for generic channel validation", async () => {
    const runtime = await importFreshModule<typeof import("./zod-schema.js")>(
      import.meta.url,
      "./zod-schema.js?scope=startup-generic-channels",
    );

    const parsed = runtime.OpenClawSchema.safeParse({
      channels: {
        defaults: {
          groupPolicy: "open",
          botLoopProtection: {
            maxEventsPerWindow: 4,
            windowSeconds: 90,
            cooldownSeconds: 30,
          },
        },
        discord: {},
      },
    });

    expect(parsed.success).toBe(true);
    expect(providersWhatsappImportMock).not.toHaveBeenCalled();
  });
});
