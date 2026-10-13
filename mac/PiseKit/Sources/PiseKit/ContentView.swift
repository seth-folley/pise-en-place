import Foundation
import ComposableArchitecture
import SwiftUI

struct ContentView: View {
    @Bindable var store: StoreOf<DashboardFeature>

    var body: some View {
        VStack(spacing: 12) {
            HStack {
                Label("Pise", systemImage: "chart.bar.xaxis").font(.title3.weight(.semibold))
                Spacer()
                if store.loading { ProgressView().controlSize(.small).accessibilityLabel("Updating reports") }
                Button { store.send(.refreshTapped) } label: { Image(systemName: "arrow.clockwise") }
                    .buttonStyle(.borderless).help("Refresh ledgers").accessibilityLabel("Refresh ledgers")
            }
            Picker("View", selection: $store.tab) {
                ForEach(DashboardFeature.Tab.allCases, id: \.self) { Text($0.rawValue).tag($0) }
            }.pickerStyle(.segmented)
            Picker("Time range", selection: $store.query.range) {
                ForEach(UsageRange.allCases, id: \.self) { Text($0.rawValue).tag($0) }
            }.pickerStyle(.segmented)
            HStack {
                Picker("Project", selection: projectBinding) {
                    Text("All projects").tag("")
                    if let selected = store.query.project, !store.report.projectOptions.contains(where: { $0.id == selected }) {
                        Text((selected as NSString).lastPathComponent).tag(selected)
                    }
                    ForEach(store.report.projectOptions) { project in
                        Text(project.label).tag(project.id)
                    }
                }.labelsHidden().help("Project filter")
                if store.query.hasFilters {
                    Button("Clear filters") { store.send(.clearFiltersTapped) }.font(.caption)
                }
            }
            if store.tab != .skills {
                usageFilters
                Picker("Report metric", selection: $store.query.metric) {
                    ForEach(UsageMetric.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                }.pickerStyle(.segmented)
            }
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    if let failure = store.failure {
                        Label("Could not update: \(failure)", systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.orange)
                    }
                    if store.report.loadedAt == nil {
                        ContentUnavailableView("Loading ledgers", systemImage: "chart.bar")
                    } else {
                        switch store.tab {
                        case .overview:
                            OverviewView(report: store.report, selectProject: selectProject, selectModel: selectModel)
                        case .breakdown:
                            BreakdownView(report: store.report, selectProject: selectProject,
                                          selectModel: selectModel, selectBranch: { store.send(.binding(.set(\.query.branch, $0))) },
                                          selectTag: { store.send(.binding(.set(\.query.tag, $0))) })
                        case .skills:
                            SkillsView(report: store.report, usageFiltersActive: store.query.hasUsageFilters,
                                       selectProject: selectProject)
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, 2)
                .disabled(store.loading)
                .opacity(store.loading && store.report.loadedAt != nil ? 0.6 : 1)
            }
            Divider()
            HStack {
                if let loadedAt = store.report.loadedAt {
                    Text("Read \(loadedAt, style: .relative) ago").font(.caption).foregroundStyle(.secondary)
                } else { Text("Local, read-only").font(.caption).foregroundStyle(.secondary) }
                Spacer()
                Button("Quit") { store.send(.quitTapped) }
                    .buttonStyle(.borderless).keyboardShortcut("q")
            }
        }
        .padding(16)
        .frame(width: 480, height: 640)
        .background(PopoverVisibility(onChange: { store.send(.visibilityChanged($0)) }).frame(width: 0, height: 0))
    }

    private var projectBinding: Binding<String> {
        Binding(get: { store.query.project ?? "" }, set: { selectProject($0.isEmpty ? nil : $0) })
    }

    private func selectProject(_ key: String?) {
        store.send(.projectSelected(key))
    }

    private func selectModel(_ key: String) {
        store.send(.modelSelected(key))
    }

    private var usageFilters: some View {
        HStack {
            filterPicker("Model", options: store.report.modelOptions, selection: $store.query.model)
            if store.query.project != nil {
                filterPicker("Branch", options: store.report.branchOptions, selection: $store.query.branch)
            }
            if !store.report.tagOptions.isEmpty || store.query.tag != nil {
                filterPicker("Tag", options: store.report.tagOptions, selection: $store.query.tag)
            }
        }
    }

    private func filterPicker(_ title: String, options: [String], selection: Binding<String?>) -> some View {
        Picker(title, selection: selection) {
            Text("All \(title.lowercased())s").tag(String?.none)
            if let current = selection.wrappedValue, !options.contains(current) {
                Text(current).tag(Optional(current))
            }
            ForEach(options, id: \.self) { Text($0).tag(Optional($0)) }
        }
        .labelsHidden()
        .help("\(title) filter: \(selection.wrappedValue ?? "All")")
    }
}

#if DEBUG
#Preview {
    let report = PreviewData.report
    ContentView(store: Store(initialState: DashboardFeature.State(query: report.query, report: report, previewOnly: true)) {
        DashboardFeature()
    })
}
#endif
