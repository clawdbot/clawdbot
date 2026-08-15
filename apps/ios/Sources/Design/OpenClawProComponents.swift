import OpenClawChatUI
import SwiftUI

enum OpenClawProMetric {
    static let pagePadding: CGFloat = 16
    static let cardRadius: CGFloat = 16
    static let controlRadius: CGFloat = 12
    static let compactControlSize: CGFloat = 36
    static let bottomScrollInset: CGFloat = 96
}

enum OpenClawSpacing {
    static let space1: CGFloat = 4
    static let space2: CGFloat = 8
    static let space3: CGFloat = 12
    static let space4: CGFloat = 16
    static let space6: CGFloat = 24
}

enum OpenClawRadius {
    static let xs: CGFloat = 8
    static let sm: CGFloat = 10
    static let md: CGFloat = 12
}

enum OpenClawTextValue: ExpressibleByStringLiteral {
    case localized(LocalizedStringKey)
    case verbatim(String)

    init(stringLiteral value: String) {
        self = .localized(LocalizedStringKey(value))
    }

    static func localized(_ value: String) -> Self {
        .localized(LocalizedStringKey(value))
    }

    var text: Text {
        switch self {
        case let .localized(key):
            Text(key)
        case let .verbatim(value):
            Text(verbatim: value)
        }
    }
}

struct OpenClawProBackground: View {
    var body: some View {
        Color(uiColor: .systemGroupedBackground)
            .ignoresSafeArea()
    }
}

struct ProSectionHeader: View {
    let title: OpenClawTextValue
    var actionTitle: OpenClawTextValue?
    var action: (() -> Void)?
    var uppercase = true

    var body: some View {
        HStack {
            self.title.text
                .font(OpenClawType.footnoteMedium)
                .foregroundStyle(.secondary)
                .textCase(self.uppercase ? .uppercase : nil)
            Spacer()
            if let actionTitle {
                if let action {
                    Button(action: action) {
                        actionTitle.text
                            .font(OpenClawType.footnoteMedium)
                    }
                    .foregroundStyle(OpenClawBrand.accent)
                } else {
                    actionTitle.text
                        .font(OpenClawType.footnoteMedium)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }
}

struct ProCard<Content: View>: View {
    var tint: Color?
    var isProminent: Bool = false
    var padding: CGFloat = 12
    var radius: CGFloat = OpenClawProMetric.cardRadius
    @ViewBuilder var content: Content

    var body: some View {
        self.content
            .padding(self.padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .proPanelSurface(
                tint: self.tint,
                radius: self.radius,
                isProminent: self.isProminent)
    }
}

private struct ProPanelBackground: View {
    @Environment(\.colorScheme) private var colorScheme
    let radius: CGFloat
    let tint: Color?
    let isProminent: Bool

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
        shape
            .fill(self.fill)
            .overlay {
                shape.strokeBorder(self.borderStyle, lineWidth: 1)
            }
    }

    private var fill: AnyShapeStyle {
        let color = self.isProminent ? UIColor.systemBackground : UIColor.secondarySystemGroupedBackground
        return AnyShapeStyle(Color(uiColor: color))
    }

    private var borderStyle: AnyShapeStyle {
        if let tint {
            return AnyShapeStyle(tint.opacity(self.isProminent ? 0.18 : 0.10))
        }
        return AnyShapeStyle(Color(uiColor: .separator).opacity(self.colorScheme == .dark ? 0.22 : 0.12))
    }
}

private struct ProInsetSurfaceModifier: ViewModifier {
    @Environment(\.colorScheme) private var colorScheme
    let tint: Color
    let radius: CGFloat

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
        content.background {
            shape
                .fill(Color(uiColor: .tertiarySystemGroupedBackground))
                .overlay {
                    shape.strokeBorder(
                        self.tint.opacity(self.colorScheme == .dark ? 0.18 : 0.10),
                        lineWidth: 1)
                }
        }
    }
}

private struct OpenClawGlassButtonModifier: ViewModifier {
    let prominent: Bool
    let tint: Color?

    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            if self.prominent {
                content
                    .font(OpenClawType.subheadSemiBold)
                    .buttonStyle(.glassProminent)
                    .tint(self.tint ?? OpenClawBrand.accent)
            } else {
                content
                    .font(OpenClawType.subheadSemiBold)
                    .buttonStyle(.glass)
                    .tint(self.tint)
            }
        } else if self.prominent {
            content
                .font(OpenClawType.subheadSemiBold)
                .buttonStyle(.borderedProminent)
                .tint(self.tint ?? OpenClawBrand.accent)
        } else {
            content
                .font(OpenClawType.subheadSemiBold)
                .buttonStyle(.bordered)
                .tint(self.tint)
        }
    }
}

