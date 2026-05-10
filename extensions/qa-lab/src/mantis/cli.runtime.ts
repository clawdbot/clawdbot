import {
  runMantisDesktopBrowserSmoke,
  type MantisDesktopBrowserSmokeOptions,
} from "./desktop-browser-smoke.runtime.js";
import { runMantisDiscordSmoke, type MantisDiscordSmokeOptions } from "./discord-smoke.runtime.js";
import { runMantisBeforeAfter, type MantisBeforeAfterOptions } from "./run.runtime.js";
import {
  runMantisSlackDesktopSmoke,
  type MantisSlackDesktopSmokeOptions,
} from "./slack-desktop-smoke.runtime.js";
import {
  runMantisTelegramDesktopBuilder,
  type MantisTelegramDesktopBuilderOptions,
} from "./telegram-desktop-builder.runtime.js";
import {
  runMantisVisualDriver,
  runMantisVisualTask,
  type MantisVisualDriverOptions,
  type MantisVisualTaskOptions,
} from "./visual-task.runtime.js";

export async function runMantisDiscordSmokeCommand(opts: MantisDiscordSmokeOptions) {
  const result = await runMantisDiscordSmoke(opts);
  process.stdout.write(`Mantis Discord smoke report: ${result.reportPath}\n`);
  process.stdout.write(`Mantis Discord smoke summary: ${result.summaryPath}\n`);
  if (result.status === "fail") {
    process.exitCode = 1;
  }
}

export async function runMantisBeforeAfterCommand(opts: MantisBeforeAfterOptions) {
  const result = await runMantisBeforeAfter(opts);
  process.stdout.write(`Mantis before/after report: ${result.reportPath}\n`);
  process.stdout.write(`Mantis before/after comparison: ${result.comparisonPath}\n`);
  if (result.status === "fail") {
    process.exitCode = 1;
  }
}

export async function runMantisDesktopBrowserSmokeCommand(opts: MantisDesktopBrowserSmokeOptions) {
  const result = await runMantisDesktopBrowserSmoke(opts);
  process.stdout.write(`Mantis desktop browser report: ${result.reportPath}\n`);
  process.stdout.write(`Mantis desktop browser summary: ${result.summaryPath}\n`);
  if (result.screenshotPath) {
    process.stdout.write(`Mantis desktop browser screenshot: ${result.screenshotPath}\n`);
  }
  if (result.videoPath) {
    process.stdout.write(`Mantis desktop browser video: ${result.videoPath}\n`);
  }
  if (result.status === "fail") {
    process.exitCode = 1;
  }
}

export async function runMantisSlackDesktopSmokeCommand(opts: MantisSlackDesktopSmokeOptions) {
  const result = await runMantisSlackDesktopSmoke(opts);
  process.stdout.write(`Mantis Slack desktop report: ${result.reportPath}\n`);
  process.stdout.write(`Mantis Slack desktop summary: ${result.summaryPath}\n`);
  if (result.screenshotPath) {
    process.stdout.write(`Mantis Slack desktop screenshot: ${result.screenshotPath}\n`);
  }
  if (result.videoPath) {
    process.stdout.write(`Mantis Slack desktop video: ${result.videoPath}\n`);
  }
  if (result.status === "fail") {
    process.exitCode = 1;
  }
}

export async function runMantisTelegramDesktopBuilderCommand(
  opts: MantisTelegramDesktopBuilderOptions,
) {
  const result = await runMantisTelegramDesktopBuilder(opts);
  process.stdout.write(`Mantis Telegram desktop builder report: ${result.reportPath}\n`);
  process.stdout.write(`Mantis Telegram desktop builder summary: ${result.summaryPath}\n`);
  if (result.screenshotPath) {
    process.stdout.write(`Mantis Telegram desktop builder screenshot: ${result.screenshotPath}\n`);
  }
  if (result.videoPath) {
    process.stdout.write(`Mantis Telegram desktop builder video: ${result.videoPath}\n`);
  }
  if (result.status === "fail") {
    process.exitCode = 1;
  }
}

export async function runMantisVisualDriverCommand(opts: MantisVisualDriverOptions) {
  const result = await runMantisVisualDriver(opts);
  process.stdout.write(`Mantis visual driver result: ${result.status}\n`);
  process.stdout.write(`Mantis visual driver screenshot: ${result.screenshotPath}\n`);
  if (result.status === "fail") {
    process.exitCode = 1;
  }
}

export async function runMantisVisualTaskCommand(opts: MantisVisualTaskOptions) {
  const result = await runMantisVisualTask(opts);
  process.stdout.write(`Mantis visual task report: ${result.reportPath}\n`);
  process.stdout.write(`Mantis visual task summary: ${result.summaryPath}\n`);
  if (result.screenshotPath) {
    process.stdout.write(`Mantis visual task screenshot: ${result.screenshotPath}\n`);
  }
  if (result.videoPath) {
    process.stdout.write(`Mantis visual task video: ${result.videoPath}\n`);
  }
  if (result.status === "fail") {
    process.exitCode = 1;
  }
}
