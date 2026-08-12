/** Platform-specific next steps for preparing a loopback-only host VNC server. */
const HOST_DESKTOP_GUIDANCE = {
  darwin:
    "Enable System Settings -> General -> Sharing -> Screen Sharing, or run `sudo launchctl enable system/com.apple.screensharing && sudo launchctl kickstart -k system/com.apple.screensharing`.",
  linux:
    "Install TigerVNC with `apt install tigervnc-standalone-server` and run it loopback-only on port 5900, or run `x11vnc -display :0 -localhost -rfbport 5900 -forever -passwdfile <file>`. gnome-remote-desktop uses unsupported VeNCrypt.",
  win32:
    "Install TightVNC with `SET_USEVNCAUTHENTICATION=1 SET_ALLOWLOOPBACK=1 ACCEPTHTTPCONNECTIONS=0` and listen on 127.0.0.1:5900. Locked or UAC sessions may render black.",
} as const;

type HostDesktopPlatform = keyof typeof HOST_DESKTOP_GUIDANCE;

/** Resolves guidance for supported gateway platforms, falling back to Linux-style setup. */
export function getHostDesktopGuidance(platform: NodeJS.Platform): string {
  return HOST_DESKTOP_GUIDANCE[platform as HostDesktopPlatform] ?? HOST_DESKTOP_GUIDANCE.linux;
}
