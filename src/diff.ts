import type { ChangedFile } from "./types.js";

function patchLines(patch: string): string[] {
  const lines = patch.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parse a unified-diff patch (as returned by the GitHub "list PR files" API)
 * into the right-hand (new file) lines that can receive review comments.
 */
export function parsePatch(path: string, status: string, patch: string): ChangedFile {
  const rightLines = new Map<number, string>();
  const addedLines = new Set<number>();
  const hunks: Array<{ start: number; end: number }> = [];

  let newLine = 0;
  let inHunk = false;
  let hunkStart = 0;

  const closeHunk = () => {
    if (inHunk && newLine > hunkStart) hunks.push({ start: hunkStart, end: newLine - 1 });
  };

  for (const raw of patchLines(patch)) {
    const header = HUNK_HEADER.exec(raw);
    if (header) {
      closeHunk();
      newLine = Number(header[1]);
      hunkStart = newLine;
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (raw.startsWith("\\")) continue; // "\ No newline at end of file"

    const marker = raw[0];
    const content = raw.slice(1);
    if (marker === "+") {
      rightLines.set(newLine, content);
      addedLines.add(newLine);
      newLine++;
    } else if (marker === " " || raw === "") {
      rightLines.set(newLine, content);
      newLine++;
    }
    // "-" lines exist only on the left side and do not advance newLine.
  }
  closeHunk();

  return { path, status, patch, rightLines, addedLines, hunks };
}

/** True when start..end are all on the right side and inside a single hunk. */
export function isCommentableRange(file: ChangedFile, start: number, end: number): boolean {
  if (end < start) return false;
  const hunk = file.hunks.find((h) => start >= h.start && end <= h.end);
  if (!hunk) return false;
  for (let l = start; l <= end; l++) if (!file.rightLines.has(l)) return false;
  return true;
}

/**
 * Render a file's diff with explicit new-file line numbers so the LLM can
 * reference exact lines. Added lines are marked "+", context lines " ",
 * removed lines "-" with no number (they cannot be commented on).
 */
export function renderNumberedDiff(file: ChangedFile): string {
  const out: string[] = [];
  let newLine = 0;
  let inHunk = false;
  for (const raw of patchLines(file.patch)) {
    const header = HUNK_HEADER.exec(raw);
    if (header) {
      newLine = Number(header[1]);
      inHunk = true;
      out.push(raw);
      continue;
    }
    if (!inHunk || raw.startsWith("\\")) continue;
    const marker = raw[0];
    const content = raw.slice(1);
    if (marker === "+") out.push(`${String(newLine++).padStart(5)} + ${content}`);
    else if (marker === "-") out.push(`      - ${content}`);
    else out.push(`${String(newLine++).padStart(5)}   ${content}`);
  }
  return out.join("\n");
}

/** Convert a simple glob (*, **, ?) into a RegExp matching the whole path. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        const slash = glob[i + 2] === "/";
        re += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** Files that are never worth an LLM review. */
export const DEFAULT_IGNORES = [
  "**/package-lock.json",
  "**/yarn.lock",
  "**/pnpm-lock.yaml",
  "**/poetry.lock",
  "**/Cargo.lock",
  "**/go.sum",
  "**/composer.lock",
  "**/*.min.js",
  "**/*.min.css",
  "**/*.map",
  "**/dist/**",
  "**/build/**",
  "**/vendor/**",
  "**/node_modules/**",
  "**/*.snap",
  "**/*.svg",
];

export function isIgnored(path: string, patterns: string[]): boolean {
  return patterns.some((p) => globToRegExp(p).test(path));
}

/** Group files into batches whose rendered diff stays under maxChars. */
export function batchFiles(files: ChangedFile[], maxChars: number): {
  batches: ChangedFile[][];
  tooLarge: string[];
} {
  const batches: ChangedFile[][] = [];
  const tooLarge: string[] = [];
  let current: ChangedFile[] = [];
  let size = 0;

  for (const f of files) {
    const len = renderNumberedDiff(f).length;
    if (len > maxChars) {
      tooLarge.push(f.path);
      continue;
    }
    if (size + len > maxChars && current.length > 0) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(f);
    size += len;
  }
  if (current.length > 0) batches.push(current);
  return { batches, tooLarge };
}