private struct OpenClawGlassSurfaceModifier: ViewModifier {
    let radius: CGFloat

    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.glassEffect(.regular, in: .rect(cornerRadius: self.radius))
        } else {
            content.background(
                .regularMaterial,
                in: RoundedRectangle(cornerRadius: self.radius, style: .continuous))
        }
    }
}

extension View {
    func proPanelSurface(
        tint: Color? = nil,
        radius: CGFloat = OpenClawProMetric.cardRadius,
        isProminent: Bool = false) -> some View
    {
        modifier(ProPanelSurfaceModifier(
            tint: tint,
            radius: radius,
            isProminent: isProminent))
    }

    func proInsetSurface(tint: Color, radius: CGFloat) -> some View {
        modifier(ProInsetSurfaceModifier(tint: tint, radius: radius))
    }

    func openClawGlassButton(prominent: Bool = false, tint: Color? = nil) -> some View {
        modifier(OpenClawGlassButtonModifier(prominent: prominent, tint: tint))
    }

    func openClawGlassSurface(radius: CGFloat = OpenClawProMetric.controlRadius) -> some View {
        modifier(OpenClawGlassSurfaceModifier(radius: radius))
    }
}

private struct ProPanelSurfaceModifier: ViewModifier {
    @Environment(\.colorScheme) private var colorScheme
    let tint: Color?
    let radius: CGFloat
    let isProminent: Bool

    func body(content: Content) -> some View {
        content
            .background {
                ProPanelBackground(
                    radius: self.radius,
                    tint: self.tint,
                    isProminent: self.isProminent)
            }
            .shadow(
                color: self.isProminent
                    ? (self.colorScheme == .dark ? .black.opacity(0.14) : .black.opacity(0.045))
                    : .clear,
                radius: self.isProminent ? 5 : 0,
                y: self.isProminent ? 2 : 0)
    }
}

struct ProIconBadge: View {
    let systemName: String
    let color: Color

    var body: some View {
        Image(systemName: self.systemName)
            .font(OpenClawType.captionSemiBold)
            .foregroundStyle(self.color)
            .frame(width: 30, height: 30)
            .background {
                RoundedRectangle(cornerRadius: OpenClawRadius.xs, style: .continuous)
                    .fill(self.color.opacity(0.12))
            }
    }
}

struct OpenClawSidebarHeaderAction {
    let systemName: String
    let accessibilityLabel: OpenClawTextValue
    let accessibilityIdentifier: String?
    let action: () -> Void

    init(
        systemName: String,
        accessibilityLabel: OpenClawTextValue,
        accessibilityIdentifier: String? = nil,
        action: @escaping () -> Void)
    {
        self.systemName = systemName
        self.accessibilityLabel = accessibilityLabel
        self.accessibilityIdentifier = accessibilityIdentifier
        self.action = action
    }
}

struct OpenClawSidebarControlButton: View {
    let headerAction: OpenClawSidebarHeaderAction

    init(action: OpenClawSidebarHeaderAction) {
        self.headerAction = action
    }

    var body: some View {
        if #available(iOS 26.0, *) {
            self.identified(self.button.buttonStyle(.plain))
        } else {
            self.identified(self.button.openClawGlassButton(tint: OpenClawBrand.accent))
        }
    }

    private var button: some View {
        Button(action: self.headerAction.action) {
            self.icon
        }
        .buttonBorderShape(.circle)
        .frame(width: 44, height: 44)
        .contentShape(Rectangle())
        .accessibilityLabel(self.headerAction.accessibilityLabel.text)
    }

    @ViewBuilder
    private var icon: some View {
        let icon = Image(systemName: self.headerAction.systemName)
            .font(OpenClawType.subheadSemiBold)
            .frame(
                width: OpenClawProMetric.compactControlSize,
                height: OpenClawProMetric.compactControlSize)
        if #available(iOS 26.0, *) {
            icon
                .foregroundStyle(OpenClawBrand.accent)
                .glassEffect(
                    .regular.interactive(),
                    in: Circle())
        } else {
            icon
        }
    }

    @ViewBuilder
    private func identified(_ button: some View) -> some View {
        if let accessibilityIdentifier = headerAction.accessibilityIdentifier {
            button.accessibilityIdentifier(accessibilityIdentifier)
        } else {
            button
        }
    }
}

struct OpenClawSidebarHeaderLeadingSlot: View {
    let action: OpenClawSidebarHeaderAction

