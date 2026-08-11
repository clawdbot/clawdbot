import type { LocalizationCatalog } from "@openclaw/localization-core";

export const CLI_ZH_CN_CATALOG = {
  "cli.update.dryRun.heading": "更新试运行",
  "cli.update.dryRun.noChanges": "未应用任何更改。",
  "cli.update.dryRun.root": "根目录",
  "cli.update.dryRun.installKind": "安装类型",
  "cli.update.dryRun.mode": "模式",
  "cli.update.dryRun.channel": "更新通道",
  "cli.update.dryRun.tagSpec": "标签/规格",
  "cli.update.dryRun.currentVersion": "当前版本",
  "cli.update.dryRun.targetVersion": "目标版本",
  "cli.update.dryRun.downgradeWarning": "实际运行时需要确认降级。",
  "cli.update.dryRun.plannedActions": "计划操作：",
  "cli.update.dryRun.notes": "说明：",
  "cli.update.dryRun.action.persistChannel": "在配置中保存 update.channel={channel}",
  "cli.update.dryRun.action.switchToGit": "将安装模式从软件包切换为 git 检出（dev 通道）",
  "cli.update.dryRun.action.switchToPackage": "将安装模式从 git 切换为软件包管理器（{mode}）",
  "cli.update.dryRun.action.gitUpdate":
    "在 {channel} 通道运行 git 更新流程（fetch/rebase/build/doctor）",
  "cli.update.dryRun.action.refreshPackage":
    "使用规格 {spec} 刷新软件包安装；当前版本已匹配 {version}",
  "cli.update.dryRun.action.packageUpdate": "使用规格 {spec} 运行全局软件包管理器更新",
  "cli.update.dryRun.action.plugins": "核心更新后运行插件更新同步",
  "cli.update.dryRun.action.completion": "刷新 shell 补全缓存（如需要）",
  "cli.update.dryRun.action.restart": "重启网关服务并运行 doctor 检查",
  "cli.update.dryRun.action.noRestart": "跳过重启（因为设置了 --no-restart）",
  "cli.update.dryRun.note.gitTag": "--tag 仅适用于 npm 安装；git 更新会忽略它。",
  "cli.update.dryRun.note.betaFallback": "本次运行中 beta 通道解析为 latest（回退）。",
  "cli.update.dryRun.note.managedRootTarget": "以托管网关服务软件包根目录为目标：{root}",
  "cli.update.dryRun.note.managedRootDiffers":
    "Shell OpenClaw 根目录与托管网关服务根目录不同：{previousRoot}",
  "cli.update.dryRun.note.managedRootReconcile":
    "更新后，请确保 PATH 中的 `{cli}` 解析到托管服务根目录，或从要使用的 shell 安装重新安装网关服务。",
  "cli.update.dryRun.note.managedNode": "托管网关服务 Node：{node}",
  "cli.update.dryRun.note.managedNodeDiffers":
    "当前 Node（{currentNode}）与托管网关服务 Node（{managedNode}）不同。",
  "cli.update.dryRun.note.managedNodeUse": "此次更新将使用托管服务 Node，以便网关在升级后启动。",
  "cli.update.dryRun.note.schemaIncompatible":
    "将拒绝更新：{kind} 数据库 {path} 的架构版本为 {foundVersion}；目标支持 {supportedVersion}；写入版本为 {writerVersion}。",
  "cli.update.dryRun.note.schemaIncompatibleAgent":
    "将拒绝更新：{kind} 数据库（代理 {agentId}）{path} 的架构版本为 {foundVersion}；目标支持 {supportedVersion}；写入版本为 {writerVersion}。",
  "cli.update.dryRun.note.schemaIndeterminate":
    "将拒绝更新：无法检查 {kind} 数据库 {path}：{reason}；请在网关释放后重试。",
  "cli.update.dryRun.note.schemaDocs": "{url}",
  "cli.update.dryRun.note.schemaManualInstall":
    "通过 npm 手动安装会绕过此保护；请先备份并验证兼容性。",
  "cli.update.dryRun.note.nonRegistry": "非注册表软件包规格会跳过 npm 版本查询和降级预览。",
  "cli.update.dryRun.note.gitSchemaCheck":
    "git 目标的数据库架构兼容性会在实际更新时验证；此预览不会检查。",
} as const satisfies LocalizationCatalog;
