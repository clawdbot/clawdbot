import SwiftUI

enum OpenClawProMetric {
    static let pagePadding: CGFloat = 20
    static let cardRadius: CGFloat = 14
    static let controlRadius: CGFloat = 12
    static let bottomScrollInset: CGFloat = 96
    static let heroRadius: CGFloat = 22
}

struct OpenClawProBackground: View {
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        LinearGradient(
            colors: OpenClawBrand.canvasColors(for: self.colorScheme),
            startPoint: .top,
            endPoint: .bottom)
            .ignoresSafeArea()
            .overlay(alignment: .top) {
                if self.colorScheme == .light {
                    LinearGradient(
                        colors: [
                            OpenClawBrand.accent.opacity(0.05),
                            .clear,
                        ],
                        startPoint: .topTrailing,
                        endPoint: .bottomLeading)
                        .frame(height: 260)
                        .ignoresSafeArea()
                }
            }
    }
}

struct ProSectionHeader: View {
    let title: String
    var actionTitle: String?
    var action: (() -> Void)?
    var uppercase = true

    var body: some View {
        HStack {
            Text(self.title)
                .font(.caption.weight(.medium))
                .foregroundStyle(.secondary)
                .textCase(self.uppercase ? .uppercase : nil)
            Spacer()
            if let actionTitle {
                if let action {
                    Button(actionTitle, action: action)
                        .font(.caption.weight(.medium))
                        .foregroundStyle(OpenClawBrand.accent)
                } else {
                    Text(actionTitle)
                        .font(.caption.weight(.medium))
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
    var padding: CGFloat = 14
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
        let shape = RoundedRectangle(cornerRadius: self.radius, style: .continuous)
        shape
            .fill(self.fill)
            .overlay {
                ProPanelTexture()
                    .opacity(self.colorScheme == .dark ? 0.22 : 0.08)
                    .clipShape(shape)
            }
            .overlay {
                shape.strokeBorder(self.borderStyle, lineWidth: 1)
            }
            .overlay {
                shape
                    .strokeBorder(Color.black.opacity(self.colorScheme == .dark ? 0.40 : 0.055), lineWidth: 0.7)
                    .padding(1)
            }
            .overlay(alignment: .top) {
                shape
                    .strokeBorder(Color.white.opacity(self.colorScheme == .dark ? 0.07 : 0.36), lineWidth: 0.7)
                    .mask(alignment: .top) {
                        Rectangle().frame(height: 28)
                    }
            }
    }

    private var fill: AnyShapeStyle {
        if self.colorScheme == .dark {
            let base = self.isProminent
                ? Color(red: 15 / 255, green: 17 / 255, blue: 19 / 255)
                : Color(red: 10 / 255, green: 12 / 255, blue: 14 / 255)
            return AnyShapeStyle(base)
        }

        let gradient = LinearGradient(
            colors: [
                Color.white.opacity(0.98),
                (self.tint ?? Color.white).opacity(self.tint == nil ? 0.92 : 0.12),
                Color(red: 246 / 255, green: 247 / 255, blue: 249 / 255),
            ],
            startPoint: .topLeading,
            endPoint: .bottomTrailing)
        return AnyShapeStyle(gradient)
    }

    private var borderStyle: AnyShapeStyle {
        if self.colorScheme == .dark {
            return AnyShapeStyle(Color.white.opacity(self.isProminent ? 0.15 : 0.11))
        }

        let gradient = LinearGradient(
            colors: [
                Color.white.opacity(0.72),
                (self.tint ?? OpenClawBrand.accent).opacity(0.10),
                Color.black.opacity(0.08),
            ],
            startPoint: .topLeading,
            endPoint: .bottomTrailing)
        return AnyShapeStyle(gradient)
    }
}

private struct ProPanelTexture: View {
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        Canvas { context, size in
            let color = self.colorScheme == .dark ? Color.white.opacity(0.11) : Color.black.opacity(0.08)
            for y in stride(from: 2.0, through: size.height, by: 6.5) {
                let offset = Int(y / 6.5).isMultiple(of: 2) ? 0.0 : 3.25
                for x in stride(from: 2.0 + offset, through: size.width, by: 6.5) {
                    let dot = CGRect(x: x, y: y, width: 0.7, height: 0.7)
                    context.fill(Path(ellipseIn: dot), with: .color(color))
                }
            }
        }
    }
}

private struct ProLightGlassModifier: ViewModifier {
    @Environment(\.colorScheme) private var colorScheme
    let radius: CGFloat

    func body(content: Content) -> some View {
        if #available(iOS 26.0, *), self.colorScheme == .light {
            content.glassEffect(.regular, in: .rect(cornerRadius: self.radius))
        } else {
            content
        }
    }
}

private struct ProGlassSurfaceModifier: ViewModifier {
    @Environment(\.colorScheme) private var colorScheme
    let fill: Color
    let stroke: Color
    let radius: CGFloat
    let isProminent: Bool
    var interactive = false

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: self.radius, style: .continuous)
        let surfaced = content.background {
            shape
                .fill(self.fill)
                .overlay {
                    shape.strokeBorder(self.stroke, lineWidth: self.isProminent ? 1.2 : 1)
                }
        }

