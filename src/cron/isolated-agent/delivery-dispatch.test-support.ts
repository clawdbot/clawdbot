import "./delivery-dispatch.js";

type CronDeliveryDispatchTestApi = {
  resetCompletedDirectCronDeliveriesForTests(): void;
  getCompletedDirectCronDeliveriesCountForTests(): number;
};

function getTestApi(): CronDeliveryDispatchTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.cronDeliveryDispatchTestApi")
  ] as CronDeliveryDispatchTestApi;
}

export function resetCompletedDirectCronDeliveriesForTests(): void {
  getTestApi().resetCompletedDirectCronDeliveriesForTests();
}

export function getCompletedDirectCronDeliveriesCountForTests(): number {
  return getTestApi().getCompletedDirectCronDeliveriesCountForTests();
}
