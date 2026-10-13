import SwiftUI

struct SkillsView: View {
    let report: DashboardReport
    let usageFiltersActive: Bool
    let selectProject: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Filtered by time range and project only.").font(.caption).foregroundStyle(.secondary)
            if usageFiltersActive {
                Label("Model, branch, and tag filters do not apply here.", systemImage: "line.3.horizontal.decrease.circle")
                    .font(.caption).foregroundStyle(.secondary)
            }
            HStack(spacing: 8) {
                MetricCard(title: "Load events", value: report.skillStatus.available ? "\(report.skillTotals.events)" : "—")
                MetricCard(title: "Known sessions", value: report.skillStatus.available ? "\(report.skillTotals.sessions)" : "—")
                MetricCard(title: "Skills", value: report.skillStatus.available ? "\(report.skills.count)" : "—")
            }
            LedgerNotices(title: "Skills", status: report.skillStatus)
            if report.skillStatus.available {
                Text("\(report.skillTotals.commands) command invocations • \(report.skillTotals.reads) file reads")
                    .font(.caption).foregroundStyle(.secondary)
                if report.skillTotals.unidentifiedEvents > 0 {
                    Text("\(report.skillTotals.unidentifiedEvents) event(s) lack session identity.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                if report.skills.isEmpty {
                    ContentUnavailableView("No skill events", systemImage: "book", description: Text("Skill discovery isn’t a load event. Only commands and recorded file reads appear here."))
                }
                ForEach(report.skills) { skill in
                    DisclosureGroup {
                        Text("\(skill.totals.commands) commands • \(skill.totals.reads) reads • \(skill.totals.sessions) known sessions")
                            .font(.caption).foregroundStyle(.secondary)
                        ForEach(skill.projects.sorted(), id: \.self) { project in
                            Button(projectLabel(project)) { selectProject(project) }
                                .buttonStyle(.plain).font(.caption).lineLimit(2)
                        }
                    } label: {
                        HStack {
                            Text(skill.id).lineLimit(1).truncationMode(.middle)
                            Spacer()
                            Text("\(skill.totals.events)").monospacedDigit().foregroundStyle(.secondary)
                        }
                    }
                }
                if !report.skillProjects.isEmpty {
                    Divider()
                    Text("By project").font(.headline)
                    ForEach(report.skillProjects) { project in
                        Button { selectProject(project.id) } label: {
                            HStack {
                                Text(projectLabel(project.id)).lineLimit(1).truncationMode(.middle)
                                Spacer()
                                Text("\(project.totals.events) events").foregroundStyle(.secondary)
                            }
                        }.buttonStyle(.plain).help(project.id)
                    }
                }
            }
            Text("One task may produce both a command and a read event. Counts measure adoption—not skill effectiveness.")
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    private func projectLabel(_ key: String) -> String {
        report.projectOptions.first(where: { $0.id == key })?.label ?? "Unknown project"
    }
}
