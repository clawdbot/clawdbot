import SwiftUI

extension View {
    func settingsDetailContent() -> some View {
        self
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 4)
            .padding(.bottom, 16)
    }
}

enum SettingsTextValue: ExpressibleByStringLiteral {
    case localized(LocalizedStringKey)
    case verbatim(String)

    init(stringLiteral value: String) {
        self = .localized(LocalizedStringKey(value))
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

struct SettingsPageHeader: View {
    let title: SettingsTextValue
    let subtitle: SettingsTextValue?

    init(title: SettingsTextValue, subtitle: SettingsTextValue? = nil) {
        self.title = title
        self.subtitle = subtitle
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            self.title.text
                .font(.title3.weight(.semibold))
            if let subtitle {
                subtitle.text
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

struct SettingsCardGroup<Content: View>: View {
    let title: SettingsTextValue
    let content: Content

    init(_ title: SettingsTextValue, @ViewBuilder content: () -> Content) {
        self.title = title
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            self.title.text
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.secondary)

            VStack(alignment: .leading, spacing: 0) {
                self.content
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.quaternary.opacity(0.38), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(.white.opacity(0.055))
            }
        }
    }
}

struct SettingsCardRow<Content: View>: View {
    let title: SettingsTextValue
    let subtitle: SettingsTextValue?
    var showsDivider = true
    let content: Content

    init(
        title: SettingsTextValue,
        subtitle: SettingsTextValue? = nil,
        showsDivider: Bool = true,
        @ViewBuilder content: () -> Content)
    {
        self.title = title
        self.subtitle = subtitle
        self.showsDivider = showsDivider
        self.content = content()
    }

    var body: some View {
        HStack(alignment: .center, spacing: 18) {
            VStack(alignment: .leading, spacing: 3) {
                self.title.text
                    .font(.callout.weight(.medium))
                if let subtitle {
                    subtitle.text
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            Spacer(minLength: 18)

            self.content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
        .overlay(alignment: .bottom) {
            if self.showsDivider {
                Divider()
                    .padding(.leading, 14)
            }
        }
    }
}
