import SwiftUI

struct ContextRootMenuLabelView: View {
    let subtitle: String
    let width: CGFloat
    @Environment(\.menuItemHighlighted) private var isHighlighted

    private var palette: MenuItemHighlightColors.Palette {
        MenuItemHighlightColors.palette(self.isHighlighted)
    }

    private var usesStackedLayout: Bool {
        self.subtitle.count > 28 || self.subtitle.contains("\n")
    }

    var body: some View {
        HStack(alignment: self.usesStackedLayout ? .top : .firstTextBaseline, spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Context")
                    .font(.callout.weight(.semibold))
                    .foregroundStyle(self.palette.primary)
                    .lineLimit(1)

                if self.usesStackedLayout {
                    self.subtitleText
                        .lineLimit(3)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .layoutPriority(1)

            Spacer(minLength: 8)

            if !self.usesStackedLayout {
                self.subtitleText
                    .lineLimit(1)
                    .layoutPriority(2)
            }

            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(self.palette.secondary)
                .padding(.leading, 2)
                .padding(.top, self.usesStackedLayout ? 2 : 0)
        }
        .padding(.vertical, self.usesStackedLayout ? 7 : 8)
        .padding(.leading, 22)
        .padding(.trailing, 14)
        .frame(width: max(1, self.width), alignment: .leading)
    }

    private var subtitleText: some View {
        Text(self.subtitle)
            .font(.caption.monospacedDigit())
            .foregroundStyle(self.palette.secondary)
            .multilineTextAlignment(.leading)
            .truncationMode(.tail)
    }
}
