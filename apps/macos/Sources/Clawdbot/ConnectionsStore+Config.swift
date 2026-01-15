import ClawdbotProtocol
import Foundation

extension ConnectionsStore {
    var isTelegramTokenLocked: Bool {
        self.snapshot?.decodeChannel("telegram", as: ChannelsStatusSnapshot.TelegramStatus.self)?
            .tokenSource == "env"
    }

    var isDiscordTokenLocked: Bool {
        self.snapshot?.decodeChannel("discord", as: ChannelsStatusSnapshot.DiscordStatus.self)?
            .tokenSource == "env"
    }

    func loadConfig() async {
        do {
            let snap: ConfigSnapshot = try await GatewayConnection.shared.requestDecoded(
                method: .configGet,
                params: nil,
                timeoutMs: 10000)
            self.configStatus = snap.valid == false
                ? "Config invalid; fix it in ~/.clawdbot/clawdbot.json."
                : nil
            self.configRoot = snap.config?.mapValues { $0.foundationValue } ?? [:]
            self.configHash = snap.hash
            self.configLoaded = true

            self.applyUIConfig(snap)
            self.applyTelegramConfig(snap)
            self.applyDiscordConfig(snap)
            self.applySignalConfig(snap)
            self.applyIMessageConfig(snap)
        } catch {
            self.configStatus = error.localizedDescription
        }
    }

    private func applyUIConfig(_ snap: ConfigSnapshot) {
        let ui = snap.config?[
            "ui",
            ]?.dictionaryValue
        let rawSeam = ui?[
            "seamColor",
            ]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        AppStateStore.shared.seamColorHex = rawSeam.isEmpty ? nil : rawSeam
    }

    private func resolveChannelConfig(_ snap: ConfigSnapshot, key: String) -> [String: AnyCodable]? {
        if let channels = snap.config?["channels"]?.dictionaryValue,
           let entry = channels[key]?.dictionaryValue
        {
            return entry
        }
        return snap.config?[key]?.dictionaryValue
    }

    private func applyTelegramConfig(_ snap: ConfigSnapshot) {
        let telegram = self.resolveChannelConfig(snap, key: "telegram")
        self.telegramToken = telegram?["botToken"]?.stringValue ?? ""
        let groups = telegram?["groups"]?.dictionaryValue
        let defaultGroup = groups?["*"]?.dictionaryValue
        self.telegramRequireMention = defaultGroup?["requireMention"]?.boolValue
            ?? telegram?["requireMention"]?.boolValue
            ?? true
        self.telegramAllowFrom = self.stringList(from: telegram?["allowFrom"]?.arrayValue)
        self.telegramProxy = telegram?["proxy"]?.stringValue ?? ""
        self.telegramWebhookUrl = telegram?["webhookUrl"]?.stringValue ?? ""
        self.telegramWebhookSecret = telegram?["webhookSecret"]?.stringValue ?? ""
        self.telegramWebhookPath = telegram?["webhookPath"]?.stringValue ?? ""
    }