    var body: some View {
        OpenClawSidebarControlButton(action: self.action)
    }
}

struct OpenClawSidebarToolbarItem: ToolbarContent {
    let action: OpenClawSidebarHeaderAction
    let placement: ToolbarItemPlacement

    @ToolbarContentBuilder
    var body: some ToolbarContent {
        if #available(iOS 26.0, *) {
            ToolbarItem(placement: self.placement) {
                OpenClawSidebarControlButton(action: self.action)
            }
            // The button owns an explicit circular glass shape; suppress the
            // toolbar's shared pill so it cannot stretch the leading control.
            .sharedBackgroundVisibility(.hidden)
        } else {
            ToolbarItem(placement: self.placement) {
                OpenClawSidebarControlButton(action: self.action)
            }
        }
    }
}

struct OpenClawGlassControlGroup<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        if #available(iOS 26.0, *) {
            GlassEffectContainer(spacing: 8) {
                self.content
            }
        } else {
            self.content
        }
    }
}

enum OpenClawNoticeDetail {
    case accent(String)
    case requestID(String)
}

struct OpenClawNoticeBanner: View {
    let icon: String
    let title: OpenClawTextValue
    let message: OpenClawTextValue
    let ownerLabel: OpenClawTextValue
    let tint: Color
    var detail: OpenClawNoticeDetail?
    var primaryActionTitle: OpenClawTextValue?
    var onPrimaryAction: (() -> Void)?
    var secondaryActionTitle: OpenClawTextValue?
    var onSecondaryAction: (() -> Void)?

