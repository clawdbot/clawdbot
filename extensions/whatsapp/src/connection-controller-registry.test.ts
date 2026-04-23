import { describe, expect, it, vi } from "vitest";

type RegistryModule = typeof import("./connection-controller-registry.js");

const registryModuleUrl = new URL("./connection-controller-registry.ts", import.meta.url).href;

async function importRegistryModule(cacheBust: string): Promise<RegistryModule> {
  return (await import(`${registryModuleUrl}?t=${cacheBust}`)) as RegistryModule;
}

describe("WhatsApp connection controller registry", () => {
  it("shares registered controllers across duplicate module instances", async () => {
    const first = await importRegistryModule(`first-${Date.now()}`);
    const second = await importRegistryModule(`second-${Date.now()}`);
    const controller = {
      getActiveListener: vi.fn(() => null),
    };

    first.registerWhatsAppConnectionController("work", controller);

    try {
      expect(second.getRegisteredWhatsAppConnectionController("work")).toBe(controller);
    } finally {
      first.unregisterWhatsAppConnectionController("work", controller);
    }
  });
});