    private func applyDiscordConfig(_ snap: ConfigSnapshot) {
        let discord = self.resolveChannelConfig(snap, key: "discord")
        self.discordEnabled = discord?["enabled"]?.boolValue ?? true
        self.discordToken = discord?["token"]?.stringValue ?? ""

        let discordDm = discord?["dm"]?.dictionaryValue
        self.discordDmEnabled = discordDm?["enabled"]?.boolValue ?? true
        self.discordAllowFrom = self.stringList(from: discordDm?["allowFrom"]?.arrayValue)
        self.discordGroupEnabled = discordDm?["groupEnabled"]?.boolValue ?? false
        self.discordGroupChannels = self.stringList(from: discordDm?["groupChannels"]?.arrayValue)
        self.discordMediaMaxMb = self.numberString(from: discord?["mediaMaxMb"])
        self.discordHistoryLimit = self.numberString(from: discord?["historyLimit"])
        self.discordTextChunkLimit = self.numberString(from: discord?["textChunkLimit"])
        self.discordReplyToMode = self.replyMode(from: discord?["replyToMode"]?.stringValue)
        self.discordGuilds = self.decodeDiscordGuilds(discord?["guilds"]?.dictionaryValue)

        let discordActions = discord?["actions"]?.dictionaryValue
        self.discordActionReactions = discordActions?["reactions"]?.boolValue ?? true
        self.discordActionStickers = discordActions?["stickers"]?.boolValue ?? true
        self.discordActionPolls = discordActions?["polls"]?.boolValue ?? true
        self.discordActionPermissions = discordActions?["permissions"]?.boolValue ?? true
        self.discordActionMessages = discordActions?["messages"]?.boolValue ?? true
        self.discordActionThreads = discordActions?["threads"]?.boolValue ?? true
        self.discordActionPins = discordActions?["pins"]?.boolValue ?? true
        self.discordActionSearch = discordActions?["search"]?.boolValue ?? true
        self.discordActionMemberInfo = discordActions?["memberInfo"]?.boolValue ?? true
        self.discordActionRoleInfo = discordActions?["roleInfo"]?.boolValue ?? true
        self.discordActionChannelInfo = discordActions?["channelInfo"]?.boolValue ?? true
        self.discordActionVoiceStatus = discordActions?["voiceStatus"]?.boolValue ?? true
        self.discordActionEvents = discordActions?["events"]?.boolValue ?? true
        self.discordActionRoles = discordActions?["roles"]?.boolValue ?? false
        self.discordActionModeration = discordActions?["moderation"]?.boolValue ?? false

        let slash = discord?["slashCommand"]?.dictionaryValue
        self.discordSlashEnabled = slash?["enabled"]?.boolValue ?? false
        self.discordSlashName = slash?["name"]?.stringValue ?? ""
        self.discordSlashSessionPrefix = slash?["sessionPrefix"]?.stringValue ?? ""
        self.discordSlashEphemeral = slash?["ephemeral"]?.boolValue ?? true
    }

    private func decodeDiscordGuilds(_ guilds: [String: AnyCodable]?) -> [DiscordGuildForm] {
        guard let guilds else { return [] }
        return guilds
            .map { key, value in
                let entry = value.dictionaryValue ?? [:]
                let slug = entry["slug"]?.stringValue ?? ""
                let requireMention = entry["requireMention"]?.boolValue ?? false
                let reactionModeRaw = entry["reactionNotifications"]?.stringValue ?? ""
                let reactionNotifications = ["off", "own", "all", "allowlist"].contains(reactionModeRaw)
                    ? reactionModeRaw
                    : "own"
                let users = self.stringList(from: entry["users"]?.arrayValue)
                let channels: [DiscordGuildChannelForm] = if let channelMap = entry["channels"]?.dictionaryValue {
                    channelMap.map { channelKey, channelValue in
                        let channelEntry = channelValue.dictionaryValue ?? [:]
                        let allow = channelEntry["allow"]?.boolValue ?? true
                        let channelRequireMention = channelEntry["requireMention"]?.boolValue ?? false
                        return DiscordGuildChannelForm(
                            key: channelKey,
                            allow: allow,
                            requireMention: channelRequireMention)
                    }
                } else {
                    []
                }
                return DiscordGuildForm(
                    key: key,
                    slug: slug,
                    requireMention: requireMention,
                    reactionNotifications: reactionNotifications,
                    users: users,
                    channels: channels)
            }
            .sorted { $0.key < $1.key }
    }

    private func applySignalConfig(_ snap: ConfigSnapshot) {
        let signal = self.resolveChannelConfig(snap, key: "signal")
        self.signalEnabled = signal?["enabled"]?.boolValue ?? true
        self.signalAccount = signal?["account"]?.stringValue ?? ""
        self.signalHttpUrl = signal?["httpUrl"]?.stringValue ?? ""
        self.signalHttpHost = signal?["httpHost"]?.stringValue ?? ""
        self.signalHttpPort = self.numberString(from: signal?["httpPort"])
        self.signalCliPath = signal?["cliPath"]?.stringValue ?? ""
        self.signalAutoStart = signal?["autoStart"]?.boolValue ?? true
        self.signalReceiveMode = signal?["receiveMode"]?.stringValue ?? ""
        self.signalIgnoreAttachments = signal?["ignoreAttachments"]?.boolValue ?? false
        self.signalIgnoreStories = signal?["ignoreStories"]?.boolValue ?? false
        self.signalSendReadReceipts = signal?["sendReadReceipts"]?.boolValue ?? false
        self.signalAllowFrom = self.stringList(from: signal?["allowFrom"]?.arrayValue)
        self.signalMediaMaxMb = self.numberString(from: signal?["mediaMaxMb"])
    }

