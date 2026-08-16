// Microsoft Teams monitor tests inject a durable-ingress boundary without ambient state.
import { vi } from "vitest";
import type { Mock } from "vitest";

type IngressDispatch = (
  activity: unknown,
  lifecycle: unknown,
  context?: unknown,
) => Promise<unknown>;

const ingressMockState = vi.hoisted(() => ({
  instances: [] as Array<{
    accept: Mock<(activity: unknown, context?: unknown) => Promise<void>>;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    options: { dispatch: IngressDispatch };
  }>,
}));

export function getMSTeamsIngressMockState() {
  return ingressMockState;
}

vi.mock("./msteams-ingress.js", () => ({
  createMSTeamsIngress: (options: { dispatch: IngressDispatch }) => {
    const lifecycle = {
      abortSignal: new AbortController().signal,
      onAdopted: vi.fn(),
      onDeferred: vi.fn(),
      onAdoptionFinalizing: vi.fn(),
      onAbandoned: vi.fn(),
    };
    const instance = {
      accept: vi.fn(async (activity: unknown, context?: unknown) => {
        void options.dispatch(activity, lifecycle, context).catch(() => undefined);
      }),
      start: vi.fn(),
      stop: vi.fn(async () => {}),
      options,
    };
    ingressMockState.instances.push(instance);
    return instance;
  },
}));

/** Gate accept on a promise, then fire dispatch detached with a stub lifecycle. */
export function gateIngressAcceptThenDispatch(
  ingress: ReturnType<typeof getMSTeamsIngressMockState>["instances"][number],
  appendWork: Promise<void>,
): void {
  ingress.accept.mockImplementationOnce(async (activity: unknown, context?: unknown) => {
    await appendWork;
    void Promise.resolve(
      ingress.options.dispatch(
        activity,
        {
          abortSignal: new AbortController().signal,
          onAdopted: vi.fn(),
          onDeferred: vi.fn(),
          onAdoptionFinalizing: vi.fn(),
          onAbandoned: vi.fn(),
        },
        context,
      ),
    ).catch(() => undefined);
  });
}
