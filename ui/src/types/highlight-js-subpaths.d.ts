declare module "highlight.js/lib/core.js" {
  import hljs = require("highlight.js");

  export default hljs;
}

declare module "highlight.js/lib/languages/*.js" {
  export default function language(hljs?: HLJSApi): LanguageDetail;
}