        if #available(iOS 26.0, *), self.colorScheme == .light {
            surfaced.glassEffect(
                self.interactive ? .regular.interactive() : .regular,
                in: .rect(cornerRadius: self.radius))
        } else {
            surfaced
        }
    }
}

extension View {
    func proPanelSurface(
        tint: Color? = nil,
        radius: CGFloat = OpenClawProMetric.cardRadius,
        isProminent: Bool = false) -> some View
    {
        self.modifier(ProPanelSurfaceModifier(
            tint: tint,
            radius: radius,
            isProminent: isProminent))
    }

    func proGlassSurface(
        fill: Color,
        stroke: Color,
        radius: CGFloat,
        isProminent: Bool = false,
        interactive: Bool = false) -> some View
    {
        self.modifier(ProGlassSurfaceModifier(
            fill: fill,
            stroke: stroke,
            radius: radius,
            isProminent: isProminent,
            interactive: interactive))
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
            .modifier(ProLightGlassModifier(radius: self.radius))
            .shadow(
                color: self.colorScheme == .dark ? .black.opacity(0.60) : .black.opacity(0.045),
                radius: self.isProminent ? 20 : 12,
                y: self.isProminent ? 10 : 6)
    }
}

struct ProIconBadge: View {
    let systemName: String
    let color: Color

    var body: some View {
        Image(systemName: self.systemName)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(self.color)
            .frame(width: 34, height: 34)
            .background {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(self.color.opacity(0.12))
            }
    }
}

struct ProStatusDot: View {
    var color: Color

    var body: some View {
        Circle()
            .fill(self.color)
            .frame(width: 8, height: 8)
            .shadow(color: self.color.opacity(0.35), radius: 4)
    }
}

struct ProValuePill: View {
    @Environment(\.colorScheme) private var colorScheme
    let value: String
    let color: Color

