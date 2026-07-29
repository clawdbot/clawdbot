import Foundation
import SwiftUI

@MainActor
final class PropertyStore: ObservableObject {
    @AppStorage("propertyManager.apiBaseURL") var apiBaseURL: String = "http://100.85.36.72:5062"

    @Published var categories: [MaintenanceCategory] = []
    @Published var tasks: [MaintenanceTask] = []
    @Published var assets: [RanchAsset] = []
    @Published var deepLinkAssetId: UUID?
    @Published var filter: TaskFilter = .all
    @Published var selectedCategory: String = "All"
    @Published var searchText: String = ""
    @Published var isLoading = false
    @Published var isLoadingAssets = false
    @Published var isCompleting = false
    @Published var isSaving = false
    @Published var errorMessage: String?
    @Published var statusMessage: String?

    var client: PropertyAPIClient {
        PropertyAPIClient(baseURLString: apiBaseURL)
    }

    var categoryNames: [String] {
        ["All"] + categories.map(\.name).sorted()
    }

    var filteredTasks: [MaintenanceTask] {
        tasks
            .filter { task in
                if selectedCategory != "All", task.categoryName != selectedCategory {
                    return false
                }
                switch filter {
                case .all:
                    break
                case .due:
                    switch task.dueStatus {
                    case .dueSoon, .overdue, .critical:
                        break
                    case .ok:
                        return false
                    }
                case .overdue:
                    switch task.dueStatus {
                    case .overdue, .critical:
                        break
                    default:
                        return false
                    }
                }
                if !searchText.isEmpty {
                    let needle = searchText.lowercased()
                    let haystack = [
                        task.area,
                        task.item,
                        task.categoryName,
                        task.priority,
                        task.notes ?? "",
                        task.taskDescription ?? "",
                        task.partNumber ?? "",
                        task.vendor ?? "",
                        task.suppliesNeeded ?? "",
                        task.primaryPartNumber ?? "",
                    ].joined(separator: " ").lowercased()
                    if !haystack.contains(needle) {
                        return false
                    }
                }
                return true
            }
            .sorted { lhs, rhs in
                if lhs.dueStatus.sortRank != rhs.dueStatus.sortRank {
                    return lhs.dueStatus.sortRank < rhs.dueStatus.sortRank
                }
                return lhs.nextDue < rhs.nextDue
            }
    }

    var overdueCount: Int {
        tasks.filter {
            switch $0.dueStatus {
            case .overdue, .critical: return true
            default: return false
            }
        }.count
    }

    var dueSoonCount: Int {
        tasks.filter {
            if case .dueSoon = $0.dueStatus { return true }
            return false
        }.count
    }

    func refresh() async {
        isLoading = true
        errorMessage = nil
        statusMessage = nil
        defer { isLoading = false }

        do {
            async let fetchedCategories = client.fetchCategories()
            async let fetchedTasks = client.fetchTasks()
            categories = try await fetchedCategories
            tasks = try await fetchedTasks
            statusMessage = "Updated \(tasks.count) tasks"
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func refreshAssets() async {
        isLoadingAssets = true
        defer { isLoadingAssets = false }
        do {
            assets = try await client.fetchAssets()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func handleDeepLink(_ url: URL) {
        guard url.scheme == "propertymanager" else { return }
        if url.host == "asset" {
            let token = url.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            Task {
                do {
                    let asset = try await client.fetchAssetByQR(token: token)
                    deepLinkAssetId = asset.id
                } catch {
                    errorMessage = error.localizedDescription
                }
            }
        }
    }

    func complete(task: MaintenanceTask, note: String?, meterValue: Double? = nil) async -> Bool {
        isCompleting = true
        errorMessage = nil
        defer { isCompleting = false }

        do {
            let updated = try await client.completeTask(id: task.id, note: note, meterValueAtCompletion: meterValue)
            if let index = tasks.firstIndex(where: { $0.id == updated.id }) {
                tasks[index] = updated
            }
            statusMessage = "Marked \(updated.area) / \(updated.item) done"
            await refreshAssets()
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func saveEdits(taskID: UUID, fields: [String: Any], parts: [[String: Any]]? = nil) async -> Bool {
        isSaving = true
        errorMessage = nil
        defer { isSaving = false }

        do {
            var updated = try await client.updateTask(id: taskID, fields: fields)
            if let parts {
                updated = try await client.replaceParts(taskID: taskID, parts: parts)
            }
            if let index = tasks.firstIndex(where: { $0.id == updated.id }) {
                tasks[index] = updated
            }
            statusMessage = "Saved \(updated.area) / \(updated.item)"
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func delete(task: MaintenanceTask) async -> Bool {
        do {
            try await client.deleteTask(id: task.id)
            tasks.removeAll { $0.id == task.id }
            statusMessage = "Deleted \(task.area) / \(task.item)"
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }
}
