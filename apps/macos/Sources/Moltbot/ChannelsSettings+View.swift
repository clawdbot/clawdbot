import SwiftUI

extension ChannelsSettings {
    var body: some View {
        HStack(spacing: 0) {
            self.sidebar
            self.detail
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .onAppear {
            self.store.start()
            self.ensureSelection()
        }
        .onChange(of: self.orderedChannels) { _, _ in
            self.ensureSelection()
        }
        .onDisappear { self.store.stop() }
    }

    private var sidebar: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 8) {
                if !self.enabledChannels.isEmpty {
                    self.sidebarSectionHeader("Configured")
                    ForEach(self.enabledChannels) { channel in
                        self.sidebarRow(channel)
                    }
                }

                if !self.availableChannels.isEmpty {
                    self.sidebarSectionHeader("Available")
                    ForEach(self.availableChannels) { channel in
                        self.sidebarRow(channel)
                    }
                }
            }
            .padding(.vertical, 10)
            .padding(.horizontal, 10)
        }
        .frame(minWidth: 220, idealWidth: 240, maxWidth: 280, maxHeight: .infinity, alignment: .topLeading)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(Color(nsColor: .windowBackgroundColor)))
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private var detail: some View {
        Group {
            if let channel = self.selectedChannel {
                self.channelDetail(channel)
            } else {
                self.emptyDetail
            }
        }
        .frame(minWidth: 460, maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private var emptyDetail: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Channels")
                .font(.title3.weight(.semibold))
            Text("Select a channel to view status and settings.")
                .font(.callout)
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 24)
        .padding(.vertical, 18)
    }

    private func channelDetail(_ channel: ChannelItem) -> some View {
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: 16) {
                self.detailHeader(for: channel)
                Divider()
                self.channelSection(channel)
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 24)
            .padding(.vertical, 18)
        }
    }

    private func sidebarRow(_ channel: ChannelItem) -> some View {
        let isSelected = self.selectedChannel == channel
        return Button {
            self.selectedChannel = channel
        } label: {
            HStack(spacing: 8) {
                Circle()
                    .fill(self.channelTint(channel))
                    .frame(width: 8, height: 8)
                VStack(alignment: .leading, spacing: 2) {
                    Text(channel.title)
                    Text(self.channelSummary(channel))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.vertical, 4)
            .padding(.horizontal, 6)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(isSelected ? Color.accentColor.opacity(0.18) : Color.clear)
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .background(Color.clear) // ensure full-width hit test area
            .contentShape(Rectangle())
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .buttonStyle(.plain)
        .contentShape(Rectangle())
    }

    private func sidebarSectionHeader(_ title: String) -> some View {
        Text(title)
            .font(.caption.weight(.semibold))
            .foregroundStyle(.secondary)
            .textCase(.uppercase)
            .padding(.horizontal, 4)
            .padding(.top, 2)
    }

    private func detailHeader(for channel: ChannelItem) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Label(channel.detailTitle, systemImage: channel.systemImage)
                    .font(.title3.weight(.semibold))
                self.statusBadge(
                    self.channelSummary(channel),
                    color: self.channelTint(channel))
                Spacer()
                self.channelHeaderActions(channel)
            }

            HStack(spacing: 10) {
                Text("Last check \(self.channelLastCheckText(channel))")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if self.channelHasError(channel) {
                    Text("Error")
                        .font(.caption2.weight(.semibold))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Color.red.opacity(0.15))
                        .foregroundStyle(.red)
                        .clipShape(Capsule())
                }
            }

            if let details = self.channelDetails(channel) {
                Text(details)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func statusBadge(_ text: String, color: Color) -> some View {
        Text(text)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(color.opacity(0.16))
            .foregroundStyle(color)
            .clipShape(Capsule())
    }
}
