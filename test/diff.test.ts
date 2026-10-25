import { describe, expect, it } from "vitest";
import { batchFiles, globToRegExp, isCommentableRange, isIgnored, parsePatch, renderNumberedDiff } from "../src/diff.js";

const PATCH = [
  "@@ -1,4 +1,5 @@",
  " import os",
  "-password = os.environ['PW']",
  "+password = 'hunter2'",
  "+debug = True",
  " ",
  " def main():",
  "@@ -20,2 +21,3 @@ def helper():",
  "     x = 1",
  "+    y = x / 0",
  "     return x",
].join("\n");

describe("parsePatch", () => {
  const f = parsePatch("app.py", "modified", PATCH);

  it("tracks new-file line numbers across removed lines", () => {
    expect(f.rightLines.get(1)).toBe("import os");
    expect(f.rightLines.get(2)).toBe("password = 'hunter2'");
    expect(f.rightLines.get(3)).toBe("debug = True");
    expect(f.rightLines.get(5)).toBe("def main():");
  });

  it("records added lines only", () => {
    expect([...f.addedLines]).toEqual([2, 3, 22]);
  });

  it("splits hunks", () => {
    expect(f.hunks).toEqual([
      { start: 1, end: 5 },
      { start: 21, end: 23 },
    ]);
  });

  it("ignores a trailing newline in the patch", () => {
    const g = parsePatch("a.py", "added", "@@ -0,0 +1,1 @@\n+print(1)\n");
    expect([...g.rightLines.keys()]).toEqual([1]);
  });

  it("only allows ranges inside a single hunk", () => {
    expect(isCommentableRange(f, 2, 3)).toBe(true);
    expect(isCommentableRange(f, 22, 22)).toBe(true);
    expect(isCommentableRange(f, 5, 21)).toBe(false);
    expect(isCommentableRange(f, 10, 10)).toBe(false);
  });

  it("renders a numbered diff for the prompt", () => {
    const out = renderNumberedDiff(f);
    expect(out).toContain("    2 + password = 'hunter2'");
    expect(out).toContain("      - password = os.environ['PW']");
    expect(out).toContain("   22 +     y = x / 0");
  });
});

describe("globs and ignores", () => {
  it("matches ** and *", () => {
    expect(globToRegExp("**/*.min.js").test("web/app.min.js")).toBe(true);
    expect(globToRegExp("**/*.min.js").test("app.min.js")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/a/b.ts")).toBe(false);
    expect(globToRegExp("docs/**").test("docs/a/b.md")).toBe(true);
  });

  it("ignores lockfiles by default", () => {
    expect(isIgnored("package-lock.json", ["**/package-lock.json"])).toBe(true);
    expect(isIgnored("src/index.ts", ["**/package-lock.json"])).toBe(false);
  });
});

describe("batchFiles", () => {
  it("splits files into size-limited batches and flags oversized ones", () => {
    const small = parsePatch("a.ts", "added", "@@ -0,0 +1,1 @@\n+const a = 1;");
    const small2 = parsePatch("b.ts", "added", "@@ -0,0 +1,1 @@\n+const b = 2;");
    const big = parsePatch("big.ts", "added", `@@ -0,0 +1,1 @@\n+${"x".repeat(500)}`);
    const { batches, tooLarge } = batchFiles([small, small2, big], 120);
    expect(tooLarge).toEqual(["big.ts"]);
    expect(batches.flat().map((f) => f.path)).toEqual(["a.ts", "b.ts"]);
  });
});
