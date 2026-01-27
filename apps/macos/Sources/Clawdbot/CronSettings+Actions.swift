import MoltbotProtocol
import Foundation

extension CronSettings {
    func save(payload: [String: AnyCodable]) async {
        guard !self.isSaving else { return }
        self.isSaving = true
        self.editorError = nil
        do {
            try await self.store.upsertJob(id: self.editingJob?.id, payload: payload)
            await MainActor.run {
                self.isSaving = false
                self.showEditor = false
                self.editingJob = nil
            }
        } catch {
            await MainActor.run {
                self.isSaving = false
                self.editorError = error.localizedDescription
            }
        }
    }
}
