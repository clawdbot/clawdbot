import { css } from "lit";

/**
 * Canonical scrollbar profile for OpenClaw Lit shadow roots (terminal, browser,
 * desktop panels): base.css's ::-webkit-scrollbar rules don't cross a shadow
 * boundary, so every shadow scroll surface includes this in `static styles`.
 */
export const scrollbarShadowStyles = css`
  * {
    scrollbar-width: thin;
  }

  ::-webkit-scrollbar {
    width: var(--scrollbar-size);
    height: var(--scrollbar-size);
  }

  ::-webkit-scrollbar-track,
  ::-webkit-scrollbar-corner {
    background: transparent;
  }

  ::-webkit-scrollbar-thumb {
    background: var(--scrollbar-thumb);
    background-clip: content-box;
    border: var(--scrollbar-thumb-inset) solid transparent;
    border-radius: var(--radius-full);
  }

  ::-webkit-scrollbar-thumb:hover,
  :hover::-webkit-scrollbar-thumb {
    background: var(--scrollbar-thumb-hover);
    background-clip: content-box;
  }
`;
