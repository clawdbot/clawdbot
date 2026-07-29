// Media files remain readable by sandbox container UIDs; the private media
// directory is the trust boundary. Temp and final writes must use one mode.
export const MEDIA_FILE_MODE = 0o644;

export function formatMediaLimitMb(maxBytes: number): string {
  return `${(maxBytes / (1024 * 1024)).toFixed(0)}MB`;
}
