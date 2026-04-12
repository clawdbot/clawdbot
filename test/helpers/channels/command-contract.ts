import {
  loadBundledPluginApiSync,
  loadBundledPluginContractApiSync,
} from "../../../src/test-utils/bundled-plugin-public-surface.js";

type TelegramContractSurface = typeof import("@openclaw/telegram/contract-api.js");
type WhatsAppApiSurface = Pick<
  typeof import("@openclaw/whatsapp/api.js"),
  "isWhatsAppGroupJid" | "normalizeWhatsAppTarget" | "whatsappCommandPolicy"
>;

let telegramContractSurface: TelegramContractSurface | undefined;
let whatsappApiSurface: WhatsAppApiSurface | undefined;

function createLazyObjectSurface<T extends object>(loadSurface: () => T): T {
  return new Proxy({} as T, {
    get(_target, property) {
      const surface = loadSurface();
      const value = Reflect.get(surface, property, surface);
      return typeof value === "function" ? value.bind(surface) : value;
    },
    has(_target, property) {
      return property in loadSurface();
    },
    ownKeys() {
      return Reflect.ownKeys(loadSurface());
    },
    getOwnPropertyDescriptor(_target, property) {
      return Reflect.getOwnPropertyDescriptor(loadSurface(), property);
    },
  });
}

function getTelegramContractSurface(): TelegramContractSurface {
  telegramContractSurface ??= loadBundledPluginContractApiSync<TelegramContractSurface>("telegram");
  return telegramContractSurface;
}

function getWhatsAppApiSurface(): WhatsAppApiSurface {
  whatsappApiSurface ??= loadBundledPluginApiSync<WhatsAppApiSurface>("whatsapp");
  return whatsappApiSurface;
}

export const buildTelegramModelsProviderChannelData = (
  ...args: Parameters<TelegramContractSurface["buildTelegramModelsProviderChannelData"]>
) => getTelegramContractSurface().buildTelegramModelsProviderChannelData(...args);

export const isWhatsAppGroupJid = (...args: Parameters<WhatsAppApiSurface["isWhatsAppGroupJid"]>) =>
  getWhatsAppApiSurface().isWhatsAppGroupJid(...args);

export const normalizeWhatsAppTarget = (
  ...args: Parameters<WhatsAppApiSurface["normalizeWhatsAppTarget"]>
) => getWhatsAppApiSurface().normalizeWhatsAppTarget(...args);

export const whatsappCommandPolicy = createLazyObjectSurface(
  () => getWhatsAppApiSurface().whatsappCommandPolicy,
);
