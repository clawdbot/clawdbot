declare module "@novnc/novnc" {
  export default class RFB extends EventTarget {
    constructor(
      target: HTMLElement,
      channel: string | WebSocket,
      options?: { credentials?: { password: string } },
    );

    scaleViewport: boolean;
    viewOnly: boolean;
    disconnect(): void;
  }
}