    private func applyIMessageConfig(_ snap: ConfigSnapshot) {
        let imessage = self.resolveChannelConfig(snap, key: "imessage")
        self.imessageEnabled = imessage?["enabled"]?.boolValue ?? true
        self.imessageCliPath = imessage?["cliPath"]?.stringValue ?? ""
        self.imessageDbPath = imessage?["dbPath"]?.stringValue ?? ""
        self.imessageService = imessage?["service"]?.stringValue ?? "auto"
        self.imessageRegion = imessage?["region"]?.stringValue ?? ""
        self.imessageAllowFrom = self.stringList(from: imessage?["allowFrom"]?.arrayValue)
        self.imessageIncludeAttachments = imessage?["includeAttachments"]?.boolValue ?? false
        self.imessageMediaMaxMb = self.numberString(from: imessage?["mediaMaxMb"])
    }

    private func channelConfigRoot(for key: String) -> [String: Any] {
        if let channels = self.configRoot["channels"] as? [String: Any],
           let entry = channels[key] as? [String: Any]
        {
            return entry
        }
        return self.configRoot[key] as? [String: Any] ?? [:]
    }

    func saveTelegramConfig() async {
        guard !self.isSavingConfig else { return }
        self.isSavingConfig = true
        defer { self.isSavingConfig = false }
        if !self.configLoaded {
            await self.loadConfig()
        }

        var telegram: [String: Any] = [:]
        if !self.isTelegramTokenLocked {
            self.setPatchString(&telegram, key: "botToken", value: self.telegramToken)
        }
        telegram["requireMention"] = NSNull()
        telegram["groups"] = [
            "*": [
                "requireMention": self.telegramRequireMention,
            ],
        ]
        let allow = self.splitCsv(self.telegramAllowFrom)
        self.setPatchList(&telegram, key: "allowFrom", values: allow)
        self.setPatchString(&telegram, key: "proxy", value: self.telegramProxy)
        self.setPatchString(&telegram, key: "webhookUrl", value: self.telegramWebhookUrl)
        self.setPatchString(&telegram, key: "webhookSecret", value: self.telegramWebhookSecret)
        self.setPatchString(&telegram, key: "webhookPath", value: self.telegramWebhookPath)

        await self.persistChannelPatch("telegram", payload: telegram)
    }

    func saveDiscordConfig() async {
        guard !self.isSavingConfig else { return }
        self.isSavingConfig = true
        defer { self.isSavingConfig = false }
        if !self.configLoaded {
            await self.loadConfig()
        }

        let base = self.channelConfigRoot(for: "discord")
        let discord = self.buildDiscordPatch(base: base)
        await self.persistChannelPatch("discord", payload: discord)
    }

    func saveSignalConfig() async {
        guard !self.isSavingConfig else { return }
        self.isSavingConfig = true
        defer { self.isSavingConfig = false }
        if !self.configLoaded {
            await self.loadConfig()
        }

        var signal: [String: Any] = [:]
        self.setPatchBool(&signal, key: "enabled", value: self.signalEnabled, defaultValue: true)
        self.setPatchString(&signal, key: "account", value: self.signalAccount)
        self.setPatchString(&signal, key: "httpUrl", value: self.signalHttpUrl)
        self.setPatchString(&signal, key: "httpHost", value: self.signalHttpHost)
        self.setPatchNumber(&signal, key: "httpPort", value: self.signalHttpPort)
        self.setPatchString(&signal, key: "cliPath", value: self.signalCliPath)
        self.setPatchBool(&signal, key: "autoStart", value: self.signalAutoStart, defaultValue: true)
        self.setPatchString(&signal, key: "receiveMode", value: self.signalReceiveMode)
        self.setPatchBool(&signal, key: "ignoreAttachments", value: self.signalIgnoreAttachments, defaultValue: false)
        self.setPatchBool(&signal, key: "ignoreStories", value: self.signalIgnoreStories, defaultValue: false)
        self.setPatchBool(&signal, key: "sendReadReceipts", value: self.signalSendReadReceipts, defaultValue: false)
        let allow = self.splitCsv(self.signalAllowFrom)
        self.setPatchList(&signal, key: "allowFrom", values: allow)
        self.setPatchNumber(&signal, key: "mediaMaxMb", value: self.signalMediaMaxMb)

        await self.persistChannelPatch("signal", payload: signal)
    }

