import { QuestionPage } from "./question-page.ts";

if (!customElements.get("openclaw-question-page")) {
  customElements.define("openclaw-question-page", QuestionPage);
}
