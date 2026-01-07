import ClawdbotProtocol
import Foundation

extension ConnectionsStore {
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
            self.configLoaded = true

            self.applyUIConfig(snap)
            self.applyTelegramConfig(snap)
            self.applyDiscordConfig(snap)
            self.applyMatrixConfig(snap)
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

    private func applyTelegramConfig(_ snap: ConfigSnapshot) {
        let telegram = snap.config?["telegram"]?.dictionaryValue
        self.telegramToken = telegram?["botToken"]?.stringValue ?? ""
        self.telegramRequireMention = telegram?["requireMention"]?.boolValue ?? true
        self.telegramAllowFrom = self.stringList(from: telegram?["allowFrom"]?.arrayValue)
        self.telegramProxy = telegram?["proxy"]?.stringValue ?? ""
        self.telegramWebhookUrl = telegram?["webhookUrl"]?.stringValue ?? ""
        self.telegramWebhookSecret = telegram?["webhookSecret"]?.stringValue ?? ""
        self.telegramWebhookPath = telegram?["webhookPath"]?.stringValue ?? ""
    }

    private func applyDiscordConfig(_ snap: ConfigSnapshot) {
        let discord = snap.config?["discord"]?.dictionaryValue
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

    private func applyMatrixConfig(_ snap: ConfigSnapshot) {
        let matrix = snap.config?["matrix"]?.dictionaryValue
        self.matrixEnabled = matrix?["enabled"]?.boolValue ?? true
        self.matrixHomeserver = matrix?["homeserver"]?.stringValue ?? ""
        self.matrixUserId = matrix?["userId"]?.stringValue ?? ""
        self.matrixAccessToken = matrix?["accessToken"]?.stringValue ?? ""
        self.matrixPassword = matrix?["password"]?.stringValue ?? ""
        self.matrixDeviceId = matrix?["deviceId"]?.stringValue ?? ""
        self.matrixDeviceName = matrix?["deviceName"]?.stringValue ?? ""
        self.matrixEncryption = matrix?["encryption"]?.boolValue ?? true

        let autoJoin = matrix?["autoJoin"]?.stringValue ?? "always"
        self.matrixAutoJoin = ["always", "allowlist", "off"].contains(autoJoin)
            ? autoJoin
            : "always"
        self.matrixAutoJoinAllowlist = self.stringList(from: matrix?["autoJoinAllowlist"]?.arrayValue)

        let groupPolicy = matrix?["groupPolicy"]?.stringValue ?? "open"
        self.matrixGroupPolicy = ["open", "allowlist", "disabled"].contains(groupPolicy)
            ? groupPolicy
            : "open"
        self.matrixAllowlistOnly = matrix?["allowlistOnly"]?.boolValue ?? false

        let dm = matrix?["dm"]?.dictionaryValue
        self.matrixDmEnabled = dm?["enabled"]?.boolValue ?? true
        let dmPolicy = dm?["policy"]?.stringValue ?? "pairing"
        self.matrixDmPolicy = ["pairing", "allowlist", "open", "disabled"].contains(dmPolicy)
            ? dmPolicy
            : "pairing"
        self.matrixDmAllowFrom = self.stringList(from: dm?["allowFrom"]?.arrayValue)

        self.matrixTextChunkLimit = self.numberString(from: matrix?["textChunkLimit"])
        self.matrixMediaMaxMb = self.numberString(from: matrix?["mediaMaxMb"])
        self.matrixReplyToMode = self.replyMode(from: matrix?["replyToMode"]?.stringValue)

        let threadReplies = matrix?["threadReplies"]?.stringValue ?? "inbound"
        self.matrixThreadReplies = ["off", "inbound", "always"].contains(threadReplies)
            ? threadReplies
            : "inbound"

        let actions = matrix?["actions"]?.dictionaryValue
        self.matrixActionReactions = actions?["reactions"]?.boolValue ?? true
        self.matrixActionMessages = actions?["messages"]?.boolValue ?? true
        self.matrixActionPins = actions?["pins"]?.boolValue ?? true
        self.matrixActionMemberInfo = actions?["memberInfo"]?.boolValue ?? true
        self.matrixActionRoomInfo = actions?["roomInfo"]?.boolValue ?? true
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
        let signal = snap.config?["signal"]?.dictionaryValue
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
        let imessage = snap.config?["imessage"]?.dictionaryValue
        self.imessageEnabled = imessage?["enabled"]?.boolValue ?? true
        self.imessageCliPath = imessage?["cliPath"]?.stringValue ?? ""
        self.imessageDbPath = imessage?["dbPath"]?.stringValue ?? ""
        self.imessageService = imessage?["service"]?.stringValue ?? "auto"
        self.imessageRegion = imessage?["region"]?.stringValue ?? ""
        self.imessageAllowFrom = self.stringList(from: imessage?["allowFrom"]?.arrayValue)
        self.imessageIncludeAttachments = imessage?["includeAttachments"]?.boolValue ?? false
        self.imessageMediaMaxMb = self.numberString(from: imessage?["mediaMaxMb"])
    }

    func saveTelegramConfig() async {
        guard !self.isSavingConfig else { return }
        self.isSavingConfig = true
        defer { self.isSavingConfig = false }
        if !self.configLoaded {
            await self.loadConfig()
        }

        var telegram: [String: Any] = (self.configRoot["telegram"] as? [String: Any]) ?? [:]
        let token = self.trimmed(self.telegramToken)
        if token.isEmpty {
            telegram.removeValue(forKey: "botToken")
        } else {
            telegram["botToken"] = token
        }

        telegram["requireMention"] = self.telegramRequireMention

        let allow = self.splitCsv(self.telegramAllowFrom)
        if allow.isEmpty {
            telegram.removeValue(forKey: "allowFrom")
        } else {
            telegram["allowFrom"] = allow
        }

        self.setOptionalString(&telegram, key: "proxy", value: self.telegramProxy)
        self.setOptionalString(&telegram, key: "webhookUrl", value: self.telegramWebhookUrl)
        self.setOptionalString(&telegram, key: "webhookSecret", value: self.telegramWebhookSecret)
        self.setOptionalString(&telegram, key: "webhookPath", value: self.telegramWebhookPath)

        self.setSection("telegram", payload: telegram)
        await self.persistConfig()
    }

    func saveDiscordConfig() async {
        guard !self.isSavingConfig else { return }
        self.isSavingConfig = true
        defer { self.isSavingConfig = false }
        if !self.configLoaded {
            await self.loadConfig()
        }

        let discord = self.buildDiscordConfig()
        self.setSection("discord", payload: discord)
        await self.persistConfig()
    }

    func saveMatrixConfig() async {
        guard !self.isSavingConfig else { return }
        self.isSavingConfig = true
        defer { self.isSavingConfig = false }
        if !self.configLoaded {
            await self.loadConfig()
        }

        var matrix: [String: Any] = (self.configRoot["matrix"] as? [String: Any]) ?? [:]
        if self.matrixEnabled {
            matrix.removeValue(forKey: "enabled")
        } else {
            matrix["enabled"] = false
        }

        self.setOptionalString(&matrix, key: "homeserver", value: self.matrixHomeserver)
        self.setOptionalString(&matrix, key: "userId", value: self.matrixUserId)
        self.setOptionalString(&matrix, key: "accessToken", value: self.matrixAccessToken)
        self.setOptionalString(&matrix, key: "password", value: self.matrixPassword)
        self.setOptionalString(&matrix, key: "deviceId", value: self.matrixDeviceId)
        self.setOptionalString(&matrix, key: "deviceName", value: self.matrixDeviceName)

        if self.matrixEncryption {
            matrix.removeValue(forKey: "encryption")
        } else {
            matrix["encryption"] = false
        }

        let autoJoin = self.trimmed(self.matrixAutoJoin)
        if autoJoin.isEmpty || autoJoin == "always" {
            matrix.removeValue(forKey: "autoJoin")
        } else if ["allowlist", "off"].contains(autoJoin) {
            matrix["autoJoin"] = autoJoin
        } else {
            matrix.removeValue(forKey: "autoJoin")
        }

        let autoJoinAllowlist = self.splitCsv(self.matrixAutoJoinAllowlist)
        if autoJoinAllowlist.isEmpty {
            matrix.removeValue(forKey: "autoJoinAllowlist")
        } else {
            matrix["autoJoinAllowlist"] = autoJoinAllowlist
        }

        let groupPolicy = self.trimmed(self.matrixGroupPolicy)
        if groupPolicy.isEmpty || groupPolicy == "open" {
            matrix.removeValue(forKey: "groupPolicy")
        } else if ["allowlist", "disabled"].contains(groupPolicy) {
            matrix["groupPolicy"] = groupPolicy
        } else {
            matrix.removeValue(forKey: "groupPolicy")
        }

        if self.matrixAllowlistOnly {
            matrix["allowlistOnly"] = true
        } else {
            matrix.removeValue(forKey: "allowlistOnly")
        }

        var dm: [String: Any] = (matrix["dm"] as? [String: Any]) ?? [:]
        if self.matrixDmEnabled {
            dm.removeValue(forKey: "enabled")
        } else {
            dm["enabled"] = false
        }
        let dmPolicy = self.trimmed(self.matrixDmPolicy)
        if dmPolicy.isEmpty || dmPolicy == "pairing" {
            dm.removeValue(forKey: "policy")
        } else if ["allowlist", "open", "disabled"].contains(dmPolicy) {
            dm["policy"] = dmPolicy
        } else {
            dm.removeValue(forKey: "policy")
        }
        let dmAllowFrom = self.splitCsv(self.matrixDmAllowFrom)
        if dmAllowFrom.isEmpty {
            dm.removeValue(forKey: "allowFrom")
        } else {
            dm["allowFrom"] = dmAllowFrom
        }
        if dm.isEmpty {
            matrix.removeValue(forKey: "dm")
        } else {
            matrix["dm"] = dm
        }

        self.setOptionalInt(&matrix, key: "textChunkLimit", value: self.matrixTextChunkLimit, allowZero: false)
        self.setOptionalNumber(&matrix, key: "mediaMaxMb", value: self.matrixMediaMaxMb)

        let replyToMode = self.trimmed(self.matrixReplyToMode)
        if replyToMode.isEmpty || replyToMode == "off" {
            matrix.removeValue(forKey: "replyToMode")
        } else if ["first", "all"].contains(replyToMode) {
            matrix["replyToMode"] = replyToMode
        } else {
            matrix.removeValue(forKey: "replyToMode")
        }

        let threadReplies = self.trimmed(self.matrixThreadReplies)
        if threadReplies.isEmpty || threadReplies == "inbound" {
            matrix.removeValue(forKey: "threadReplies")
        } else if ["always", "off"].contains(threadReplies) {
            matrix["threadReplies"] = threadReplies
        } else {
            matrix.removeValue(forKey: "threadReplies")
        }

        var actions: [String: Any] = (matrix["actions"] as? [String: Any]) ?? [:]
        self.setAction(&actions, key: "reactions", value: self.matrixActionReactions, defaultValue: true)
        self.setAction(&actions, key: "messages", value: self.matrixActionMessages, defaultValue: true)
        self.setAction(&actions, key: "pins", value: self.matrixActionPins, defaultValue: true)
        self.setAction(&actions, key: "memberInfo", value: self.matrixActionMemberInfo, defaultValue: true)
        self.setAction(&actions, key: "roomInfo", value: self.matrixActionRoomInfo, defaultValue: true)
        if actions.isEmpty {
            matrix.removeValue(forKey: "actions")
        } else {
            matrix["actions"] = actions
        }

        self.setSection("matrix", payload: matrix)
        await self.persistConfig()
    }

    func saveSignalConfig() async {
        guard !self.isSavingConfig else { return }
        self.isSavingConfig = true
        defer { self.isSavingConfig = false }
        if !self.configLoaded {
            await self.loadConfig()
        }

        var signal: [String: Any] = (self.configRoot["signal"] as? [String: Any]) ?? [:]
        if self.signalEnabled {
            signal.removeValue(forKey: "enabled")
        } else {
            signal["enabled"] = false
        }

        self.setOptionalString(&signal, key: "account", value: self.signalAccount)
        self.setOptionalString(&signal, key: "httpUrl", value: self.signalHttpUrl)
        self.setOptionalString(&signal, key: "httpHost", value: self.signalHttpHost)
        self.setOptionalNumber(&signal, key: "httpPort", value: self.signalHttpPort)
        self.setOptionalString(&signal, key: "cliPath", value: self.signalCliPath)

        if self.signalAutoStart {
            signal.removeValue(forKey: "autoStart")
        } else {
            signal["autoStart"] = false
        }

        self.setOptionalString(&signal, key: "receiveMode", value: self.signalReceiveMode)

        self.setOptionalBool(&signal, key: "ignoreAttachments", value: self.signalIgnoreAttachments)
        self.setOptionalBool(&signal, key: "ignoreStories", value: self.signalIgnoreStories)
        self.setOptionalBool(&signal, key: "sendReadReceipts", value: self.signalSendReadReceipts)

        let allow = self.splitCsv(self.signalAllowFrom)
        if allow.isEmpty {
            signal.removeValue(forKey: "allowFrom")
        } else {
            signal["allowFrom"] = allow
        }

        self.setOptionalNumber(&signal, key: "mediaMaxMb", value: self.signalMediaMaxMb)

        self.setSection("signal", payload: signal)
        await self.persistConfig()
    }

    func saveIMessageConfig() async {
        guard !self.isSavingConfig else { return }
        self.isSavingConfig = true
        defer { self.isSavingConfig = false }
        if !self.configLoaded {
            await self.loadConfig()
        }

        var imessage: [String: Any] = (self.configRoot["imessage"] as? [String: Any]) ?? [:]
        if self.imessageEnabled {
            imessage.removeValue(forKey: "enabled")
        } else {
            imessage["enabled"] = false
        }

        self.setOptionalString(&imessage, key: "cliPath", value: self.imessageCliPath)
        self.setOptionalString(&imessage, key: "dbPath", value: self.imessageDbPath)

        let service = self.trimmed(self.imessageService)
        if service.isEmpty || service == "auto" {
            imessage.removeValue(forKey: "service")
        } else {
            imessage["service"] = service
        }

        self.setOptionalString(&imessage, key: "region", value: self.imessageRegion)

        let allow = self.splitCsv(self.imessageAllowFrom)
        if allow.isEmpty {
            imessage.removeValue(forKey: "allowFrom")
        } else {
            imessage["allowFrom"] = allow
        }

        self.setOptionalBool(&imessage, key: "includeAttachments", value: self.imessageIncludeAttachments)
        self.setOptionalNumber(&imessage, key: "mediaMaxMb", value: self.imessageMediaMaxMb)

        self.setSection("imessage", payload: imessage)
        await self.persistConfig()
    }

    private func buildDiscordConfig() -> [String: Any] {
        var discord: [String: Any] = (self.configRoot["discord"] as? [String: Any]) ?? [:]
        if self.discordEnabled {
            discord.removeValue(forKey: "enabled")
        } else {
            discord["enabled"] = false
        }
        self.setOptionalString(&discord, key: "token", value: self.discordToken)

        if let dm = self.buildDiscordDmConfig(base: discord["dm"] as? [String: Any] ?? [:]) {
            discord["dm"] = dm
        } else {
            discord.removeValue(forKey: "dm")
        }

        self.setOptionalNumber(&discord, key: "mediaMaxMb", value: self.discordMediaMaxMb)
        self.setOptionalInt(&discord, key: "historyLimit", value: self.discordHistoryLimit, allowZero: true)
        self.setOptionalInt(&discord, key: "textChunkLimit", value: self.discordTextChunkLimit, allowZero: false)

        let replyToMode = self.trimmed(self.discordReplyToMode)
        if replyToMode.isEmpty || replyToMode == "off" {
            discord.removeValue(forKey: "replyToMode")
        } else if ["first", "all"].contains(replyToMode) {
            discord["replyToMode"] = replyToMode
        } else {
            discord.removeValue(forKey: "replyToMode")
        }

        if let guilds = self.buildDiscordGuildsConfig() {
            discord["guilds"] = guilds
        } else {
            discord.removeValue(forKey: "guilds")
        }

        if let actions = self.buildDiscordActionsConfig(base: discord["actions"] as? [String: Any] ?? [:]) {
            discord["actions"] = actions
        } else {
            discord.removeValue(forKey: "actions")
        }

        if let slash = self.buildDiscordSlashConfig(base: discord["slashCommand"] as? [String: Any] ?? [:]) {
            discord["slashCommand"] = slash
        } else {
            discord.removeValue(forKey: "slashCommand")
        }

        return discord
    }

    private func buildDiscordDmConfig(base: [String: Any]) -> [String: Any]? {
        var dm = base
        if self.discordDmEnabled {
            dm.removeValue(forKey: "enabled")
        } else {
            dm["enabled"] = false
        }
        let allow = self.splitCsv(self.discordAllowFrom)
        if allow.isEmpty {
            dm.removeValue(forKey: "allowFrom")
        } else {
            dm["allowFrom"] = allow
        }

        if self.discordGroupEnabled {
            dm["groupEnabled"] = true
        } else {
            dm.removeValue(forKey: "groupEnabled")
        }

        let groupChannels = self.splitCsv(self.discordGroupChannels)
        if groupChannels.isEmpty {
            dm.removeValue(forKey: "groupChannels")
        } else {
            dm["groupChannels"] = groupChannels
        }

        return dm.isEmpty ? nil : dm
    }

    private func buildDiscordGuildsConfig() -> [String: Any]? {
        let guilds: [String: Any] = self.discordGuilds.reduce(into: [:]) { result, entry in
            let key = self.trimmed(entry.key)
            guard !key.isEmpty else { return }
            var payload: [String: Any] = [:]
            let slug = self.trimmed(entry.slug)
            if !slug.isEmpty { payload["slug"] = slug }
            if entry.requireMention { payload["requireMention"] = true }
            if ["off", "own", "all", "allowlist"].contains(entry.reactionNotifications) {
                payload["reactionNotifications"] = entry.reactionNotifications
            }
            let users = self.splitCsv(entry.users)
            if !users.isEmpty { payload["users"] = users }
            let channels: [String: Any] = entry.channels.reduce(into: [:]) { channelsResult, channel in
                let channelKey = self.trimmed(channel.key)
                guard !channelKey.isEmpty else { return }
                var channelPayload: [String: Any] = [:]
                if !channel.allow { channelPayload["allow"] = false }
                if channel.requireMention { channelPayload["requireMention"] = true }
                channelsResult[channelKey] = channelPayload
            }
            if !channels.isEmpty { payload["channels"] = channels }
            result[key] = payload
        }
        return guilds.isEmpty ? nil : guilds
    }

    private func buildDiscordActionsConfig(base: [String: Any]) -> [String: Any]? {
        var actions = base
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

    private func buildDiscordSlashConfig(base: [String: Any]) -> [String: Any]? {
        var slash = base
        if self.discordSlashEnabled {
            slash["enabled"] = true
        } else {
            slash.removeValue(forKey: "enabled")
        }
        self.setOptionalString(&slash, key: "name", value: self.discordSlashName)
        self.setOptionalString(&slash, key: "sessionPrefix", value: self.discordSlashSessionPrefix)
        if self.discordSlashEphemeral {
            slash.removeValue(forKey: "ephemeral")
        } else {
            slash["ephemeral"] = false
        }
        return slash.isEmpty ? nil : slash
    }

    private func persistConfig() async {
        do {
            let data = try JSONSerialization.data(
                withJSONObject: self.configRoot,
                options: [.prettyPrinted, .sortedKeys])
            guard let raw = String(data: data, encoding: .utf8) else {
                self.configStatus = "Failed to encode config."
                return
            }
            let params: [String: AnyCodable] = ["raw": AnyCodable(raw)]
            _ = try await GatewayConnection.shared.requestRaw(
                method: .configSet,
                params: params,
                timeoutMs: 10000)
            self.configStatus = "Saved to ~/.clawdbot/clawdbot.json."
            await self.refresh(probe: true)
        } catch {
            self.configStatus = error.localizedDescription
        }
    }

    private func setSection(_ key: String, payload: [String: Any]) {
        if payload.isEmpty {
            self.configRoot.removeValue(forKey: key)
        } else {
            self.configRoot[key] = payload
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

    private func setOptionalString(_ target: inout [String: Any], key: String, value: String) {
        let trimmed = self.trimmed(value)
        if trimmed.isEmpty {
            target.removeValue(forKey: key)
        } else {
            target[key] = trimmed
        }
    }

    private func setOptionalNumber(_ target: inout [String: Any], key: String, value: String) {
        let trimmed = self.trimmed(value)
        if trimmed.isEmpty {
            target.removeValue(forKey: key)
        } else if let number = Double(trimmed) {
            target[key] = number
        }
    }

    private func setOptionalInt(
        _ target: inout [String: Any],
        key: String,
        value: String,
        allowZero: Bool)
    {
        let trimmed = self.trimmed(value)
        if trimmed.isEmpty {
            target.removeValue(forKey: key)
            return
        }
        guard let number = Int(trimmed) else {
            target.removeValue(forKey: key)
            return
        }
        let isValid = allowZero ? number >= 0 : number > 0
        guard isValid else {
            target.removeValue(forKey: key)
            return
        }
        target[key] = number
    }

    private func setOptionalBool(_ target: inout [String: Any], key: String, value: Bool) {
        if value {
            target[key] = true
        } else {
            target.removeValue(forKey: key)
        }
    }

    private func setAction(
        _ actions: inout [String: Any],
        key: String,
        value: Bool,
        defaultValue: Bool)
    {
        if value == defaultValue {
            actions.removeValue(forKey: key)
        } else {
            actions[key] = value
        }
    }
}
