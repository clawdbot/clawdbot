export function createAcpTaskBackingDetailForTest(
  instanceId: string,
  generation = 1,
): {
  kind: "task_backing_instance";
  runtime: "acp";
  instanceId: string;
  generation: number;
} {
  return { kind: "task_backing_instance", runtime: "acp", instanceId, generation };
}
