import { createHash } from "node:crypto";
import type { ChangedFile, ReviewComment, Severity } from "./types.js";

export const SUMMARY_MARKER = "<!-- pr-guardian:summary -->";
const COMMENT_MARKER_RE = /<!-- pr-guardian:([a-f0-9]{12}) -->/;

const BADGE: Record<Severity, string> = {
  critical: "⛔ Critical",
  high: "🔴 High",
  medium: "🟠 Medium",
  low: "🟡 Low",
};

const CATEGORY_LABEL: Record<string, string> = {
  security: "Security",
  bug: "Bug",
  performance: "Performance",
  reliability: "Reliability",
  maintainability: "Maintainability",
  style: "Style",
};

/**
 * A stable ID for a comment, based on the file, the title and the code on the
 * commented line (not the line number, which shifts as new commits arrive).
 * Used to avoid re-posting the same comment on every push.
 */
export function commentId(c: ReviewComment, file: ChangedFile | undefined): string {
  const code = (file?.rightLines.get(c.line) ?? "").trim();
  return createHash("sha1")
    .update(`${c.path}\n${c.title.toLowerCase()}\n${code}`)
    .digest("hex")
    .slice(0, 12);
}

export function extractCommentIds(bodies: string[]): Set<string> {
  const ids = new Set<string>();
  for (const b of bodies) {
    const m = COMMENT_MARKER_RE.exec(b);
    if (m) ids.add(m[1]!);
  }
  return ids;
}

export function formatComment(c: ReviewComment, id: string, modelLabel: string): string {
  const lines: string[] = [];
  lines.push(`<!-- pr-guardian:${id} -->`);
  lines.push(`**${BADGE[c.severity]} · ${CATEGORY_LABEL[c.category] ?? c.category}** — ${c.title}`);
  if (c.body && c.body !== c.title) lines.push("", c.body);
  if (c.suggestion !== undefined) {
    lines.push("", "```suggestion", c.suggestion, "```");
  }
  const sources: string[] = [];
  if (c.source !== "semgrep") sources.push(modelLabel);
  if (c.semgrepRule) sources.push(`Semgrep \`${c.semgrepRule}\``);
  lines.push("", `<sub>PR Guardian · ${sources.join(" + ")}${c.source !== "semgrep" ? " · AI-generated, please verify" : ""}</sub>`);
  return lines.join("\n");
}

export interface SummaryInput {
  modelLabel: string;
  summaries: string[];
  /** Findings shown on the PR after this run (newly posted + already posted earlier). */
  findings: ReviewComment[];
  newComments: number;
  totalFindings: number;
  alreadyPosted: number;
  reviewedFiles: number;
  skippedFiles: string[];
  semgrepEnabled: boolean;
  semgrepCount: number;
  rejectedCount: number;
  errors: string[];
}

export function formatSummary(s: SummaryInput): string {
  const counts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const c of s.findings) counts[c.severity]++;

  const out: string[] = [SUMMARY_MARKER, "## 🛡️ PR Guardian review", ""];
  const overview = s.summaries.filter(Boolean).join("\n\n");
  if (overview) out.push(overview, "");

  if (s.totalFindings === 0 && s.errors.length === 0) {
    out.push("✅ No issues found in the changed lines.", "");
  } else {
    out.push(
      "| Severity | Findings |",
      "| --- | --- |",
      `| ⛔ Critical | ${counts.critical} |`,
      `| 🔴 High | ${counts.high} |`,
      `| 🟠 Medium | ${counts.medium} |`,
      `| 🟡 Low | ${counts.low} |`,
      "",
    );
    const parts = [`${s.newComments} new inline comment(s) posted`];
    if (s.alreadyPosted > 0) parts.push(`${s.alreadyPosted} already commented on in an earlier run`);
    out.push(`${parts.join("; ")}.`, "");
    const hidden = s.totalFindings - s.findings.length;
    if (hidden > 0) out.push(`${hidden} lower-priority finding(s) were not posted because of the \`max-comments\` limit.`, "");
  }

  const details: string[] = [
    `- Files reviewed: ${s.reviewedFiles}`,
    `- LLM: ${s.modelLabel}`,
    `- Semgrep: ${s.semgrepEnabled ? `${s.semgrepCount} finding(s) on changed lines` : "disabled"}`,
  ];
  if (s.rejectedCount > 0) details.push(`- ${s.rejectedCount} AI comment(s) discarded by validation (wrong file/line or malformed)`);
  if (s.skippedFiles.length > 0) details.push(`- Skipped: ${s.skippedFiles.slice(0, 20).map((p) => `\`${p}\``).join(", ")}${s.skippedFiles.length > 20 ? " …" : ""}`);
  for (const e of s.errors) details.push(`- ⚠️ ${e}`);

  out.push("<details><summary>Run details</summary>", "", ...details, "", "</details>", "");
  out.push("<sub>AI-generated review. Verify suggestions before applying them.</sub>");
  return out.join("\n");
}
