export {
  COMPUTER_USE_V2_ACTION_NAMES,
  ComputerActParamsSchema,
  ComputerActResultSchema,
  ComputerUseCapabilityDescriptorSchema,
  ScreenSnapshotParamsSchema,
  ScreenSnapshotResultSchema,
  compileComputerUseValidator,
  parseComputerActParamsJSON,
  parseScreenSnapshotParamsJSON,
  registerComputerUseProvider,
} from "../plugins/computer-use-contract.js";
export type {
  ComputerActParams,
  ComputerActResult,
  ComputerUseCapabilityDescriptor,
  ComputerUseProvider,
  ComputerUseV2ActionName,
  ScreenSnapshotParams,
  ScreenSnapshotResult,
} from "../plugins/computer-use-contract.js";
