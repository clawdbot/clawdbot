import OpenClawChatUI
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
            radius: OpenClawProMetric.cardRadius)
        {
            self.content
        }
    }
}

struct CommandControlBackground: View {
    var body: some View {
        OpenClawProBackground()
    }
}

struct CommandSessionRow: View {
    let item: CommandCenterTab.WorkItem

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            Image(systemName: self.item.icon)
                .font(OpenClawType.captionSemiBold)
                .foregroundStyle(self.item.color)
                .frame(width: 30, height: 30)
                .background {
                    RoundedRectangle(cornerRadius: OpenClawRadius.sm, style: .continuous)
                        .fill(self.item.color.opacity(0.12))
                }
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    if self.item.isUnread {
                        Circle()
                            .fill(OpenClawBrand.accent)
                            .frame(width: 7, height: 7)
                            .accessibilityHidden(true)
                    }
                    Text(self.item.title)
                        .font(OpenClawType.subheadSemiBold)
                        .lineLimit(1)
                        .minimumScaleFactor(0.82)
                    Spacer(minLength: 6)
                    if self.item.isPinned {
                        Image(systemName: "pin.fill")
                            .font(OpenClawType.caption2Medium)
                            .foregroundStyle(OpenClawBrand.accent)
                            .accessibilityHidden(true)
                    }
                    Text(self.item.trailing)
                        .font(OpenClawType.caption2Medium)
                        .foregroundStyle(.secondary)
                }
                HStack(spacing: 8) {
                    Text(self.item.detail)
                        .font(OpenClawType.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    Spacer(minLength: 6)
                    if let progress = self.item.progress {
                        ProProgressBar(progress: progress, color: self.item.color)
                            .frame(width: 68)
                    }
                    Text(self.progressLabel)
                        .font(OpenClawType.captionSemiBold)
                        .foregroundStyle(self.item.color)
                        .lineLimit(1)
                        .frame(width: 48, alignment: .trailing)
                }
            }
        }
        .padding(.horizontal, 4)
        .padding(.vertical, 6)
        .contentShape(Rectangle())
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
}

struct CommandSessionActions {
    let rename: (String?) -> Void
    let moveToGroup: (String?) -> Void
    let togglePinned: () -> Void
    let toggleUnread: () -> Void
    let fork: () -> Void
    let toggleArchived: () -> Void
    let delete: () -> Void
}

struct CommandSessionActionsModifier: ViewModifier {
    private enum Editor {
        case rename
        case newGroup
    }

    let session: OpenClawChatSessionEntry
    let categories: [String]
    let isArchived: Bool
    let isEnabled: Bool
    let actions: CommandSessionActions

    @State private var editor: Editor?
    @State private var draftText = ""
    @State private var confirmsDelete = false

    func body(content: Content) -> some View {
        if self.isEnabled {
            self.managedContent(content)
        } else {
            content
        }
    }

    private func managedContent(_ content: Content) -> some View {
        content
            .contextMenu {
                if self.isArchived {
                    self.actionButton("Unarchive", systemImage: "archivebox") {
                        self.actions.toggleArchived()
                    }
                    self.deleteButton
                } else {
                    self.actionButton(
                        self.session.pinned == true ? "Unpin" : "Pin",
                        systemImage: self.session.pinned == true ? "pin.slash" : "pin")
                    {
                        self.actions.togglePinned()
                    }
                    self.actionButton(
                        self.session.unread == true ? "Mark as Read" : "Mark as Unread",
                        systemImage: self.session.unread == true ? "envelope.open" : "envelope.badge")
                    {
                        self.actions.toggleUnread()
                    }
                    self.actionButton("Rename…", systemImage: "pencil") {
                        self.beginRename()
                    }
                    self.actionButton("Fork", systemImage: "arrow.triangle.branch") {
                        self.actions.fork()
                    }
                    self.groupMenu
                    self.actionButton("Archive", systemImage: "archivebox") {
                        self.actions.toggleArchived()
                    }
                    self.deleteButton
                }
            }
            .alert(self.editorTitle, isPresented: self.editorBinding) {
                TextField(self.editorPlaceholder, text: self.$draftText)
                    .font(OpenClawType.body)
                Button {
                    self.commitEditor()
                } label: {
                    Text(self.editor == .rename ? "Save" : "Create")
                        .font(OpenClawType.subheadSemiBold)
                }
                Button(role: .cancel) {
                    self.editor = nil
                } label: {
                    Text("Cancel")
                        .font(OpenClawType.subheadSemiBold)
                }
            }
            .confirmationDialog(
                "Delete Session?",
                isPresented: self.$confirmsDelete,
                titleVisibility: .visible)
            {
                Button(role: .destructive) {
                    self.actions.delete()
                } label: {
                    Text("Delete Session")
                        .font(OpenClawType.subheadSemiBold)
                }
                Button(role: .cancel) {} label: {
                    Text("Cancel")
                        .font(OpenClawType.subheadSemiBold)
                }
            } message: {
                Text("This permanently deletes the session and its transcript.")
                    .font(OpenClawType.caption)
            }
    }