    func saveIMessageConfig() async {
        guard !self.isSavingConfig else { return }
        self.isSavingConfig = true
        defer { self.isSavingConfig = false }
        if !self.configLoaded {
            await self.loadConfig()
        }

        var imessage: [String: Any] = [:]
        self.setPatchBool(&imessage, key: "enabled", value: self.imessageEnabled, defaultValue: true)
        self.setPatchString(&imessage, key: "cliPath", value: self.imessageCliPath)
        self.setPatchString(&imessage, key: "dbPath", value: self.imessageDbPath)

        let service = self.trimmed(self.imessageService)
        if service.isEmpty || service == "auto" {
            imessage["service"] = NSNull()
        } else {
            imessage["service"] = service
        }

        self.setPatchString(&imessage, key: "region", value: self.imessageRegion)

        let allow = self.splitCsv(self.imessageAllowFrom)
        self.setPatchList(&imessage, key: "allowFrom", values: allow)

        self.setPatchBool(
            &imessage,
            key: "includeAttachments",
            value: self.imessageIncludeAttachments,
            defaultValue: false)
        self.setPatchNumber(&imessage, key: "mediaMaxMb", value: self.imessageMediaMaxMb)

        await self.persistChannelPatch("imessage", payload: imessage)
    }

    private func buildDiscordPatch(base: [String: Any]) -> [String: Any] {
        var discord: [String: Any] = [:]
        self.setPatchBool(&discord, key: "enabled", value: self.discordEnabled, defaultValue: true)
        if !self.isDiscordTokenLocked {
            self.setPatchString(&discord, key: "token", value: self.discordToken)
        }

        if let dm = self.buildDiscordDmPatch() {
            discord["dm"] = dm
        } else {
            discord["dm"] = NSNull()
        }

        self.setPatchNumber(&discord, key: "mediaMaxMb", value: self.discordMediaMaxMb)
        self.setPatchInt(&discord, key: "historyLimit", value: self.discordHistoryLimit, allowZero: true)
        self.setPatchInt(&discord, key: "textChunkLimit", value: self.discordTextChunkLimit, allowZero: false)

        let replyToMode = self.trimmed(self.discordReplyToMode)
        if replyToMode.isEmpty || replyToMode == "off" || !["first", "all"].contains(replyToMode) {
            discord["replyToMode"] = NSNull()
        } else {
            discord["replyToMode"] = replyToMode
        }

        let baseGuilds = base["guilds"] as? [String: Any] ?? [:]
        if let guilds = self.buildDiscordGuildsPatch(base: baseGuilds) {
            discord["guilds"] = guilds
        } else {
            discord["guilds"] = NSNull()
        }

        if let actions = self.buildDiscordActionsPatch() {
            discord["actions"] = actions
        } else {
            discord["actions"] = NSNull()
        }

        if let slash = self.buildDiscordSlashPatch() {
            discord["slashCommand"] = slash
        } else {
            discord["slashCommand"] = NSNull()
        }

        return discord
    }

    private func buildDiscordDmPatch() -> [String: Any]? {
        var dm: [String: Any] = [:]
        self.setPatchBool(&dm, key: "enabled", value: self.discordDmEnabled, defaultValue: true)
        let allow = self.splitCsv(self.discordAllowFrom)
        self.setPatchList(&dm, key: "allowFrom", values: allow)
        self.setPatchBool(&dm, key: "groupEnabled", value: self.discordGroupEnabled, defaultValue: false)
        let groupChannels = self.splitCsv(self.discordGroupChannels)
        self.setPatchList(&dm, key: "groupChannels", values: groupChannels)
        return dm.isEmpty ? nil : dm
    }

