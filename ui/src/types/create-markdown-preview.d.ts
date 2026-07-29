// Control UI type declarations define create markdown preview contracts.
declare module "@create-markdown/preview" {
  export type PreviewThemeOptions = {
    sanitize?: ((html: string) => string) | undefined;
  };

  export function applyPreviewTheme(html: string, options?: PreviewThemeOptions): string;
}
