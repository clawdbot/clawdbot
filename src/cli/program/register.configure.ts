import type { Command } from "commander";
import {
  CONFIGURE_WIZARD_SECTIONS,
  configureCommand,
  configureCommandWithSections,
} from "../../commands/configure.js";
import { defaultRuntime } from "../../runtime.js";

export function registerConfigureCommand(program: Command) {
  const register = (name: "configure" | "config") => {
    program
      .command(name)
      .description(
        name === "config"
          ? "Alias for `clawdbot configure`"
          : "Interactive prompt to set up credentials, devices, and agent defaults",
      )
      .option(
        "--section <section>",
        `Configuration sections (repeatable). Options: ${CONFIGURE_WIZARD_SECTIONS.join(", ")}`,
        (value: string, previous: string[]) => [...previous, value],
        [] as string[],
      )
      .action(async (opts) => {
        try {
          const sections: string[] = Array.isArray(opts.section)
            ? opts.section
                .map((value: unknown) =>
                  typeof value === "string" ? value.trim() : "",
                )
                .filter(Boolean)
            : [];
          if (sections.length === 0) {
            await configureCommand(defaultRuntime);
            return;
          }

          const invalid = sections.filter(
            (s) => !CONFIGURE_WIZARD_SECTIONS.includes(s as never),
          );
          if (invalid.length > 0) {
            defaultRuntime.error(
              `Invalid --section: ${invalid.join(", ")}. Expected one of: ${CONFIGURE_WIZARD_SECTIONS.join(", ")}.`,
            );
            defaultRuntime.exit(1);
            return;
          }

          await configureCommandWithSections(sections as never, defaultRuntime);
        } catch (err) {
          defaultRuntime.error(String(err));
          defaultRuntime.exit(1);
        }
      });
  };

  register("configure");
  register("config");
}