    var body: some View {
        Text(self.value)
            .font(.caption.weight(.semibold))
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

    var body: some View {
        Image("OpenClawIcon")
            .resizable()
            .scaledToFit()
            .frame(width: self.size, height: self.size)
            .shadow(color: OpenClawBrand.accent.opacity(0.28), radius: self.shadowRadius, y: self.shadowRadius / 2)
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

struct ProWorkRow: View {
    let icon: String
    let title: String
    let detail: String
    let state: String
    let trailing: String
    let color: Color
    var progress: Double?

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            ProIconBadge(systemName: self.icon, color: self.color)
            VStack(alignment: .leading, spacing: 5) {
                HStack(alignment: .firstTextBaseline) {
                    Text(self.title)
                        .font(.subheadline.weight(.semibold))
                    Spacer(minLength: 8)
                    Text(self.trailing)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                Text(self.detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                HStack(spacing: 8) {
                    if let progress {
                        ProProgressBar(progress: progress, color: self.color)
                            .frame(maxWidth: 120)
                    }
                    Text(self.state)
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(self.color)
                }
            }
        }
        .padding(.vertical, 9)
    }
}

struct ProCapsule: View {
    @Environment(\.colorScheme) private var colorScheme
    let title: String
    let color: Color
    var icon: String?

    var body: some View {
        HStack(spacing: 6) {
            if let icon {
                Image(systemName: icon)
                    .font(.caption.weight(.semibold))
            }
            Text(self.title)
                .font(.caption.weight(.semibold))
        }
        .foregroundStyle(self.color)
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background {
            Capsule()
                .fill(self.color.opacity(self.colorScheme == .dark ? 0.16 : 0.10))
                .overlay {
                    Capsule()
                        .strokeBorder(self.color.opacity(self.colorScheme == .dark ? 0.30 : 0.18), lineWidth: 1)
                }
        }
    }
}

struct ProSegmentedControl: View {
    @Environment(\.colorScheme) private var colorScheme
    let labels: [String]
    @Binding var selection: Int

    var body: some View {
        HStack(spacing: 4) {
            ForEach(Array(self.labels.enumerated()), id: \.offset) { index, label in
                Button {
                    self.selection = index
                } label: {
                    Text(label)
                        .font(.subheadline.weight(self.selection == index ? .semibold : .regular))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 9)
                        .background(self.segmentFill(isSelected: self.selection == index), in: Capsule())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(4)
        .background {
            Capsule()
                .fill(self.trackFill)
                .overlay {
                    Capsule().strokeBorder(self.trackStroke, lineWidth: 1)
                }
        }
    }

    private func segmentFill(isSelected: Bool) -> Color {
        guard isSelected else { return .clear }
        return self.colorScheme == .dark ? Color.white.opacity(0.12) : Color.primary.opacity(0.08)
    }

    private var trackFill: Color {
        self.colorScheme == .dark ? Color.white.opacity(0.045) : Color.white.opacity(0.72)
    }

    private var trackStroke: Color {
        self.colorScheme == .dark ? Color.white.opacity(0.10) : Color.black.opacity(0.06)
    }
}

struct ProHeroActionButton: View {
    @Environment(\.colorScheme) private var colorScheme
    let title: String
    let detail: String
    let systemImage: String
    let action: () -> Void

    var body: some View {
        Button(action: self.action) {
            HStack(spacing: 12) {
                Image(systemName: self.systemImage)
                    .font(.headline.weight(.semibold))
                    .foregroundStyle(.white)
                    .frame(width: 42, height: 42)
                    .background(OpenClawBrand.accentHot, in: RoundedRectangle(cornerRadius: 13, style: .continuous))

                VStack(alignment: .leading, spacing: 3) {
                    Text(self.title)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.primary)
                    Text(self.detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }

                Spacer(minLength: 8)

                Image(systemName: "arrow.right")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(OpenClawBrand.accentHot)
            }
            .padding(12)
            .proGlassSurface(
                fill: self.colorScheme == .dark ? Color.white.opacity(0.045) : Color.white.opacity(0.68),
                stroke: OpenClawBrand.accent.opacity(self.colorScheme == .dark ? 0.22 : 0.14),
                radius: 18,
                isProminent: true,
                interactive: true)
        }
        .buttonStyle(.plain)
    }
}

struct ProMetricTile: View {
    @Environment(\.colorScheme) private var colorScheme
    let title: String
    let value: String
    let icon: String
    let color: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Image(systemName: self.icon)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(self.color)
                    .frame(width: 24, height: 24)
                    .background(self.color.opacity(self.colorScheme == .dark ? 0.18 : 0.10), in: Circle())
                Spacer(minLength: 4)
            }

            VStack(alignment: .leading, spacing: 2) {
                Text(self.value)
                    .font(.headline.weight(.bold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.72)
                Text(self.title)
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .padding(11)
        .frame(maxWidth: .infinity, alignment: .leading)
        .proGlassSurface(
            fill: self.colorScheme == .dark ? Color.white.opacity(0.04) : Color.white.opacity(0.52),
            stroke: self.color.opacity(self.colorScheme == .dark ? 0.18 : 0.10),
            radius: 16)
    }
}

struct ProStatusRow: View {
    let icon: String
    let title: String
    let detail: String
    let value: String
    let color: Color

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            ProIconBadge(systemName: self.icon, color: self.color)
            VStack(alignment: .leading, spacing: 4) {
                Text(self.title)
                    .font(.subheadline.weight(.semibold))
                Text(self.detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            ProValuePill(value: self.value, color: self.color)
        }
        .padding(.vertical, 11)
    }
}

struct ProTimelineRow: View {
    let done: Bool
    let title: String
    let detail: String

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            ProIconBadge(
                systemName: self.done ? "checkmark.circle.fill" : "clock.fill",
                color: self.done ? OpenClawBrand.ok : OpenClawBrand.warn)
            VStack(alignment: .leading, spacing: 3) {
                Text(self.title)
                    .font(.subheadline.weight(.medium))
                Text(self.detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }
}
