import Foundation
import OpenClawProtocol

extension CronSettings {
    func save(payload: [String: AnyCodable], editor: CronJobsStore.EditorContext) {
        guard self.editor === editor, !editor.isSaving else { return }
        editor.isSaving = true
        editor.error = nil
        // The presented item owns both its source and Save state. A replaced
        // sheet cannot supply authority or receive an older Save completion.
        Task {
            guard self.editor === editor else { return }
            do {
                try await self.store.upsertJob(editor, payload: payload)
                guard self.editor === editor else { return }
                self.editor = nil
            } catch {
                guard self.editor === editor else { return }
                editor.isSaving = false
                editor.error = error.localizedDescription
            }
        }
    }
}