    private var groupMenu: some View {
        Menu {
            ForEach(self.categories, id: \.self) { category in
                self.actionButton(category, systemImage: "folder") {
                    self.actions.moveToGroup(category)
                }
            }
            self.actionButton("New Group…", systemImage: "folder.badge.plus") {
                self.draftText = ""
                self.editor = .newGroup
            }
            if self.normalized(self.session.category) != nil {
                self.actionButton("Remove from Group", systemImage: "folder.badge.minus") {
                    self.actions.moveToGroup(nil)
                }
            }
        } label: {
            Label("Move to Group", systemImage: "folder")
                .font(OpenClawType.subhead)
        }
    }

    private var deleteButton: some View {
        Button(role: .destructive) {
            self.confirmsDelete = true
        } label: {
            Label("Delete…", systemImage: "trash")
                .font(OpenClawType.subhead)
        }
    }

    private var editorBinding: Binding<Bool> {
        Binding(
            get: { self.editor != nil },
            set: {
                if !$0 {
                    self.editor = nil
                }
            })
    }

    private var editorTitle: String {
        self.editor == .newGroup ? "New Group" : "Rename Session"
    }

    private var editorPlaceholder: String {
        self.editor == .newGroup ? "Group name" : "Session name"
    }

    private func actionButton(
        _ title: String,
        systemImage: String,
        action: @escaping () -> Void) -> some View
    {
        Button(action: action) {
            Label(title, systemImage: systemImage)
                .font(OpenClawType.subhead)
        }
    }

    private func beginRename() {
        self.draftText = self.normalized(self.session.label)
            ?? self.normalized(self.session.displayName)
            ?? ""
        self.editor = .rename
    }

    private func commitEditor() {
        let value = self.normalized(self.draftText)
        switch self.editor {
        case .rename:
            self.actions.rename(value)
        case .newGroup:
            if let value {
                // Web parity: only prompt-created groups join the stored list,
                // so they survive as empty sections after members leave.
                SessionGroupStore.remember(value)
                self.actions.moveToGroup(value)
            }
        case nil:
            break
        }
        self.editor = nil
    }

    private func normalized(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}

extension View {
    func commandSessionActions(
        session: OpenClawChatSessionEntry,
        categories: [String],
        isArchived: Bool = false,
        isEnabled: Bool = true,
        actions: CommandSessionActions) -> some View
    {
        self.modifier(CommandSessionActionsModifier(
            session: session,
            categories: categories,
            isArchived: isArchived,
            isEnabled: isEnabled,
            actions: actions))
    }
}

struct CommandViewMoreRow: View {
    var body: some View {
        Label("View More", systemImage: "chevron.right")
            .font(OpenClawType.subheadBold)
            .foregroundStyle(OpenClawBrand.accent)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 10)
            .contentShape(Rectangle())
    }
}

struct CommandEmptyStateRow: View {
    let icon: String
    let title: String
    let detail: String

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: self.icon)
                .font(OpenClawType.captionBold)
                .foregroundStyle(OpenClawBrand.ok)
                .frame(width: 30, height: 30)
                .background {
                    RoundedRectangle(cornerRadius: OpenClawRadius.xs, style: .continuous)
                        .fill(OpenClawBrand.ok.opacity(0.10))
                }
            VStack(alignment: .leading, spacing: 2) {
                Text(self.title)
                    .font(OpenClawType.subheadSemiBold)
                    .lineLimit(1)
                Text(self.detail)
                    .font(OpenClawType.caption2Medium)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 4)
        .padding(.vertical, 6)
    }
}
