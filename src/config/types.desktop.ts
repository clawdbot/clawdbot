// Defines the experimental gateway-host desktop source configuration.

export type DesktopHostConfig = {
  /** Enables the gateway-host desktop source after a gateway restart. */
  enabled: boolean;
  /** Runs a gateway-supervised headless TigerVNC/XFCE desktop on Linux. */
  managed?: boolean;
  /** Loopback RFB port of an already-running VNC server (default: 5900). */
  port?: number;
  /** Absolute VNC password-file path; macOS ARD account credentials stay per-observation. */
  passwordFile?: string;
};

export type DesktopConfig = {
  /** Experimental Labs gate for observing the gateway host desktop. */
  host?: DesktopHostConfig;
};
