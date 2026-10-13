import SwiftUI

struct BreakdownView: View {
    let report: DashboardReport
    let selectProject: (String) -> Void
    let selectModel: (String) -> Void
    let selectBranch: (String) -> Void
    let selectTag: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            LedgerNotices(title: "Usage", status: report.usageStatus)
            if report.usageStatus.available {
                UsageRanking(title: "Projects", rows: report.projects, metric: report.query.metric, selection: selectProject)
                UsageRanking(title: "Models", rows: report.models, metric: report.query.metric, selection: selectModel)
                if report.query.project != nil {
                    UsageRanking(title: "Branches", rows: report.branches, metric: report.query.metric, selection: selectBranch)
                } else {
                    Text("Select a project to see its branch breakdown.").font(.caption).foregroundStyle(.secondary)
                }
                if !report.tags.isEmpty {
                    UsageRanking(title: "Tags", rows: report.tags, metric: report.query.metric, selection: selectTag)
                    Text("A response can have several tags. These totals overlap; don’t add them together.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Divider()
                Text("Token composition").font(.headline)
                HStack {
                    tokenColumn("Input", report.totals.input)
                    tokenColumn("Output", report.totals.output)
                    tokenColumn("Cache read", report.totals.cacheRead)
                    tokenColumn("Cache write", report.totals.cacheWrite)
                }
                Text("Estimates for \(report.totals.costedCalls)/\(report.totals.calls) responses. — means no estimates; * marks a partial subtotal. Cost rankings use known estimates only.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private func tokenColumn(_ title: String, _ value: Double) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.caption).foregroundStyle(.secondary)
            Text(UsageMetric.number(value)).monospacedDigit()
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
}
