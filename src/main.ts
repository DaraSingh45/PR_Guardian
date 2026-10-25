import * as core from "@actions/core";
import * as github from "@actions/github";
import { batchFiles, DEFAULT_IGNORES, isIgnored, parsePatch } from "./diff.js";
import { createProvider, DEFAULT_MODELS, ProviderError } from "./providers/index.js";
import { buildUserPrompt, SYSTEM_PROMPT } from "./prompt.js";
import {
  commentId,
  extractCommentIds,
  formatComment,
  formatSummary,
  SUMMARY_MARKER,
} from "./review.js";
import { runSemgrep } from "./semgrep.js";
import { SEVERITIES, type ChangedFile, type Config, type ReviewComment, type Severity } from "./types.js";
import {
  extractJson,
  finalizeComments,
  mergeFindings,
  severityRank,
  validateLlmReview,
} from "./validate.js";

type Octokit = ReturnType<typeof github.getOctokit>;

export function readConfig(): Config {
  const provider = core.getInput("llm-provider").trim().toLowerCase() || "gemini";
  if (provider !== "gemini" && provider !== "groq") {
    throw new Error(`llm-provider must be "gemini" or "groq", got "${provider}"`);
  }
  const minSeverity = (core.getInput("min-severity").trim().toLowerCase() || "low") as Severity;
  if (!SEVERITIES.includes(minSeverity)) {
    throw new Error(`min-severity must be one of ${SEVERITIES.join(", ")}`);
  }
  const apiKey = core.getInput("api-key");
  if (apiKey) core.setSecret(apiKey);

  return {
    provider,
    apiKey,
    model: core.getInput("model").trim() || DEFAULT_MODELS[provider],
    githubToken: core.getInput("github-token", { required: true }),
    enableSemgrep: core.getBooleanInput("enable-semgrep"),
    semgrepConfig: splitList(core.getInput("semgrep-config") || "p/default"),
    suggestions: core.getBooleanInput("suggestions"),
    minSeverity,
    maxComments: positiveInt(core.getInput("max-comments"), 15),
    maxFiles: positiveInt(core.getInput("max-files"), 30),
    ignorePaths: splitList(core.getInput("ignore-paths")),
    maxCharsPerRequest: positiveInt(core.getInput("max-chars-per-request"), 24000),
  };
}

export async function run(): Promise<void> {
  const ctx = github.context;
  const pr = ctx.payload.pull_request;
  if (!pr) {
    core.warning(`PR Guardian only runs on pull_request events (got "${ctx.eventName}"). Nothing to do.`);
    return;
  }
  if (ctx.eventName === "pull_request_target") {
    core.warning(
      "Running on pull_request_target. Make sure you do not check out and execute untrusted fork code with write permissions.",
    );
  }

  const cfg = readConfig();
  const { owner, repo } = ctx.repo;
  const prNumber: number = pr.number;
  const headSha: string = pr.head.sha;

  if (!cfg.apiKey) {
    const isFork = pr.head?.repo?.full_name !== `${owner}/${repo}`;
    if (isFork) {
      core.notice("No API key available (secrets are not passed to pull requests from forks). Skipping PR Guardian.");
      return;
    }
    throw new Error("api-key is empty. Add your Gemini or Groq key as a repository secret and pass it to the action.");
  }

  const octokit = github.getOctokit(cfg.githubToken);
  const provider = createProvider(cfg.provider, cfg.apiKey, cfg.model, process.env);
  const modelLabel = `${provider.name}/${provider.model}`;
  core.info(`PR Guardian reviewing ${owner}/${repo}#${prNumber} with ${modelLabel}`);

  // 1. Collect and parse the changed files.
  const rawFiles = await octokit.paginate(octokit.rest.pulls.listFiles, {
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  });
  const ignores = [...DEFAULT_IGNORES, ...cfg.ignorePaths];
  const skippedFiles: string[] = [];
  const files: ChangedFile[] = [];
  for (const f of rawFiles) {
    if (f.status === "removed") continue;
    if (!f.patch) {
      skippedFiles.push(`${f.filename} (binary or too large)`);
      continue;
    }
    if (isIgnored(f.filename, ignores)) continue;
    if (files.length >= cfg.maxFiles) {
      skippedFiles.push(`${f.filename} (max-files limit)`);
      continue;
    }
    files.push(parsePatch(f.filename, f.status, f.patch));
  }
  core.info(`${files.length} file(s) to review, ${skippedFiles.length} skipped.`);

  if (files.length === 0) {
    await upsertSummary(octokit, owner, repo, prNumber, formatSummary({
      modelLabel, summaries: ["No reviewable code changes in this pull request."], findings: [], newComments: 0, totalFindings: 0,
      alreadyPosted: 0, reviewedFiles: 0, skippedFiles, semgrepEnabled: cfg.enableSemgrep, semgrepCount: 0,
      rejectedCount: 0, errors: [],
    }));
    setOutputs(0, 0, []);
    return;
  }

  // 2. Deterministic static analysis.
  const semgrep = cfg.enableSemgrep ? await runSemgrep(files, cfg.semgrepConfig) : [];

  // 3. LLM review, in batches that fit the provider's context window.
  const { batches, tooLarge } = batchFiles(files, cfg.maxCharsPerRequest);
  for (const p of tooLarge) skippedFiles.push(`${p} (diff too large for one request)`);

  const summaries: string[] = [];
  const llmComments: ReviewComment[] = [];
  const errors: string[] = [];
  let rejectedCount = 0;
  let failedBatches = 0;

  for (const [i, batch] of batches.entries()) {
    core.startGroup(`LLM batch ${i + 1}/${batches.length} (${batch.length} file(s))`);
    try {
      const prompt = buildUserPrompt(pr.title ?? "", pr.body ?? "", batch, semgrep, cfg.suggestions);
      const reply = await provider.complete(SYSTEM_PROMPT, prompt);
      const result = validateLlmReview(extractJson(reply), batch, { suggestions: cfg.suggestions });
      if (result.summary) summaries.push(result.summary);
      llmComments.push(...result.comments);
      rejectedCount += result.rejected.length;
      for (const r of result.rejected) core.info(`Discarded AI comment: ${r.reason}`);
      core.info(`Accepted ${result.comments.length}, discarded ${result.rejected.length}.`);
    } catch (err) {
      failedBatches++;
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`LLM request failed for batch ${i + 1}: ${msg.slice(0, 200)}`);
      core.warning(`LLM batch ${i + 1} failed: ${msg}`);
      if (err instanceof ProviderError && (err.status === 401 || err.status === 403)) {
        core.endGroup();
        break; // bad key: no point retrying other batches
      }
    }
    core.endGroup();
  }

  // 4. Merge, filter, de-duplicate against earlier runs.
  const merged = mergeFindings(llmComments, semgrep, files);
  const { kept, total } = finalizeComments(merged, cfg.minSeverity, cfg.maxComments);

  const existing = await octokit.paginate(octokit.rest.pulls.listReviewComments, {
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  });
  const existingIds = extractCommentIds(existing.map((c) => c.body ?? ""));
  const byPath = new Map(files.map((f) => [f.path, f]));

  const toPost: Array<{ comment: ReviewComment; body: string }> = [];
  let alreadyPosted = 0;
  for (const c of kept) {
    const id = commentId(c, byPath.get(c.path));
    if (existingIds.has(id)) {
      alreadyPosted++;
      continue;
    }
    toPost.push({ comment: c, body: formatComment(c, id, modelLabel) });
  }

  // 5. Post inline comments as one review, then the summary comment.
  const posted = await postReview(octokit, owner, repo, prNumber, headSha, toPost);

  await upsertSummary(
    octokit,
    owner,
    repo,
    prNumber,
    formatSummary({
      modelLabel,
      summaries,
      // Comments that failed to post are excluded; everything else in `kept` is now on the PR.
      findings: kept.filter((c) => posted.includes(c) || !toPost.some((t) => t.comment === c)),
      newComments: posted.length,
      totalFindings: total,
      alreadyPosted,
      reviewedFiles: files.length,
      skippedFiles,
      semgrepEnabled: cfg.enableSemgrep,
      semgrepCount: semgrep.length,
      rejectedCount,
      errors,
    }),
  );

  setOutputs(posted.length, total, kept);

  if (batches.length > 0 && failedBatches === batches.length) {
    core.setFailed(`Every LLM request failed. Last error: ${errors.at(-1) ?? "unknown"}`);
  }
}

