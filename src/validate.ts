import { isCommentableRange } from "./diff.js";
import {
  CATEGORIES,
  SEVERITIES,
  type Category,
  type ChangedFile,
  type ReviewComment,
  type SemgrepFinding,
  type Severity,
} from "./types.js";

export const severityRank = (s: Severity) => SEVERITIES.indexOf(s);

/**
 * Pull the JSON object out of an LLM reply. Models sometimes wrap JSON in
 * ```json fences or add a sentence before it, even in JSON mode.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = fenced ? fenced[1]!.trim() : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1));
    }
    throw new Error("LLM reply did not contain valid JSON");
  }
}

export interface ValidationResult {
  summary: string;
  comments: ReviewComment[];
  rejected: Array<{ reason: string; raw: unknown }>;
}

/**
 * Treat the model's output as untrusted: check every field, every path and
 * every line number against the real diff, and drop anything that does not fit.
 */
export function validateLlmReview(
  raw: unknown,
  files: ChangedFile[],
  opts: { suggestions: boolean },
): ValidationResult {
  const rejected: ValidationResult["rejected"] = [];
  const byPath = new Map(files.map((f) => [f.path, f]));

  if (typeof raw !== "object" || raw === null) {
    return { summary: "", comments: [], rejected: [{ reason: "reply is not an object", raw }] };
  }
  const obj = raw as Record<string, unknown>;
  const summary = typeof obj.summary === "string" ? clean(obj.summary, 1200) : "";
  const list = Array.isArray(obj.comments) ? obj.comments : [];

  const comments: ReviewComment[] = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null) {
      rejected.push({ reason: "comment is not an object", raw: item });
      continue;
    }
    const c = item as Record<string, unknown>;
    const path = typeof c.path === "string" ? c.path.replace(/^\.?\//, "") : "";
    const file = byPath.get(path);
    if (!file) {
      rejected.push({ reason: `unknown path "${String(c.path)}"`, raw: item });
      continue;
    }

    const line = toInt(c.line);
    let startLine = toInt(c.start_line);
    if (line === undefined) {
      rejected.push({ reason: "missing line", raw: item });
      continue;
    }
    if (startLine !== undefined && startLine >= line) startLine = undefined;
    if (!isCommentableRange(file, startLine ?? line, line)) {
      rejected.push({ reason: `line ${startLine ?? line}-${line} not in diff of ${path}`, raw: item });
      continue;
    }

    const severity = normalizeEnum(c.severity, SEVERITIES) ?? "medium";
    const category = normalizeEnum(c.category, CATEGORIES) ?? "bug";
    const title = clean(typeof c.title === "string" ? c.title : "", 120);
    const body = clean(typeof c.body === "string" ? c.body : "", 2000);
    if (!title && !body) {
      rejected.push({ reason: "empty comment", raw: item });
      continue;
    }

    let suggestion: string | undefined;
    if (opts.suggestions && typeof c.suggestion === "string") {
      suggestion = checkSuggestion(c.suggestion, file, startLine ?? line, line);
    }

    comments.push({
      path,
      line,
      ...(startLine !== undefined ? { startLine } : {}),
      severity,
      category,
      title: title || firstSentence(body),
      body,
      ...(suggestion !== undefined ? { suggestion } : {}),
      source: "llm",
    });
  }

  return { summary, comments, rejected };
}

/**
 * Keep a suggested fix only if it is safe to render: no code fences that would
 * break the markdown block, a sane size, and actually different from the
 * original lines.
 */
export function checkSuggestion(
  suggestion: string,
  file: ChangedFile,
  start: number,
  end: number,
): string | undefined {
  const s = suggestion.replace(/\r\n/g, "\n").replace(/\n+$/, "");
  if (s.includes("```")) return undefined;
  if (s.split("\n").length > Math.max(20, (end - start + 1) * 4)) return undefined;
  const original: string[] = [];
  for (let l = start; l <= end; l++) original.push(file.rightLines.get(l) ?? "");
  if (s.trim() === original.join("\n").trim()) return undefined;
  return s;
}

/**
 * Merge deterministic Semgrep findings with LLM comments. If the LLM already
 * commented on the same line, annotate that comment instead of posting twice.
 */
export function mergeFindings(
  llm: ReviewComment[],
  semgrep: SemgrepFinding[],
  files: ChangedFile[],
): ReviewComment[] {
  const out = [...llm];
  const byPath = new Map(files.map((f) => [f.path, f]));
  for (const f of semgrep) {
    const match = out.find(
      (c) => c.path === f.path && f.line >= (c.startLine ?? c.line) - 1 && f.line <= c.line + 1,
    );
    if (match) {
      match.source = "llm+semgrep";
      match.semgrepRule = f.ruleId;
      if (severityRank(f.severity) > severityRank(match.severity)) match.severity = f.severity;
      continue;
    }
    const file = byPath.get(f.path);
    if (!file || !isCommentableRange(file, f.line, f.line)) continue;
    out.push({
      path: f.path,
      line: f.line,
      severity: f.severity,
      category: "security",
      title: `Semgrep: ${shortRule(f.ruleId)}`,
      body: clean(f.message, 1500),
      source: "semgrep",
      semgrepRule: f.ruleId,
    });
  }
  return out;
}

/** Filter by minimum severity, drop duplicates, sort worst-first and cap the count. */
export function finalizeComments(
  comments: ReviewComment[],
  minSeverity: Severity,
  max: number,
): { kept: ReviewComment[]; total: number } {
  const seen = new Set<string>();
  const filtered = comments.filter((c) => {
    if (severityRank(c.severity) < severityRank(minSeverity)) return false;
    const key = `${c.path}:${c.line}:${c.title.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  filtered.sort(
    (a, b) =>
      severityRank(b.severity) - severityRank(a.severity) ||
      a.path.localeCompare(b.path) ||
      a.line - b.line,
  );
  return { kept: filtered.slice(0, max), total: filtered.length };
}

function toInt(v: unknown): number | undefined {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : undefined;
}

function normalizeEnum<T extends string>(v: unknown, allowed: readonly T[]): T | undefined {
  if (typeof v !== "string") return undefined;
  const lower = v.trim().toLowerCase();
  return allowed.find((a) => a === lower);
}

/** Strip control characters and neutralise @mentions so a model can't ping people. */
export function clean(s: string, max: number): string {
  const out = s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/@(?=[A-Za-z0-9-])/g, "@​")
    .trim();
  return out.length > max ? `${out.slice(0, max)}…` : out;
}

function firstSentence(s: string): string {
  const m = /^(.{1,100}?[.!?])(\s|$)/.exec(s);
  return m ? m[1]! : s.slice(0, 100);
}

function shortRule(id: string): string {
  return id.split(".").slice(-1)[0] ?? id;
}

export type { Category };
