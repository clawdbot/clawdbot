export class ScreenWakeLock {
  private active = false;
  private lock: WakeLockSentinel | null = null;
  private request: Promise<void> | null = null;

  start(): void {
    if (this.active) {
      return;
    }
    this.active = true;
    if (typeof document === "undefined" || typeof navigator === "undefined") {
      return;
    }
    document.addEventListener("visibilitychange", this.handleVisibilityChange);
    this.acquire();
  }

  stop(): void {
    if (!this.active) {
      return;
    }
    this.active = false;
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.handleVisibilityChange);
    }
    const lock = this.lock;
    this.lock = null;
    void lock?.release();
  }

  private readonly handleVisibilityChange = () => {
    if (document.visibilityState === "visible") {
      this.acquire();
    }
  };

  private acquire(): void {
    if (
      !this.active ||
      this.lock ||
      this.request ||
      document.visibilityState !== "visible" ||
      !("wakeLock" in navigator)
    ) {
      return;
    }
    this.request = navigator.wakeLock
      .request("screen")
      .then(async (lock) => {
        if (!this.active) {
          await lock.release();
          return;
        }
        this.lock = lock;
        lock.addEventListener(
          "release",
          () => {
            if (this.lock === lock) {
              this.lock = null;
            }
          },
          { once: true },
        );
      })
      .catch(() => {
        // Microphone features remain available when the browser or OS declines this optional aid.
      })
      .finally(() => {
        this.request = null;
      });
  }
}