async function postReview(
  octokit: Octokit,
  owner: string,
  repo: string,
  pull_number: number,
  commit_id: string,
  items: Array<{ comment: ReviewComment; body: string }>,
): Promise<ReviewComment[]> {
  if (items.length === 0) return [];
  const toApi = ({ comment: c, body }: { comment: ReviewComment; body: string }) => ({
    path: c.path,
    line: c.line,
    side: "RIGHT" as const,
    ...(c.startLine !== undefined ? { start_line: c.startLine, start_side: "RIGHT" as const } : {}),
    body,
  });

  try {
    await octokit.rest.pulls.createReview({
      owner,
      repo,
      pull_number,
      commit_id,
      event: "COMMENT",
      body: `PR Guardian left ${items.length} comment(s). See the summary comment for an overview.`,
      comments: items.map(toApi),
    });
    return items.map((i) => i.comment);
  } catch (err) {
    // One bad position makes GitHub reject the whole review (HTTP 422).
    // Fall back to posting comments individually and skip the ones that fail.
    core.warning(`Batch review failed (${(err as Error).message}); posting comments one by one.`);
    const posted: ReviewComment[] = [];
    for (const item of items) {
      try {
        await octokit.rest.pulls.createReviewComment({ owner, repo, pull_number, commit_id, ...toApi(item) });
        posted.push(item.comment);
      } catch (e) {
        core.warning(`Could not comment on ${item.comment.path}:${item.comment.line}: ${(e as Error).message}`);
      }
    }
    return posted;
  }
}

async function upsertSummary(octokit: Octokit, owner: string, repo: string, issue_number: number, body: string) {
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner,
    repo,
    issue_number,
    per_page: 100,
  });
  const mine = comments.find((c) => c.body?.includes(SUMMARY_MARKER));
  if (mine) await octokit.rest.issues.updateComment({ owner, repo, comment_id: mine.id, body });
  else await octokit.rest.issues.createComment({ owner, repo, issue_number, body });
}

function setOutputs(posted: number, total: number, kept: ReviewComment[]) {
  const highest = kept.reduce<Severity | "none">(
    (acc, c) => (acc === "none" || severityRank(c.severity) > severityRank(acc) ? c.severity : acc),
    "none",
  );
  core.setOutput("comments-posted", posted);
  core.setOutput("findings-total", total);
  core.setOutput("highest-severity", highest);
}

function splitList(s: string): string[] {
  return s
    .split(/[,\n]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function positiveInt(s: string, fallback: number): number {
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Only auto-run when executed as the action entry point, not when imported by tests.
if (!process.env.VITEST) {
  run().catch((err: unknown) => core.setFailed(err instanceof Error ? err.message : String(err)));
}
