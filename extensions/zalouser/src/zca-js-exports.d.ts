declare module "zca-js" {
  export const ThreadType: {
    User: number;
    Group: number;
  };

  export const LoginQRCallbackEventType: {
    QRCodeGenerated: number;
    QRCodeExpired: number;
    QRCodeScanned: number;
    QRCodeDeclined: number;
    GotLoginInfo: number;
  };

  export const Reactions: Record<string, string>;

  export class Zalo {
    constructor(options?: { logging?: boolean; selfListen?: boolean });
    login(credentials: unknown): Promise<unknown>;
    loginQR(options?: unknown, callback?: (event: unknown) => unknown): Promise<unknown>;
  }
}
