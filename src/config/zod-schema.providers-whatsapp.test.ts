import { describe, it, expect } from "vitest";
import { WhatsAppConfigSchema, WhatsAppAccountSchema } from "./zod-schema.providers-whatsapp.js";

describe("WhatsApp prompt config Zod validation", () => {
  it("validates group-level systemPrompt", () => {
    const config = {
      groups: {
        "123@g.us": {
          systemPrompt: "This is a work group",
        },
      },
    };

    const result = WhatsAppConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.groups?.["123@g.us"]?.systemPrompt).toBe("This is a work group");
    }
  });

  it("validates direct-level systemPrompt", () => {
    const config = {
      direct: {
        "+15551234567": {
          systemPrompt: "This is a VIP direct chat",
        },
      },
    };

    const result = WhatsAppConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.direct?.["+15551234567"]?.systemPrompt).toBe("This is a VIP direct chat");
    }
  });

  it("validates combined group and direct prompt surfaces", () => {
    const config = {
      groups: {
        "*": {
          systemPrompt: "Default group prompt",
        },
      },
      direct: {
        "+15551234567": {
          systemPrompt: "Direct VIP",
        },
      },
      accounts: {
        work: {
          groups: {
            "456@g.us": {
              systemPrompt: "Project team",
            },
          },
          direct: {
            "*": {
              systemPrompt: "Work direct default",
            },
          },
        },
      },
    };

    const result = WhatsAppConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.groups?.["*"]?.systemPrompt).toBe("Default group prompt");
      expect(result.data.direct?.["+15551234567"]?.systemPrompt).toBe("Direct VIP");
      expect(result.data.accounts?.work?.groups?.["456@g.us"]?.systemPrompt).toBe("Project team");
      expect(result.data.accounts?.work?.direct?.["*"]?.systemPrompt).toBe("Work direct default");
    }
  });

  it("validates WhatsAppAccountSchema directly", () => {
    const accountConfig = {
      name: "Personal Account",
      groups: {
        "family@g.us": {
          systemPrompt: "Keep responses family-friendly",
        },
      },
      direct: {
        "+15557654321": {
          systemPrompt: "Keep responses concise",
        },
      },
    };

    const result = WhatsAppAccountSchema.safeParse(accountConfig);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.groups?.["family@g.us"]?.systemPrompt).toBe(
        "Keep responses family-friendly",
      );
      expect(result.data.direct?.["+15557654321"]?.systemPrompt).toBe("Keep responses concise");
    }
  });

  it("accepts deprecated exposeErrorText as a no-op compatibility key", () => {
    const result = WhatsAppConfigSchema.safeParse({
      exposeErrorText: false,
      accounts: {
        work: {
          exposeErrorText: true,
        },
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(Object.hasOwn(result.data, "exposeErrorText")).toBe(false);
      expect(Object.hasOwn(result.data.accounts?.work ?? {}, "exposeErrorText")).toBe(false);
    }
  });

  it("keeps deprecated exposeErrorText out of generated config surfaces", () => {
    const schema = WhatsAppConfigSchema.toJSONSchema({
      target: "draft-07",
      unrepresentable: "any",
    }) as {
      properties?: {
        exposeErrorText?: unknown;
        accounts?: {
          additionalProperties?: {
            properties?: {
              exposeErrorText?: unknown;
            };
          };
        };
      };
    };

    expect(schema.properties?.exposeErrorText).toBeUndefined();
    expect(schema.properties?.accounts?.additionalProperties?.properties?.exposeErrorText).toBe(
      undefined,
    );
  });
});
