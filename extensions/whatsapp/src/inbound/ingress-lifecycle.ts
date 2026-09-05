import type { WhatsAppIngressLifecycle } from "./durable-receive.js";

const ingressLifecycleKey = Symbol("whatsappIngressLifecycle");

type WhatsAppIngressLifecycleCarrier = {
  [ingressLifecycleKey]?: WhatsAppIngressLifecycle;
};

export function attachWhatsAppIngressLifecycle<T extends object>(
  message: T,
  lifecycle: WhatsAppIngressLifecycle | undefined,
): T {
  if (lifecycle) {
    (message as WhatsAppIngressLifecycleCarrier)[ingressLifecycleKey] = lifecycle;
  }
  return message;
}

export function resolveWhatsAppIngressLifecycle(
  message: object,
): WhatsAppIngressLifecycle | undefined {
  return (message as WhatsAppIngressLifecycleCarrier)[ingressLifecycleKey];
}
