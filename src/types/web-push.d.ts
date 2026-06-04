/** Minimal ambient types for the web-push package. */
declare module "web-push" {
  /** Browser push subscription payload used by web-push. */
  export type PushSubscription = {
    endpoint: string;
    keys: {
      p256dh: string;
      auth: string;
    };
  };

  /** Result returned after a push notification send attempt. */
  export type SendResult = {
    statusCode: number;
    body: string;
    headers: Record<string, string>;
  };

  /** VAPID public/private key pair. */
  export type VAPIDKeys = {
    publicKey: string;
    privateKey: string;
  };

  /** Generate a VAPID key pair. */
  export function generateVAPIDKeys(): VAPIDKeys;

  /** Configure VAPID details before sending notifications. */
  export function setVapidDetails(subject: string, publicKey: string, privateKey: string): void;

  /** Send one web push notification. */
  export function sendNotification(
    subscription: PushSubscription,
    payload?: string | Buffer | null,
    options?: Record<string, unknown>,
  ): Promise<SendResult>;
}
