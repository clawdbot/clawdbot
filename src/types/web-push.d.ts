declare module "web-push" {
  export type PushSubscription = {
    endpoint: string;
    keys: {
      p256dh: string;
      auth: string;
    };
  };

  export type SendResult = {
    statusCode: number;
    body: string;
    headers: Record<string, string>;
  };

  export type VAPIDKeys = {
    publicKey: string;
    privateKey: string;
  };

  export function generateVAPIDKeys(): VAPIDKeys;

  export function setVapidDetails(subject: string, publicKey: string, privateKey: string): void;

  export function sendNotification(
    subscription: PushSubscription,
    payload?: string | Buffer | null,
    options?: Record<string, unknown>,
  ): Promise<SendResult>;
}
