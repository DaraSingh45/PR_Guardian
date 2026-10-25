export const SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const CATEGORIES = [
  "security",
  "bug",
  "performance",
  "reliability",
  "maintainability",
  "style",
] as const;
export type Category = (typeof CATEGORIES)[number];

/** One changed file from the pull request, with its diff parsed. */
export interface ChangedFile {
  path: string;
  status: string;
  /** Raw unified-diff patch from the GitHub API. */
  patch: string;
  /** New-file line number -> content, for every line visible on the right side of the diff. */
  rightLines: Map<number, string>;
  /** New-file line numbers that were added in this PR. */
  addedLines: Set<number>;
  /** Hunk ranges on the right side; multi-line comments must stay inside one hunk. */
  hunks: Array<{ start: number; end: number }>;
}

/** A finding from Semgrep, already restricted to changed lines. */
export interface SemgrepFinding {
  ruleId: string;
  path: string;
  line: number;
  endLine: number;
  severity: Severity;
  message: string;
}

/** A review comment after validation, ready to post. */
export interface ReviewComment {
  path: string;
  line: number;
  startLine?: number;
  severity: Severity;
  category: Category;
  title: string;
  body: string;
  suggestion?: string;
  source: "llm" | "semgrep" | "llm+semgrep";
  semgrepRule?: string;
}

export interface Config {
  provider: "gemini" | "groq";
  apiKey: string;
  model: string;
  githubToken: string;
  enableSemgrep: boolean;
  semgrepConfig: string[];
  suggestions: boolean;
  minSeverity: Severity;
  maxComments: number;
  maxFiles: number;
  ignorePaths: string[];
  maxCharsPerRequest: number;
}
