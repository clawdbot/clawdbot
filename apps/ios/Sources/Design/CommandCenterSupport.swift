import SwiftUI

struct CommandPanel<Content: View>: View {
    var tint: Color?
    var isProminent = false
    var padding: CGFloat = 13
    @ViewBuilder var content: Content

    init(
        tint: Color? = nil,
        isProminent: Bool = false,
        padding: CGFloat = 13,
        @ViewBuilder content: () -> Content)
    {
        self.tint = tint
        self.isProminent = isProminent
        self.padding = padding
        self.content = content()
    }

    var body: some View {
        ProCard(
            tint: self.tint,
            isProminent: self.isProminent,
            padding: self.padding,
            radius: 12)
        {
            self.content
        }
    }
}

struct CommandControlBackground: View {
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        LinearGradient(
            colors: self.colorScheme == .dark ? self.darkColors : self.lightColors,
            startPoint: .top,
            endPoint: .bottom)
            .overlay(alignment: .top) {
                if self.colorScheme == .light {
                    LinearGradient(
                        colors: [
                            Color.white.opacity(0.34),
                            Color.clear,
                        ],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing)
                        .frame(height: 260)
                }
            }
            .ignoresSafeArea()
    }

    private var darkColors: [Color] {
        [
            Color(red: 12 / 255, green: 13 / 255, blue: 15 / 255),
            Color(red: 7 / 255, green: 8 / 255, blue: 10 / 255),
            Color(red: 4 / 255, green: 5 / 255, blue: 6 / 255),
        ]
    }

    private var lightColors: [Color] {
        [
            Color(red: 247 / 255, green: 248 / 255, blue: 249 / 255),
            Color(red: 251 / 255, green: 252 / 255, blue: 253 / 255),
            .white,
        ]
    }
}

struct CommandSessionRow: View {
    @Environment(\.colorScheme) private var colorScheme
    let item: CommandCenterTab.WorkItem

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            Image(systemName: self.item.icon)
                .font(.caption.weight(.semibold))
                .foregroundStyle(self.item.color)
                .frame(width: 30, height: 30)
                .background {
                    RoundedRectangle(cornerRadius: 9, style: .continuous)
                        .fill(self.item.color.opacity(0.12))
                }
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(self.item.title)
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(1)
                        .minimumScaleFactor(0.82)
                    Spacer(minLength: 6)
                    Text(self.item.trailing)
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(.secondary)
                }
                HStack(spacing: 8) {
                    Text(self.item.detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    Spacer(minLength: 6)
                    if let progress = self.item.progress {
                        ProProgressBar(progress: progress, color: self.item.color)
                            .frame(width: 68)
                    }
                    Text(self.progressLabel)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(self.item.color)
                        .lineLimit(1)
                        .frame(width: 48, alignment: .trailing)
                }
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 9)
        .background {
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(self.rowFill)
                .overlay {
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .strokeBorder(self.rowBorder, lineWidth: 1)
                }
        }
    }

    private var progressLabel: String {
        guard let progress = item.progress else {
            return self.item.state
        }
        if self.item.state == "offline" || self.item.state == "off" || self.item.state == "idle" {
            return self.item.state
        }
        return "\(Int((progress * 100).rounded()))%"
    }

    private var rowFill: Color {
        self.colorScheme == .dark ? Color.white.opacity(0.035) : Color.black.opacity(0.025)
    }

    private var rowBorder: Color {
        self.colorScheme == .dark ? Color.white.opacity(0.065) : Color.black.opacity(0.045)
    }
}

struct CommandViewMoreRow: View {
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        Text("View More")
            .font(.subheadline.weight(.bold))
            .foregroundStyle(OpenClawBrand.accent)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 10)
            .background {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(self.rowFill)
                    .overlay {
                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .strokeBorder(self.rowBorder, lineWidth: 1)
                    }
            }
    }

    private var rowFill: Color {
        self.colorScheme == .dark ? Color.white.opacity(0.035) : Color.black.opacity(0.025)
    }

    private var rowBorder: Color {
        self.colorScheme == .dark ? Color.white.opacity(0.065) : Color.black.opacity(0.045)
    }
}

struct CommandEmptyStateRow: View {
    let icon: String
    let title: String
    let detail: String

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: self.icon)
                .font(.caption.weight(.bold))
                .foregroundStyle(OpenClawBrand.ok)
                .frame(width: 30, height: 30)
                .background {
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(OpenClawBrand.ok.opacity(0.10))
                }
            VStack(alignment: .leading, spacing: 2) {
                Text(self.title)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                Text(self.detail)
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 9)
        .background {
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(Color.black.opacity(0.06))
                .overlay {
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .strokeBorder(Color.primary.opacity(0.055), lineWidth: 1)
                }
        }
    }
}

struct CommandTaskRow: View {
    let item: CommandCenterTab.WorkItem

    var body: some View {
        HStack(alignment: .center, spacing: 6) {
            Text(self.item.title)
                .font(.footnote.weight(.semibold))
                .lineLimit(1)
                .minimumScaleFactor(0.80)
                .frame(maxWidth: .infinity, minHeight: 20, alignment: .leading)
            Text(self.item.detail)
                .font(.caption.weight(.medium))
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .minimumScaleFactor(0.78)
                .frame(width: 64, alignment: .leading)
            if let progress = self.item.progress {
                ProProgressBar(progress: progress, color: self.item.color)
                    .frame(width: 56)
            }
            Text(self.item.state)
                .font(.footnote.weight(.medium))
                .foregroundStyle(self.item.progress == nil ? self.item.color : .secondary)
                .lineLimit(1)
                .frame(width: self.item.progress == nil ? 58 : 34, alignment: .trailing)
        }
        .padding(.vertical, 8)
    }
}
