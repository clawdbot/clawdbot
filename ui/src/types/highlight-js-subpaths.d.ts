declare module "highlight.js/lib/core" {
  import hljs from "highlight.js/lib/core";

  export default hljs;
}

declare module "highlight.js/lib/languages/*" {
  import type { LanguageFn } from "highlight.js";

  const language: LanguageFn;
  export default language;
}
