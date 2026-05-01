import SwiftUI

struct ContextRootMenuLabelView: View {
    let subtitle: String
    let width: CGFloat
    @Environment(\.menuItemHighlighted) private var isHighlighted

    private var palette: MenuItemHighlightColors.Palette {
        MenuItemHighlightColors.palette(self.isHighlighted)
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text("Context")
                .font(.callout.weight(.semibold))
                .foregroundStyle(self.palette.primary)
                .lineLimit(1)
                .layoutPriority(1)

            Spacer(minLength: 8)

            Text(self.subtitle)
                .font(.caption.monospacedDigit())
                .foregroundStyle(self.palette.secondary)
                .lineLimit(1)
                .truncationMode(.tail)
                .layoutPriority(2)

            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(self.palette.secondary)
                .padding(.leading, 2)
        }
        .padding(.vertical, 8)
        .padding(.leading, 22)
        .padding(.trailing, 14)
        .frame(width: max(1, self.width), alignment: .leading)
    }
}
