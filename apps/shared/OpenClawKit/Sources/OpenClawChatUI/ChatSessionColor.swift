import SwiftUI

/// Gateway color names also match Claude Code's /color palette. These are
/// decorative session hues, independent of warning/error status colors.
public enum OpenClawSessionColor: String, CaseIterable, Sendable {
    case red, blue, green, yellow, purple, orange, pink, cyan

    public init?(name: String?) {
        guard let name else { return nil }
        self.init(rawValue: name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased())
    }

    public var label: String {
        switch self {
        case .red: String(localized: "Red")
        case .blue: String(localized: "Blue")
        case .green: String(localized: "Green")
        case .yellow: String(localized: "Yellow")
        case .purple: String(localized: "Purple")
        case .orange: String(localized: "Orange")
        case .pink: String(localized: "Pink")
        case .cyan: String(localized: "Cyan")
        }
    }

    public func tint(in scheme: ColorScheme) -> Color {
        let rgb = switch (self, scheme == .dark) {
        case (.red, false): (0.72, 0.28, 0.32)
        case (.red, true): (0.91, 0.48, 0.51)
        case (.blue, false): (0.25, 0.44, 0.72)
        case (.blue, true): (0.49, 0.66, 0.94)
        case (.green, false): (0.26, 0.53, 0.37)
        case (.green, true): (0.48, 0.76, 0.57)
        case (.yellow, false): (0.64, 0.51, 0.14)
        case (.yellow, true): (0.87, 0.76, 0.38)
        case (.purple, false): (0.54, 0.36, 0.69)
        case (.purple, true): (0.73, 0.57, 0.88)
        case (.orange, false): (0.72, 0.40, 0.20)
        case (.orange, true): (0.93, 0.63, 0.40)
        case (.pink, false): (0.70, 0.34, 0.52)
        case (.pink, true): (0.92, 0.57, 0.75)
        case (.cyan, false): (0.16, 0.52, 0.59)
        case (.cyan, true): (0.40, 0.75, 0.82)
        }
        return Color(.sRGB, red: rgb.0, green: rgb.1, blue: rgb.2, opacity: 1)
    }
}

public struct OpenClawSessionColorStripe: View {
    @Environment(\.colorScheme) private var colorScheme
    private let color: String?

    public init(color: String?) {
        self.color = color
    }

    public var body: some View {
        if let color = OpenClawSessionColor(name: self.color) {
            RoundedRectangle(cornerRadius: 1.5)
                .fill(color.tint(in: self.colorScheme))
                .frame(width: 3)
                .padding(.vertical, 4)
                .accessibilityHidden(true)
                .allowsHitTesting(false)
        }
    }
}

public struct OpenClawSessionColorDot: View {
    @Environment(\.colorScheme) private var colorScheme
    private let color: String?

    public init(color: String?) {
        self.color = color
    }

    public var body: some View {
        if let color = OpenClawSessionColor(name: self.color) {
            Circle()
                .fill(color.tint(in: self.colorScheme))
                .frame(width: 7, height: 7)
                .accessibilityLabel(String(localized: "Session color") + ": " + color.label)
        }
    }
}

public struct OpenClawSessionColorMenu: View {
    @Environment(\.colorScheme) private var colorScheme
    private let color: String?
    private let onSelect: (String?) -> Void

    public init(color: String?, onSelect: @escaping (String?) -> Void) {
        self.color = color
        self.onSelect = onSelect
    }

    public var body: some View {
        Menu {
            Picker(selection: Binding(
                get: { OpenClawSessionColor(name: self.color)?.rawValue },
                set: { self.onSelect($0) }))
            {
                Text("Default")
                    .font(OpenClawChatTypography.body)
                    .tag(String?.none)
                ForEach(OpenClawSessionColor.allCases, id: \.self) { color in
                    Label {
                        Text(color.label)
                            .font(OpenClawChatTypography.body)
                    } icon: {
                        Image(systemName: "circle.fill")
                            .symbolRenderingMode(.palette)
                            .foregroundStyle(color.tint(in: self.colorScheme))
                    }
                    .tag(Optional(color.rawValue))
                }
            } label: {
                Text("Color")
                    .font(OpenClawChatTypography.body)
            }
            .pickerStyle(.inline)
        } label: {
            Label("Color", systemImage: "paintpalette")
                .font(OpenClawChatTypography.body)
        }
    }
}
