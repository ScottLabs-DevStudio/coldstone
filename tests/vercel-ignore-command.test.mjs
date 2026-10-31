// Tests for the vercel.json "ignoreCommand" gate itself (not just the script).
// Runs the exact ignoreCommand string from vercel.json under bash, with the
// Vercel git env set, inside a temp repo that holds a copy of the script.
// Exit 0 = skip the build, non-zero = build. Runs under node:test or vitest.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const { test } = process.env.VITEST ? await import("vitest") : await import("node:test");

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const { ignoreCommand } = JSON.parse(readFileSync(join(root, "vercel.json"), "utf8"));
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

// Builds a temp repo with a base commit and one change (code or docs-only),
// then runs the configured ignoreCommand with the given ref and message.
function decide({ ref, message, change }) {
  const cwd = mkdtempSync(join(tmpdir(), "vercel-gate-"));
  try {
    git(cwd, "init", "-q");
    write(cwd, "src/app/page.tsx", "export default function Page() {\n  return null;\n}\n");
    write(cwd, "docs/notes.md", "# Notes\n");
    mkdirSync(join(cwd, "scripts"), { recursive: true });
    copyFileSync(join(root, "scripts/vercel-ignore-build.sh"), join(cwd, "scripts/vercel-ignore-build.sh"));
    git(cwd, "add", "-A");
    git(cwd, "commit", "-q", "-m", "base");
    const base = git(cwd, "rev-parse", "HEAD");
    if (change === "docs") write(cwd, "docs/notes.md", "# Notes\nmore\n");
    else write(cwd, "src/app/page.tsx", "export default 1;\n");
    git(cwd, "add", "-A");
    git(cwd, "commit", "-q", "-m", message);
    const env = {
      ...process.env,
      VERCEL_GIT_COMMIT_REF: ref,
      VERCEL_GIT_COMMIT_MESSAGE: message,
      VERCEL_GIT_PREVIOUS_SHA: base,
    };
    return spawnSync("bash", ["-c", ignoreCommand], { cwd, env, encoding: "utf8" }).status;
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

test("vercel.json has exactly one ignoreCommand and it wraps the docs-only script", () => {
  const raw = readFileSync(join(root, "vercel.json"), "utf8");
  assert.equal(raw.match(/"ignoreCommand"/g)?.length, 1);
  assert.match(ignoreCommand, /then bash scripts\/vercel-ignore-build\.sh; else exit 0; fi$/);
});

test("main with a code change builds", () => {
  assert.notEqual(decide({ ref: "main", message: "feat: code", change: "code" }), 0);
});

test("main with a docs-only change still goes through the docs-only check and skips", () => {
  assert.equal(decide({ ref: "main", message: "docs: notes", change: "docs" }), 0);
});

test("untagged feature branch with a code change skips", () => {
  assert.equal(decide({ ref: "feat/thing", message: "feat: code", change: "code" }), 0);
});

test("feature branch tagged [preview] with a code change builds", () => {
  assert.notEqual(decide({ ref: "feat/thing", message: "feat: code [preview]", change: "code" }), 0);
});

test("feature branch tagged [preview] with a docs-only change goes through the docs-only check and skips", () => {
  assert.equal(decide({ ref: "feat/thing", message: "docs: notes [preview]", change: "docs" }), 0);
});

test("branch named mainline is not main and skips", () => {
  assert.equal(decide({ ref: "mainline", message: "feat: code", change: "code" }), 0);
});

test("untagged message containing 'preview' without brackets skips", () => {
  assert.equal(decide({ ref: "feat/thing", message: "feat: preview tweaks", change: "code" }), 0);
});
