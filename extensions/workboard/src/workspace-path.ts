// Workboard paths accept POSIX, drive-letter, and UNC absolute forms.
export function isAbsoluteWorkspacePath(value: string): boolean {
  return (
    value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value)
  );
}
