declare module "markdown-it-footnote" {
  import type MarkdownIt from "markdown-it";

  const markdownItFootnote: (md: MarkdownIt) => void;

  export default markdownItFootnote;
}
