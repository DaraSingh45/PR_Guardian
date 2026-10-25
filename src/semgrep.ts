import * as core from "@actions/core";
import { getExecOutput } from "@actions/exec";
import { existsSync } from "node:fs";
import type { ChangedFile, SemgrepFinding, Severity } from "./types.js";

interface SemgrepJson {
  results?: Array<{
    check_id: string;
    path: string;
    start: { line: number };
    end: { line: number };
    extra?: { message?: string; severity?: string };
  }>;
  errors?: Array<{ message?: string }>;
}

async function semgrepAvailable(): Promise<boolean> {
  const r = await getExecOutput("semgrep", ["--version"], { ignoreReturnCode: true, silent: true }).catch(
    () => ({ exitCode: 1 }),
  );
  return r.exitCode === 0;
}

/** Install Semgrep Community Edition (free, LGPL-2.1) if the runner does not have it. */
async function ensureSemgrep(): Promise<boolean> {
  if (await semgrepAvailable()) return true;
  core.info("Installing Semgrep Community Edition…");
  const attempts: Array<[string, string[]]> = [
    ["pipx", ["install", "semgrep"]],
    ["python3", ["-m", "pip", "install", "--user", "--quiet", "semgrep"]],
  ];
  for (const [cmd, args] of attempts) {
    const r = await getExecOutput(cmd, args, { ignoreReturnCode: true, silent: true }).catch(() => ({
      exitCode: 1,
    }));
    if (r.exitCode === 0) {
      core.addPath(`${process.env.HOME ?? "~"}/.local/bin`);
      if (await semgrepAvailable()) return true;
    }
  }
  return false;
}

export function mapSemgrepSeverity(s: string | undefined): Severity {
  switch ((s ?? "").toUpperCase()) {
    case "ERROR":
      return "high";
    case "WARNING":
      return "medium";
    default:
      return "low";
  }
}

/** Keep only findings that start on a line visible in the PR diff. */
export function parseSemgrepOutput(json: SemgrepJson, files: ChangedFile[]): SemgrepFinding[] {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const out: SemgrepFinding[] = [];
  for (const r of json.results ?? []) {
    const path = r.path.replace(/^\.?\//, "");
    const file = byPath.get(path);
    if (!file || !file.addedLines.has(r.start.line)) continue;
    out.push({
      ruleId: r.check_id,
      path,
      line: r.start.line,
      endLine: r.end.line,
      severity: mapSemgrepSeverity(r.extra?.severity),
      message: r.extra?.message ?? r.check_id,
    });
  }
  return out;
}

/**
 * Run Semgrep on the changed files only. Any failure is logged and treated as
 * "no findings" so the LLM review still happens.
 */
export async function runSemgrep(files: ChangedFile[], configs: string[]): Promise<SemgrepFinding[]> {
  const targets = files.filter((f) => f.status !== "removed" && existsSync(f.path)).map((f) => f.path);
  if (targets.length === 0) {
    core.warning(
      "Semgrep skipped: changed files were not found on disk. Add actions/checkout with ref: ${{ github.event.pull_request.head.sha }} before PR Guardian.",
    );
    return [];
  }
  if (!(await ensureSemgrep())) {
    core.warning("Semgrep could not be installed; continuing with the LLM review only.");
    return [];
  }

  const args = ["scan", "--json", "--quiet", "--metrics=off", "--disable-version-check", "--timeout", "30"];
  for (const c of configs) args.push("--config", c);
  args.push(...targets);

  const r = await getExecOutput("semgrep", args, { ignoreReturnCode: true, silent: true });
  try {
    const json = JSON.parse(r.stdout) as SemgrepJson;
    for (const e of json.errors ?? []) if (e.message) core.debug(`semgrep: ${e.message}`);
    const findings = parseSemgrepOutput(json, files);
    core.info(`Semgrep: ${findings.length} finding(s) on changed lines.`);
    return findings;
  } catch {
    core.warning(`Semgrep output could not be parsed (exit ${r.exitCode}): ${r.stderr.slice(0, 300)}`);
    return [];
  }
}
