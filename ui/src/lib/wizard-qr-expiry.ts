import { MAX_WIZARD_QR_EXPIRES_IN_MS } from "@openclaw/gateway-protocol";
import type { WizardStep } from "../api/types.ts";

type QrStep = Extract<WizardStep, { type: "qr" }>;

// The producer deadline owns credential display lifetime even while a client
// waits for the next server result, so scrub the local image when it wins.
export function scheduleWizardQrExpiry(
  step: WizardStep,
  onExpire: (step: QrStep) => void,
): (() => void) | null {
  if (step.type !== "qr" || step.expiresInMs === undefined || step.expiresInMs <= 0) {
    return null;
  }
  const timer = setTimeout(
    () => onExpire({ ...step, qrDataUrl: "", expiresInMs: 0 }),
    Math.min(step.expiresInMs, MAX_WIZARD_QR_EXPIRES_IN_MS),
  );
  return () => clearTimeout(timer);
}
