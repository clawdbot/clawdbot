import SwiftUI

extension ConnectionsSettings {
    func formSection(_ title: String, @ViewBuilder content: () -> some View) -> some View {
        GroupBox(title) {
            VStack(alignment: .leading, spacing: 10) {
                content()
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    @ViewBuilder
    func channelHeaderActions(_ channel: ConnectionChannel) -> some View {
        HStack(spacing: 8) {
            if channel == .whatsapp {
                Button("Logout") {
                    Task { await self.store.logoutWhatsApp() }
                }
                .buttonStyle(.bordered)
                .disabled(self.store.whatsappBusy)
            }

            if channel == .telegram {
                Button("Logout") {
                    Task { await self.store.logoutTelegram() }
                }
                .buttonStyle(.bordered)
                .disabled(self.store.telegramBusy)
            }

            Button {
                Task { await self.store.refresh(probe: true) }
            } label: {
                if self.store.isRefreshing {
                    ProgressView().controlSize(.small)
                } else {
                    Text("Refresh")
                }
            }
            .buttonStyle(.bordered)
            .disabled(self.store.isRefreshing)
        }
        .controlSize(.small)
    }

    var whatsAppSection: some View {
        VStack(alignment: .leading, spacing: 16) {
            self.formSection("Linking") {
                if let message = self.store.whatsappLoginMessage {
                    Text(message)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                if let qr = self.store.whatsappLoginQrDataUrl, let image = self.qrImage(from: qr) {
                    Image(nsImage: image)
                        .resizable()
                        .interpolation(.none)
                        .frame(width: 180, height: 180)
                        .cornerRadius(8)
                }

                HStack(spacing: 12) {
                    Button {
                        Task { await self.store.startWhatsAppLogin(force: false) }
                    } label: {
                        if self.store.whatsappBusy {
                            ProgressView().controlSize(.small)
                        } else {
                            Text("Show QR")
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(self.store.whatsappBusy)

                    Button("Relink") {
                        Task { await self.store.startWhatsAppLogin(force: true) }
                    }
                    .buttonStyle(.bordered)
                    .disabled(self.store.whatsappBusy)
                }
                .font(.caption)
            }
        }
    }

    var telegramSection: some View {
        VStack(alignment: .leading, spacing: 16) {
            self.formSection("Authentication") {
                Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 14, verticalSpacing: 8) {
                    GridRow {
                        self.gridLabel("Bot token")
                        if self.showTelegramToken {
                            TextField("123:abc", text: self.$store.telegramToken)
                                .textFieldStyle(.roundedBorder)
                                .disabled(self.isTelegramTokenLocked)
                        } else {
                            SecureField("123:abc", text: self.$store.telegramToken)
                                .textFieldStyle(.roundedBorder)
                                .disabled(self.isTelegramTokenLocked)
                        }
                        Toggle("Show", isOn: self.$showTelegramToken)
                            .toggleStyle(.switch)
                            .disabled(self.isTelegramTokenLocked)
                    }
                }
            }

            self.formSection("Access") {
                Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 14, verticalSpacing: 8) {
                    GridRow {
                        self.gridLabel("Require mention")
                        Toggle("", isOn: self.$store.telegramRequireMention)
                            .labelsHidden()
                            .toggleStyle(.checkbox)
                    }
                    GridRow {
                        self.gridLabel("Allow from")
                        TextField("123456789, @team", text: self.$store.telegramAllowFrom)
                            .textFieldStyle(.roundedBorder)
                    }
                }
            }

            self.formSection("Webhook") {
                Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 14, verticalSpacing: 8) {
                    GridRow {
                        self.gridLabel("Webhook URL")
                        TextField("https://example.com/telegram-webhook", text: self.$store.telegramWebhookUrl)
                            .textFieldStyle(.roundedBorder)
                    }
                    GridRow {
                        self.gridLabel("Webhook secret")
                        TextField("secret", text: self.$store.telegramWebhookSecret)
                            .textFieldStyle(.roundedBorder)
                    }
                    GridRow {
                        self.gridLabel("Webhook path")
                        TextField("/telegram-webhook", text: self.$store.telegramWebhookPath)
                            .textFieldStyle(.roundedBorder)
                    }
                }
            }

            self.formSection("Network") {
                Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 14, verticalSpacing: 8) {
                    GridRow {
                        self.gridLabel("Proxy")
                        TextField("socks5://localhost:9050", text: self.$store.telegramProxy)
                            .textFieldStyle(.roundedBorder)
                    }
                }
            }

            if self.isTelegramTokenLocked {
                Text("Token set via TELEGRAM_BOT_TOKEN env; config edits won’t override it.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            self.configStatusMessage

            HStack(spacing: 12) {
                Button {
                    Task { await self.store.saveTelegramConfig() }
                } label: {
                    if self.store.isSavingConfig {
                        ProgressView().controlSize(.small)
                    } else {
                        Text("Save")
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(self.store.isSavingConfig)

                Spacer()
            }
            .font(.caption)
        }
    }

    var discordSection: some View {
        VStack(alignment: .leading, spacing: 16) {
            self.formSection("Authentication") {
                Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 14, verticalSpacing: 8) {
                    GridRow {
                        self.gridLabel("Enabled")
                        Toggle("", isOn: self.$store.discordEnabled)
                            .labelsHidden()
                            .toggleStyle(.checkbox)
                    }
                    GridRow {
                        self.gridLabel("Bot token")
                        if self.showDiscordToken {
                            TextField("bot token", text: self.$store.discordToken)
                                .textFieldStyle(.roundedBorder)
                                .disabled(self.isDiscordTokenLocked)
                        } else {
                            SecureField("bot token", text: self.$store.discordToken)
                                .textFieldStyle(.roundedBorder)
                                .disabled(self.isDiscordTokenLocked)
                        }
                        Toggle("Show", isOn: self.$showDiscordToken)
                            .toggleStyle(.switch)
                            .disabled(self.isDiscordTokenLocked)
                    }
                }
            }

            self.formSection("Messages") {
                Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 14, verticalSpacing: 8) {
                    GridRow {
                        self.gridLabel("Allow DMs from")
                        TextField("123456789, username#1234", text: self.$store.discordAllowFrom)
                            .textFieldStyle(.roundedBorder)
                    }
                    GridRow {
                        self.gridLabel("DMs enabled")
                        Toggle("", isOn: self.$store.discordDmEnabled)
                            .labelsHidden()
                            .toggleStyle(.checkbox)
                    }
                    GridRow {
                        self.gridLabel("Group DMs")
                        Toggle("", isOn: self.$store.discordGroupEnabled)
                            .labelsHidden()
                            .toggleStyle(.checkbox)
                    }
                    GridRow {
                        self.gridLabel("Group channels")
                        TextField("channelId1, channelId2", text: self.$store.discordGroupChannels)
                            .textFieldStyle(.roundedBorder)
                    }
                    GridRow {
                        self.gridLabel("Reply to mode")
                        Picker("", selection: self.$store.discordReplyToMode) {
                            Text("off").tag("off")
                            Text("first").tag("first")
                            Text("all").tag("all")
                        }
                        .labelsHidden()
                    }
                }
            }

            self.formSection("Limits") {
                Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 14, verticalSpacing: 8) {
                    GridRow {
                        self.gridLabel("Media max MB")
                        TextField("8", text: self.$store.discordMediaMaxMb)
                            .textFieldStyle(.roundedBorder)
                    }
                    GridRow {
                        self.gridLabel("History limit")
                        TextField("20", text: self.$store.discordHistoryLimit)
                            .textFieldStyle(.roundedBorder)
                    }
                    GridRow {
                        self.gridLabel("Text chunk limit")
                        TextField("2000", text: self.$store.discordTextChunkLimit)
                            .textFieldStyle(.roundedBorder)
                    }
                }
            }

            self.formSection("Slash command") {
                Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 14, verticalSpacing: 8) {
                    GridRow {
                        self.gridLabel("Enabled")
                        Toggle("", isOn: self.$store.discordSlashEnabled)
                            .labelsHidden()
                            .toggleStyle(.checkbox)
                    }
                    GridRow {
                        self.gridLabel("Slash name")
                        TextField("clawd", text: self.$store.discordSlashName)
                            .textFieldStyle(.roundedBorder)
                    }
                    GridRow {
                        self.gridLabel("Session prefix")
                        TextField("discord:slash", text: self.$store.discordSlashSessionPrefix)
                            .textFieldStyle(.roundedBorder)
                    }
                    GridRow {
                        self.gridLabel("Ephemeral")
                        Toggle("", isOn: self.$store.discordSlashEphemeral)
                            .labelsHidden()
                            .toggleStyle(.checkbox)
                    }
                }
            }

            GroupBox("Guilds") {
                VStack(alignment: .leading, spacing: 12) {
                    ForEach(self.$store.discordGuilds) { $guild in
                        VStack(alignment: .leading, spacing: 10) {
                            HStack {
                                TextField("guild id or slug", text: $guild.key)
                                    .textFieldStyle(.roundedBorder)
                                Button("Remove") {
                                    self.store.discordGuilds.removeAll { $0.id == guild.id }
                                }
                                .buttonStyle(.bordered)
                            }

                            Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 14, verticalSpacing: 8) {
                                GridRow {
                                    self.gridLabel("Slug")
                                    TextField("optional slug", text: $guild.slug)
                                        .textFieldStyle(.roundedBorder)
                                }
                                GridRow {
                                    self.gridLabel("Require mention")
                                    Toggle("", isOn: $guild.requireMention)
                                        .labelsHidden()
                                        .toggleStyle(.checkbox)
                                }
                                GridRow {
                                    self.gridLabel("Reaction notifications")
                                    Picker("", selection: $guild.reactionNotifications) {
                                        Text("Off").tag("off")
                                        Text("Own").tag("own")
                                        Text("All").tag("all")
                                        Text("Allowlist").tag("allowlist")
                                    }
                                    .labelsHidden()
                                    .pickerStyle(.segmented)
                                }
                                GridRow {
                                    self.gridLabel("Users allowlist")
                                    TextField("123456789, username#1234", text: $guild.users)
                                        .textFieldStyle(.roundedBorder)
                                }
                            }

                            Text("Channels")
                                .font(.caption)
                                .foregroundStyle(.secondary)

                            VStack(alignment: .leading, spacing: 8) {
                                ForEach($guild.channels) { $channel in
                                    HStack(spacing: 10) {
                                        TextField("channel id or slug", text: $channel.key)
                                            .textFieldStyle(.roundedBorder)
                                        Toggle("Allow", isOn: $channel.allow)
                                            .toggleStyle(.checkbox)
                                        Toggle("Require mention", isOn: $channel.requireMention)
                                            .toggleStyle(.checkbox)
                                        Button("Remove") {
                                            guild.channels.removeAll { $0.id == channel.id }
                                        }
                                        .buttonStyle(.bordered)
                                    }
                                }
                                Button("Add channel") {
                                    guild.channels.append(DiscordGuildChannelForm())
                                }
                                .buttonStyle(.bordered)
                            }
                        }
                        .padding(10)
                        .background(Color.secondary.opacity(0.08))
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                    }

                    Button("Add guild") {
                        self.store.discordGuilds.append(DiscordGuildForm())
                    }
                    .buttonStyle(.bordered)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }

            GroupBox("Tool actions") {
                Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 14, verticalSpacing: 8) {
                    GridRow {
                        self.gridLabel("Reactions")
                        Toggle("", isOn: self.$store.discordActionReactions)
                            .labelsHidden()
                            .toggleStyle(.checkbox)
                    }
                    GridRow {
                        self.gridLabel("Stickers")
                        Toggle("", isOn: self.$store.discordActionStickers)
                            .labelsHidden()
                            .toggleStyle(.checkbox)
                    }
                    GridRow {
                        self.gridLabel("Polls")
                        Toggle("", isOn: self.$store.discordActionPolls)
                            .labelsHidden()
                            .toggleStyle(.checkbox)
                    }
                    GridRow {
                        self.gridLabel("Permissions")
                        Toggle("", isOn: self.$store.discordActionPermissions)
                            .labelsHidden()
                            .toggleStyle(.checkbox)
                    }
                    GridRow {
                        self.gridLabel("Messages")
                        Toggle("", isOn: self.$store.discordActionMessages)
                            .labelsHidden()
                            .toggleStyle(.checkbox)
                    }
                    GridRow {
                        self.gridLabel("Threads")
                        Toggle("", isOn: self.$store.discordActionThreads)
                            .labelsHidden()
                            .toggleStyle(.checkbox)
                    }
                    GridRow {
                        self.gridLabel("Pins")
                        Toggle("", isOn: self.$store.discordActionPins)
                            .labelsHidden()
                            .toggleStyle(.checkbox)
                    }
                    GridRow {
                        self.gridLabel("Search")
                        Toggle("", isOn: self.$store.discordActionSearch)
                            .labelsHidden()
                            .toggleStyle(.checkbox)
                    }
                    GridRow {
                        self.gridLabel("Member info")
                        Toggle("", isOn: self.$store.discordActionMemberInfo)
                            .labelsHidden()
                            .toggleStyle(.checkbox)
                    }
                    GridRow {
                        self.gridLabel("Role info")
                        Toggle("", isOn: self.$store.discordActionRoleInfo)
                            .labelsHidden()
                            .toggleStyle(.checkbox)
                    }
                    GridRow {
                        self.gridLabel("Channel info")
                        Toggle("", isOn: self.$store.discordActionChannelInfo)
                            .labelsHidden()
                            .toggleStyle(.checkbox)
                    }
                    GridRow {
                        self.gridLabel("Voice status")
                        Toggle("", isOn: self.$store.discordActionVoiceStatus)
                            .labelsHidden()
                            .toggleStyle(.checkbox)
                    }
                    GridRow {
                        self.gridLabel("Events")
                        Toggle("", isOn: self.$store.discordActionEvents)
                            .labelsHidden()
                            .toggleStyle(.checkbox)
                    }
                    GridRow {
                        self.gridLabel("Role changes")
                        Toggle("", isOn: self.$store.discordActionRoles)
                            .labelsHidden()
                            .toggleStyle(.checkbox)
                    }
                    GridRow {
                        self.gridLabel("Moderation")
                        Toggle("", isOn: self.$store.discordActionModeration)
                            .labelsHidden()
                            .toggleStyle(.checkbox)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }

            if self.isDiscordTokenLocked {
                Text("Token set via DISCORD_BOT_TOKEN env; config edits won’t override it.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            self.configStatusMessage

            HStack(spacing: 12) {
                Button {
                    Task { await self.store.saveDiscordConfig() }
                } label: {
                    if self.store.isSavingConfig {
                        ProgressView().controlSize(.small)
                    } else {
                        Text("Save")
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(self.store.isSavingConfig)

                Spacer()
            }
            .font(.caption)
        }
    }

    var signalSection: some View {
        VStack(alignment: .leading, spacing: 16) {
            self.formSection("Connection") {
                Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 14, verticalSpacing: 8) {
                    GridRow {
                        self.gridLabel("Enabled")
                        Toggle("", isOn: self.$store.signalEnabled)
                            .labelsHidden()
                            .toggleStyle(.checkbox)
                    }
                    GridRow {
                        self.gridLabel("Account")
                        TextField("+15551234567", text: self.$store.signalAccount)
                            .textFieldStyle(.roundedBorder)
                    }
                    GridRow {
                        self.gridLabel("HTTP URL")
                        TextField("http://127.0.0.1:8080", text: self.$store.signalHttpUrl)
                            .textFieldStyle(.roundedBorder)
                    }
                    GridRow {
                        self.gridLabel("HTTP host")
                        TextField("127.0.0.1", text: self.$store.signalHttpHost)
                            .textFieldStyle(.roundedBorder)
                    }
                    GridRow {
                        self.gridLabel("HTTP port")
                        TextField("8080", text: self.$store.signalHttpPort)
                            .textFieldStyle(.roundedBorder)
                    }
                    GridRow {
                        self.gridLabel("CLI path")
                        TextField("signal-cli", text: self.$store.signalCliPath)
                            .textFieldStyle(.roundedBorder)
                    }
                }
            }

            self.formSection("Behavior") {
                Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 14, verticalSpacing: 8) {
                    GridRow {
                        self.gridLabel("Auto start")
                        Toggle("", isOn: self.$store.signalAutoStart)
                            .labelsHidden()
                            .toggleStyle(.checkbox)
                    }
                    GridRow {
                        self.gridLabel("Receive mode")
                        Picker("", selection: self.$store.signalReceiveMode) {
                            Text("Default").tag("")
                            Text("on-start").tag("on-start")
                            Text("manual").tag("manual")
                        }
                        .labelsHidden()
                        .pickerStyle(.menu)
                    }
                    GridRow {
                        self.gridLabel("Ignore attachments")
                        Toggle("", isOn: self.$store.signalIgnoreAttachments)
                            .labelsHidden()
                            .toggleStyle(.checkbox)
                    }
                    GridRow {
                        self.gridLabel("Ignore stories")
                        Toggle("", isOn: self.$store.signalIgnoreStories)
                            .labelsHidden()
                            .toggleStyle(.checkbox)
                    }
                    GridRow {
                        self.gridLabel("Read receipts")
                        Toggle("", isOn: self.$store.signalSendReadReceipts)
                            .labelsHidden()
                            .toggleStyle(.checkbox)
                    }
                }
            }

            self.formSection("Access & limits") {
                Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 14, verticalSpacing: 8) {
                    GridRow {
                        self.gridLabel("Allow from")
                        TextField("12345, +1555", text: self.$store.signalAllowFrom)
                            .textFieldStyle(.roundedBorder)
                    }
                    GridRow {
                        self.gridLabel("Media max MB")
                        TextField("8", text: self.$store.signalMediaMaxMb)
                            .textFieldStyle(.roundedBorder)
                    }
                }
            }

            self.configStatusMessage

            HStack(spacing: 12) {
                Button {
                    Task { await self.store.saveSignalConfig() }
                } label: {
                    if self.store.isSavingConfig {
                        ProgressView().controlSize(.small)
                    } else {
                        Text("Save")
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(self.store.isSavingConfig)

                Spacer()
            }
            .font(.caption)
        }
    }

    var imessageSection: some View {
        VStack(alignment: .leading, spacing: 16) {
            self.formSection("Connection") {
                Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 14, verticalSpacing: 8) {
                    GridRow {
                        self.gridLabel("Enabled")
                        Toggle("", isOn: self.$store.imessageEnabled)
                            .labelsHidden()
                            .toggleStyle(.checkbox)
                    }
                    GridRow {
                        self.gridLabel("CLI path")
                        TextField("imsg", text: self.$store.imessageCliPath)
                            .textFieldStyle(.roundedBorder)
                    }
                    GridRow {
                        self.gridLabel("DB path")
                        TextField("~/Library/Messages/chat.db", text: self.$store.imessageDbPath)
                            .textFieldStyle(.roundedBorder)
                    }
                    GridRow {
                        self.gridLabel("Service")
                        Picker("", selection: self.$store.imessageService) {
                            Text("auto").tag("auto")
                            Text("imessage").tag("imessage")
                            Text("sms").tag("sms")
                        }
                        .labelsHidden()
                        .pickerStyle(.menu)
                    }
                }
            }

            self.formSection("Behavior") {
                Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 14, verticalSpacing: 8) {
                    GridRow {
                        self.gridLabel("Region")
                        TextField("US", text: self.$store.imessageRegion)
                            .textFieldStyle(.roundedBorder)
                    }
                    GridRow {
                        self.gridLabel("Allow from")
                        TextField("chat_id:101, +1555", text: self.$store.imessageAllowFrom)
                            .textFieldStyle(.roundedBorder)
                    }
                    GridRow {
                        self.gridLabel("Attachments")
                        Toggle("", isOn: self.$store.imessageIncludeAttachments)
                            .labelsHidden()
                            .toggleStyle(.checkbox)
                    }
                    GridRow {
                        self.gridLabel("Media max MB")
                        TextField("16", text: self.$store.imessageMediaMaxMb)
                            .textFieldStyle(.roundedBorder)
                    }
                }
            }

            self.configStatusMessage

            HStack(spacing: 12) {
                Button {
                    Task { await self.store.saveIMessageConfig() }
                } label: {
                    if self.store.isSavingConfig {
                        ProgressView().controlSize(.small)
                    } else {
                        Text("Save")
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(self.store.isSavingConfig)

                Spacer()
            }
            .font(.caption)
        }
    }

    @ViewBuilder
    var configStatusMessage: some View {
        if let status = self.store.configStatus {
            Text(status)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    func gridLabel(_ text: String) -> some View {
        Text(text)
            .font(.callout.weight(.semibold))
            .frame(width: 140, alignment: .leading)
    }
}
