import type { ReactiveController, ReactiveControllerHost } from "lit";

export class TestReactiveControllerHost implements ReactiveControllerHost {
  readonly updateComplete = Promise.resolve(true);
  addController(_controller: ReactiveController) {}
  removeController(_controller: ReactiveController) {}
  requestUpdate() {}
}
