// Whatsapp plugin module implements lifecycle behavior.
import type { BaileysEventEmitter, BaileysEventMap } from "baileys";

type BaileysListener<Event extends keyof BaileysEventMap> = (arg: BaileysEventMap[Event]) => void;

export type WhatsAppSocketListen = <Event extends keyof BaileysEventMap>(
  event: Event,
  listener: BaileysListener<Event>,
) => () => void;

type ClosableSocket = {
  end?: (error: Error | undefined) => void;
  ws?: {
    close?: () => void;
  };
};

export function attachEmitterListener<Event extends keyof BaileysEventMap>(
  emitter: BaileysEventEmitter,
  event: Event,
  listener: BaileysListener<Event>,
): () => void {
  emitter.on(event, listener);
  return () => emitter.off(event, listener);
}

export function closeInboundMonitorSocket(sock: ClosableSocket): void {
  if (typeof sock.end === "function") {
    sock.end(new Error("OpenClaw WhatsApp listener close"));
    return;
  }
  sock.ws?.close?.();
}
