import { loadAndMaybeMigrateDoctorConfig } from "../src/commands/doctor-config-flow.js";
import { replaceConfigFile } from "../src/config/config.js";

const result = await loadAndMaybeMigrateDoctorConfig({
  options: {
    nonInteractive: true,
    repair: true,
    yes: true,
  },
  confirm: async () => false,
});

if (result.shouldWriteConfig) {
  await replaceConfigFile({ nextConfig: result.cfg });
}