    var body: some View {
        ProCard(tint: self.tint, padding: 14) {
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .top, spacing: 12) {
                    ProIconBadge(systemName: self.icon, color: self.tint)

                    VStack(alignment: .leading, spacing: 6) {
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            self.title.text
                                .font(OpenClawType.subheadSemiBold)
                                .multilineTextAlignment(.leading)
                            Spacer(minLength: 0)
                            self.ownerLabel.text
                                .font(OpenClawType.captionSemiBold)
                                .foregroundStyle(.secondary)
                        }

                        self.message.text
                            .font(OpenClawType.footnote)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)

                        self.detailView
                    }
                }

                if self.onPrimaryAction != nil || self.onSecondaryAction != nil {
                    OpenClawGlassControlGroup {
                        HStack(spacing: 10) {
                            if let primaryActionTitle, let onPrimaryAction {
                                Button(action: onPrimaryAction) {
                                    primaryActionTitle.text
                                        .font(OpenClawType.captionSemiBold)
                                }
                                .font(OpenClawType.captionSemiBold)
                                .openClawGlassButton(prominent: true)
                                .controlSize(.small)
                            }
                            if let secondaryActionTitle, let onSecondaryAction {
                                Button(action: onSecondaryAction) {
                                    secondaryActionTitle.text
                                        .font(OpenClawType.captionSemiBold)
                                }
                                .font(OpenClawType.captionSemiBold)
                                .openClawGlassButton()
                                .controlSize(.small)
                            }
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var detailView: some View {
        if let detail {
            switch detail {
            case let .accent(value):
                Text(value)
                    .font(OpenClawType.captionMedium)
                    .foregroundStyle(self.tint)
                    .fixedSize(horizontal: false, vertical: true)
            case let .requestID(value):
                Text(verbatim: String(
                    format: String(localized: "Request ID: %@"),
                    value))
                    .font(OpenClawType.monoSmallMedium)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
        }
    }
}

struct OpenClawAdaptiveHeaderRow<Leading: View, Accessory: View>: View {
    let title: OpenClawTextValue
    let subtitle: OpenClawTextValue?
    var titleFont: Font = OpenClawType.title3SemiBold
    var subtitleFont: Font = OpenClawType.subhead
    var subtitleLineLimit: Int? = 2
    @ViewBuilder let leading: Leading
    @ViewBuilder let accessory: Accessory

    init(
        title: OpenClawTextValue,
        subtitle: OpenClawTextValue? = nil,
        titleFont: Font = OpenClawType.title3SemiBold,
        subtitleFont: Font = OpenClawType.subhead,
        subtitleLineLimit: Int? = 2,
        @ViewBuilder leading: () -> Leading,
        @ViewBuilder accessory: () -> Accessory)
    {
        self.title = title
        self.subtitle = subtitle
        self.titleFont = titleFont
        self.subtitleFont = subtitleFont
        self.subtitleLineLimit = subtitleLineLimit
        self.leading = leading()
        self.accessory = accessory()
    }

    var body: some View {
        ViewThatFits(in: .horizontal) {
            self.horizontalLayout
            self.stackedLayout
        }
    }

    private var horizontalLayout: some View {
        HStack(alignment: .top, spacing: 12) {
            self.leading

            self.titleBlock
                .layoutPriority(1)

            Spacer(minLength: 8)

            self.accessory
                .fixedSize(horizontal: true, vertical: false)
        }
    }

    private var stackedLayout: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 12) {
                self.leading

                self.titleBlock
                    .layoutPriority(1)

                Spacer(minLength: 8)
            }

            HStack {
                Spacer(minLength: 0)
                self.accessory
                    .fixedSize(horizontal: true, vertical: false)
            }
        }
    }

    private var titleBlock: some View {
        VStack(alignment: .leading, spacing: 4) {
            self.title.text
                .font(self.titleFont)
                .lineLimit(2)
                .minimumScaleFactor(0.86)
                .fixedSize(horizontal: false, vertical: true)
            if let subtitle {
                subtitle.text
                    .font(self.subtitleFont)
                    .foregroundStyle(.secondary)
                    .lineLimit(self.subtitleLineLimit)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

/// Shared switch indicator replacing the 3 duplicated capsule toggles.
/// Native Toggle only hits the switch edge on iOS 26; this full-width button approach
/// gives the whole row a tap target.
struct OpenClawToggleIndicator: View {
    let isOn: Bool

    var body: some View {
        Capsule()
            .fill(self.isOn ? OpenClawBrand.accent : Color.secondary.opacity(0.35))
            .frame(width: 52, height: 32)
            .overlay(alignment: self.isOn ? .trailing : .leading) {
                Circle()
                    .fill(Color.white)
                    .frame(width: 28, height: 28)
                    .padding(2)
                    .shadow(color: Color.black.opacity(0.14), radius: 1, x: 0, y: 1)
            }
    }
}

enum OpenClawStatusTone {
    case ok
    case warn
    case danger
    case info
    case accent
    case teal
    case muted

    var color: Color {
        switch self {
        case .ok: OpenClawBrand.ok
        case .warn: OpenClawBrand.warn
        case .danger: OpenClawBrand.danger
        case .info: OpenClawBrand.info
        case .accent: OpenClawBrand.accent
        case .teal: OpenClawBrand.teal
        case .muted: OpenClawBrand.textSecondary
        }
    }
}

struct OpenClawStatusBadge: View {
    @Environment(\.colorScheme) private var colorScheme
    let label: OpenClawTextValue
    let tone: OpenClawStatusTone

    var body: some View {
        HStack(spacing: OpenClawSpacing.space1 + 2) {
            Circle()
                .fill(self.tone.color)
                .frame(width: 7, height: 7)
                .shadow(color: self.tone.color.opacity(0.55), radius: 3)
            self.label.text
                .font(OpenClawType.caption2SemiBold)
                .foregroundStyle(self.tone.color)
        }
        .padding(.horizontal, OpenClawSpacing.space2)
        .padding(.vertical, 5)
        .background {
            Capsule()
                .fill(self.tone.color.opacity(self.colorScheme == .dark ? 0.14 : 0.10))
        }
    }
}

struct ProValuePill: View {
    @Environment(\.colorScheme) private var colorScheme
    let value: String
    let color: Color

    var body: some View {
        Text(self.value)
            .font(OpenClawType.footnoteSemiBold)
            .foregroundStyle(self.color)
            .lineLimit(1)
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .background {
                Capsule()
                    .fill(self.color.opacity(self.colorScheme == .dark ? 0.12 : 0.08))
            }
    }
}

struct OpenClawProMark: View {
    var size: CGFloat = 42
    var shadowRadius: CGFloat = 10
    /// Opt-in tap Easter eggs; leave off when the mark sits inside a control.
    var interactive = false

    var body: some View {
        OpenClawMascotView(interactive: self.interactive)
            .frame(width: self.size, height: self.size)
            .shadow(color: OpenClawBrand.accent.opacity(0.18), radius: self.shadowRadius, y: self.shadowRadius / 3)
            .accessibilityLabel("OpenClaw")
    }
}

struct ProProgressBar: View {
    let progress: Double
    var color: Color = OpenClawBrand.accentHot

    var body: some View {
        GeometryReader { proxy in
            let clamped = max(0, min(self.progress, 1))
            ZStack(alignment: .leading) {
                Capsule()
                    .fill(Color.primary.opacity(0.10))
                Capsule()
                    .fill(self.color)
                    .frame(width: proxy.size.width * clamped)
            }
        }
        .frame(height: 3)
    }
}

struct OpenClawGatewayCompactPill: View {
    @Environment(NodeAppModel.self) private var appModel

    var body: some View {
        OpenClawStatusBadge(label: .verbatim(self.title), tone: self.tone)
            .accessibilityLabel(
                String(
                    format: String(localized: "Gateway %@"),
                    self.title))
    }

    private var title: String {
        switch GatewayStatusBuilder.build(appModel: self.appModel) {
        case .connected:
            String(localized: "Online")
        case .connecting:
            String(localized: "Connecting")
        case .error:
            String(localized: "Attention")
        case .disconnected:
            String(localized: "Offline")
        }
    }

    private var tone: OpenClawStatusTone {
        switch GatewayStatusBuilder.build(appModel: self.appModel) {
        case .connected:
            .ok
        case .connecting:
            .accent
        case .error:
            .warn
        case .disconnected:
            .muted
        }
    }
}

struct ProMetricTile: View {
    @Environment(\.colorScheme) private var colorScheme
    let title: OpenClawTextValue
    let value: String
    let icon: String
    let color: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Image(systemName: self.icon)
                    .font(OpenClawType.captionSemiBold)
                    .foregroundStyle(self.color)
                    .frame(width: 24, height: 24)
                    .background(self.color.opacity(self.colorScheme == .dark ? 0.18 : 0.10), in: Circle())
                Spacer(minLength: 4)
            }

            VStack(alignment: .leading, spacing: 2) {
                Text(self.value)
                    .font(OpenClawType.headlineBold)
                    .lineLimit(1)
                    .minimumScaleFactor(0.72)
                self.title.text
                    .font(OpenClawType.caption2Medium)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .padding(11)
        .frame(maxWidth: .infinity, alignment: .leading)
        .proInsetSurface(tint: self.color, radius: OpenClawProMetric.controlRadius)
    }
}

struct ProMetric: Identifiable {
    let id = UUID()
    let icon: String
    let title: OpenClawTextValue
    let value: String
    let color: Color
}

struct ProMetricGrid: View {
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    let metrics: [ProMetric]

    var body: some View {
        LazyVGrid(
            columns: Array(repeating: GridItem(.flexible()), count: self.columnCount),
            spacing: 10)
        {
            ForEach(self.metrics) { metric in
                ProMetricTile(
                    title: metric.title,
                    value: metric.value,
                    icon: metric.icon,
                    color: metric.color)
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    private var columnCount: Int {
        guard self.horizontalSizeClass != .compact else { return 1 }
        return min(max(self.metrics.count, 1), 3)
    }
}

struct ProPanelHeader: View {
    let title: OpenClawTextValue
    var value: String?
    var actionTitle: OpenClawTextValue?
    var actionIcon: String?
    var actionAccessibilityLabel: String?
    var isActionDisabled = false
    var action: (() -> Void)?

    var body: some View {
        HStack(spacing: 8) {
            self.title.text
                .font(OpenClawType.subheadSemiBold)
            if let value {
                Text(value)
                    .font(OpenClawType.caption2Bold)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            self.actionControl
        }
        .padding(.horizontal, 14)
        .padding(.top, 12)
        .padding(.bottom, 8)
    }

    @ViewBuilder
    private var actionControl: some View {
        if let action {
            if let actionIcon {
                Button(action: action) {
                    Image(systemName: actionIcon)
                }
                .accessibilityLabel(
                    self.actionAccessibilityLabel.map { Text(LocalizedStringKey($0)) }
                        ?? actionTitle?.text
                        ?? self.title.text)
                .disabled(self.isActionDisabled)
            } else if let actionTitle {
                Button(action: action) {
                    actionTitle.text
                        .font(OpenClawType.captionSemiBold)
                }
                .disabled(self.isActionDisabled)
            }
        }
    }
}

struct ProStatusRow: View {
    let icon: String
    let title: OpenClawTextValue
    let detail: OpenClawTextValue
    let value: String?
    let color: Color
    var actionTitle: OpenClawTextValue?
    var action: (() -> Void)?

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            ProIconBadge(systemName: self.icon, color: self.color)
            VStack(alignment: .leading, spacing: 4) {
                self.title.text
                    .font(OpenClawType.subheadSemiBold)
                    .lineLimit(1)
                self.detail.text
                    .font(OpenClawType.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 6) {
                if let value {
                    ProValuePill(value: value, color: self.color)
                }
                if let actionTitle, let action {
                    Button(action: action) {
                        actionTitle.text
                            .font(OpenClawType.captionSemiBold)
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.mini)
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }
}