    private func buildDiscordGuildsPatch(base: [String: Any]) -> Any? {
        if self.discordGuilds.isEmpty {
            return NSNull()
        }
        var patch: [String: Any] = [:]
        let baseKeys = Set(base.keys)
        var formKeys = Set<String>()
        for entry in self.discordGuilds {
            let key = self.trimmed(entry.key)
            guard !key.isEmpty else { continue }
            formKeys.insert(key)
            let baseGuild = base[key] as? [String: Any] ?? [:]
            patch[key] = self.buildDiscordGuildPatch(entry, base: baseGuild)
        }
        for key in baseKeys.subtracting(formKeys) {
            patch[key] = NSNull()
        }
        return patch.isEmpty ? NSNull() : patch
    }

    private func buildDiscordGuildPatch(_ entry: DiscordGuildForm, base: [String: Any]) -> [String: Any] {
        var payload: [String: Any] = [:]
        let slug = self.trimmed(entry.slug)
        if slug.isEmpty {
            payload["slug"] = NSNull()
        } else {
            payload["slug"] = slug
        }
        if entry.requireMention {
            payload["requireMention"] = true
        } else {
            payload["requireMention"] = NSNull()
        }
        if ["off", "all", "allowlist"].contains(entry.reactionNotifications) {
            payload["reactionNotifications"] = entry.reactionNotifications
        } else {
            payload["reactionNotifications"] = NSNull()
        }
        let users = self.splitCsv(entry.users)
        self.setPatchList(&payload, key: "users", values: users)

        let baseChannels = base["channels"] as? [String: Any] ?? [:]
        if let channels = self.buildDiscordChannelsPatch(base: baseChannels, forms: entry.channels) {
            payload["channels"] = channels
        } else {
            payload["channels"] = NSNull()
        }
        return payload
    }

    private func buildDiscordChannelsPatch(base: [String: Any], forms: [DiscordGuildChannelForm]) -> Any? {
        if forms.isEmpty {
            return NSNull()
        }
        var patch: [String: Any] = [:]
        let baseKeys = Set(base.keys)
        var formKeys = Set<String>()
        for channel in forms {
            let channelKey = self.trimmed(channel.key)
            guard !channelKey.isEmpty else { continue }
            formKeys.insert(channelKey)
            var channelPayload: [String: Any] = [:]
            self.setPatchBool(&channelPayload, key: "allow", value: channel.allow, defaultValue: true)
            self.setPatchBool(
                &channelPayload,
                key: "requireMention",
                value: channel.requireMention,
                defaultValue: false)
            patch[channelKey] = channelPayload
        }
        for key in baseKeys.subtracting(formKeys) {
            patch[key] = NSNull()
        }
        return patch.isEmpty ? NSNull() : patch
    }

    private func buildDiscordActionsPatch() -> [String: Any]? {
        var actions: [String: Any] = [:]
        self.setAction(&actions, key: "reactions", value: self.discordActionReactions, defaultValue: true)
        self.setAction(&actions, key: "stickers", value: self.discordActionStickers, defaultValue: true)
        self.setAction(&actions, key: "polls", value: self.discordActionPolls, defaultValue: true)
        self.setAction(&actions, key: "permissions", value: self.discordActionPermissions, defaultValue: true)
        self.setAction(&actions, key: "messages", value: self.discordActionMessages, defaultValue: true)
        self.setAction(&actions, key: "threads", value: self.discordActionThreads, defaultValue: true)
        self.setAction(&actions, key: "pins", value: self.discordActionPins, defaultValue: true)
        self.setAction(&actions, key: "search", value: self.discordActionSearch, defaultValue: true)
        self.setAction(&actions, key: "memberInfo", value: self.discordActionMemberInfo, defaultValue: true)
        self.setAction(&actions, key: "roleInfo", value: self.discordActionRoleInfo, defaultValue: true)
        self.setAction(&actions, key: "channelInfo", value: self.discordActionChannelInfo, defaultValue: true)
        self.setAction(&actions, key: "voiceStatus", value: self.discordActionVoiceStatus, defaultValue: true)
        self.setAction(&actions, key: "events", value: self.discordActionEvents, defaultValue: true)
        self.setAction(&actions, key: "roles", value: self.discordActionRoles, defaultValue: false)
        self.setAction(&actions, key: "moderation", value: self.discordActionModeration, defaultValue: false)
        return actions.isEmpty ? nil : actions
    }

