/** Ambient types for the create-markdown preview package used by docs rendering. */
declare module "@create-markdown/preview" {
  /** Theme options accepted by the preview renderer. */
  export type PreviewThemeOptions = {
    sanitize?: ((html: string) => string) | undefined;
  };

  /** Apply the package's preview theme to an HTML string. */
  export function applyPreviewTheme(html: string, options?: PreviewThemeOptions): string;
}
