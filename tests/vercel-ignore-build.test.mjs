// Tests for scripts/vercel-ignore-build.sh (Vercel Ignored Build Step).
// Exit 0 = skip the build, exit 1 = build. Runs under node:test or vitest.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const { test } = process.env.VITEST ? await import("vitest") : await import("node:test");

const script = join(dirname(fileURLToPath(import.meta.url)), "../scripts/vercel-ignore-build.sh");
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, env: gitEnv, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

function write(cwd, path, body) {
  mkdirSync(dirname(join(cwd, path)), { recursive: true });
  writeFileSync(join(cwd, path), body);
}

// Builds a repo with a base commit, applies `change`, commits it, and runs the
// script for base..HEAD. `prev` overrides VERCEL_GIT_PREVIOUS_SHA ("" unsets it);
// `breakRepo(cwd, base)` can damage the repo before the script runs.
function run(change, { prev, breakRepo } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "vercel-ignore-"));
  try {
    git(cwd, "init", "-q");
    // Rename detection on, so dropping --no-renames reproduces the original bug.
    git(cwd, "config", "diff.renames", "true");
    write(cwd, "src/app/page.tsx", "export default function Page() {\n  return null;\n}\n");
    write(cwd, "docs/notes.md", "# Notes\n");
    write(cwd, "docs/example.ts", "export const example = 1;\n");
    write(cwd, "README.md", "# Readme\n");
    git(cwd, "add", "-A");
    git(cwd, "commit", "-q", "-m", "base");
    const base = git(cwd, "rev-parse", "HEAD");
    change(cwd);
    git(cwd, "add", "-A");
    git(cwd, "commit", "-q", "--allow-empty", "-m", "change");
    if (breakRepo) breakRepo(cwd, base);
    const env = { ...process.env, VERCEL_GIT_PREVIOUS_SHA: prev ?? base };
    if (prev === "") delete env.VERCEL_GIT_PREVIOUS_SHA;
    const r = spawnSync("bash", [script], { cwd, env, encoding: "utf8" });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

const decide = (change, opts) => run(change, opts).status;

test("docs-only change skips the build", () => {
  assert.equal(decide((cwd) => write(cwd, "docs/notes.md", "# Notes\nmore\n")), 0);
});

test("code change builds", () => {
  assert.equal(decide((cwd) => write(cwd, "src/app/page.tsx", "export default 1;\n")), 1);
});

test("mixed docs and code change builds", () => {
  assert.equal(
    decide((cwd) => {
      write(cwd, "README.md", "# Readme\nmore\n");
      write(cwd, "src/app/page.tsx", "export default 1;\n");
    }),
    1,
  );
});

test("missing previous SHA builds", () => {
  assert.equal(decide((cwd) => write(cwd, "docs/notes.md", "x\n"), { prev: "" }), 1);
});

test("unknown previous SHA builds and shows git's error on stderr", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  const r = run((cwd) => write(cwd, "docs/notes.md", "x\n"), { prev: sha });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /fatal: .*0123456789abcdef/);
});

test("a failing git diff builds and shows git's error on stderr", () => {
  // The previous commit exists, but its tree object is gone, so `git diff` fails.
  const r = run((cwd) => write(cwd, "docs/notes.md", "x\n"), {
    breakRepo(cwd, base) {
      const tree = git(cwd, "rev-parse", `${base}^{tree}`);
      unlinkSync(join(cwd, ".git", "objects", tree.slice(0, 2), tree.slice(2)));
    },
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /fatal|error/);
});

test("a docs-only skip writes nothing to stderr", () => {
  const r = run((cwd) => write(cwd, "docs/notes.md", "# Notes\nmore\n"));
  assert.equal(r.status, 0);
  assert.equal(r.stderr, "");
  assert.match(r.stdout, /skipping build/);
});

test("empty diff builds", () => {
  assert.equal(decide(() => {}), 1);
});

test("renaming a code file into docs/ builds", () => {
  assert.equal(
    decide((cwd) => renameSync(join(cwd, "src/app/page.tsx"), join(cwd, "docs/page.tsx"))),
    1,
  );
});

test("renaming a docs file into src/ builds", () => {
  assert.equal(
    decide((cwd) => {
      mkdirSync(join(cwd, "src/lib"), { recursive: true });
      renameSync(join(cwd, "docs/example.ts"), join(cwd, "src/lib/example.ts"));
    }),
    1,
  );
});

test("renaming within docs skips the build", () => {
  assert.equal(
    decide((cwd) => renameSync(join(cwd, "docs/notes.md"), join(cwd, "docs/renamed-notes.md"))),
    0,
  );
});
