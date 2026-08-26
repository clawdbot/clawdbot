import {
  discoverRealtimeTalkInputs,
  observeRealtimeTalkDevices,
  type RealtimeTalkDeviceIssue,
  type RealtimeTalkInputDevice,
} from "./realtime-talk-input.ts";

/**
 * Device list behind a composer's microphone control, owned per composer.
 *
 * Discovery, the `devicechange` subscription and the in-flight request token
 * belong together: the subscription only lives while the picker is open, and a
 * late discovery must not overwrite a newer one. Keeping them in one owner is
 * what lets a second composer surface offer the same control without repeating
 * the sequencing, and gives the watch a single release point.
 */
export class ComposerMicrophonePicker {
  private devicesValue: RealtimeTalkInputDevice[] = [];
  private loadingValue = false;
  private openValue = false;
  private issueValue: RealtimeTalkDeviceIssue | null = null;
  private deviceWatch: (() => void) | null = null;
  private discoveryRequest = 0;

  constructor(private readonly requestUpdate: () => void) {}

  get devices(): RealtimeTalkInputDevice[] {
    return this.devicesValue;
  }

  get loading(): boolean {
    return this.loadingValue;
  }

  get open(): boolean {
    return this.openValue;
  }

  get issue(): RealtimeTalkDeviceIssue | null {
    return this.issueValue;
  }

  readonly handleOpen = (): void => {
    if (this.openValue) {
      return;
    }
    this.openValue = true;
    this.deviceWatch ??= observeRealtimeTalkDevices(this.discover);
    this.discover();
  };

  readonly handleClose = (): void => {
    if (!this.openValue) {
      return;
    }
    this.release();
    this.openValue = false;
    this.requestUpdate();
  };

  /** Drops the devicechange subscription so a closed picker stops refreshing. */
  release(): void {
    this.deviceWatch?.();
    this.deviceWatch = null;
  }

  /** Ends an in-flight discovery too, so a late result cannot revive the list. */
  dispose(): void {
    this.release();
    this.discoveryRequest++;
    this.openValue = false;
    this.loadingValue = false;
  }

  private readonly discover = (): void => {
    this.loadingValue = true;
    this.issueValue = null;
    const request = ++this.discoveryRequest;
    this.requestUpdate();
    // Permission-requesting discovery on every pass, including device changes:
    // a microphone that just appeared has hidden labels until the probe runs,
    // and the probe only prompts while the picker is the surface in front of
    // the user.
    void discoverRealtimeTalkInputs(true)
      .then((result) => {
        if (request !== this.discoveryRequest) {
          return;
        }
        this.devicesValue = result.devices;
        this.issueValue = result.issue;
      })
      .catch(() => {
        if (request !== this.discoveryRequest) {
          return;
        }
        this.devicesValue = [];
        this.issueValue = "failed";
      })
      .finally(() => {
        if (request !== this.discoveryRequest) {
          return;
        }
        this.loadingValue = false;
        this.requestUpdate();
      });
  };
}
