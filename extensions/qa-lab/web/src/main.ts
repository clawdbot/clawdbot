import "./styles.css";
import { createQaLabApp } from "./app.js";

const root = document.querySelector<HTMLDivElement>("#app");

if (!root) {
  throw new Error("QA Lab app root missing");
}

void createQaLabApp(root);