    private func buildDiscordSlashPatch() -> [String: Any]? {
        var slash: [String: Any] = [:]
        self.setPatchBool(&slash, key: "enabled", value: self.discordSlashEnabled, defaultValue: false)
        self.setPatchString(&slash, key: "name", value: self.discordSlashName)
        self.setPatchString(&slash, key: "sessionPrefix", value: self.discordSlashSessionPrefix)
        self.setPatchBool(&slash, key: "ephemeral", value: self.discordSlashEphemeral, defaultValue: true)
        return slash.isEmpty ? nil : slash
    }

    private func persistChannelPatch(_ channelId: String, payload: [String: Any]) async {
        do {
            guard let baseHash = self.configHash else {
                self.configStatus = "Config hash missing; reload and retry."
                return
            }
            let data = try JSONSerialization.data(
                withJSONObject: ["channels": [channelId: payload]],
                options: [.prettyPrinted, .sortedKeys])
            guard let raw = String(data: data, encoding: .utf8) else {
                self.configStatus = "Failed to encode config."
                return
            }
            let params: [String: AnyCodable] = [
                "raw": AnyCodable(raw),
                "baseHash": AnyCodable(baseHash),
            ]
            _ = try await GatewayConnection.shared.requestRaw(
                method: .configPatch,
                params: params,
                timeoutMs: 10000)
            self.configStatus = "Saved to ~/.clawdbot/clawdbot.json."
            await self.loadConfig()
            await self.refresh(probe: true)
        } catch {
            self.configStatus = error.localizedDescription
        }
    }

    private func stringList(from values: [AnyCodable]?) -> String {
        guard let values else { return "" }
        let strings = values.compactMap { entry -> String? in
            if let str = entry.stringValue { return str }
            if let intVal = entry.intValue { return String(intVal) }
            if let doubleVal = entry.doubleValue { return String(Int(doubleVal)) }
            return nil
        }
        return strings.joined(separator: ", ")
    }

    private func numberString(from value: AnyCodable?) -> String {
        if let number = value?.doubleValue ?? value?.intValue.map(Double.init) {
            return String(Int(number))
        }
        return ""
    }

    private func replyMode(from value: String?) -> String {
        if let value, ["off", "first", "all"].contains(value) {
            return value
        }
        return "off"
    }

    private func splitCsv(_ value: String) -> [String] {
        value
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
    }

    private func trimmed(_ value: String) -> String {
        value.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func setPatchString(_ target: inout [String: Any], key: String, value: String) {
        let trimmed = self.trimmed(value)
        if trimmed.isEmpty {
            target[key] = NSNull()
        } else {
            target[key] = trimmed
        }
    }

    private func setPatchNumber(_ target: inout [String: Any], key: String, value: String) {
        let trimmed = self.trimmed(value)
        if trimmed.isEmpty {
            target[key] = NSNull()
            return
        }
        if let number = Double(trimmed) {
            target[key] = number
        } else {
            target[key] = NSNull()
        }
    }

    private func setPatchInt(
        _ target: inout [String: Any],
        key: String,
        value: String,
        allowZero: Bool)
    {
        let trimmed = self.trimmed(value)
        if trimmed.isEmpty {
            target[key] = NSNull()
            return
        }
        guard let number = Int(trimmed) else {
            target[key] = NSNull()
            return
        }
        let isValid = allowZero ? number >= 0 : number > 0
        guard isValid else {
            target[key] = NSNull()
            return
        }
        target[key] = number
    }

    private func setPatchBool(
        _ target: inout [String: Any],
        key: String,
        value: Bool,
        defaultValue: Bool)
    {
        if value == defaultValue {
            target[key] = NSNull()
        } else {
            target[key] = value
        }
    }

    private func setPatchList(_ target: inout [String: Any], key: String, values: [String]) {
        if values.isEmpty {
            target[key] = NSNull()
        } else {
            target[key] = values
        }
    }

    private func setAction(
        _ actions: inout [String: Any],
        key: String,
        value: Bool,
        defaultValue: Bool)
    {
        if value == defaultValue {
            actions[key] = NSNull()
        } else {
            actions[key] = value
        }
    }
}
