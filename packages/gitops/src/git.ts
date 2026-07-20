// Thin wrapper over the git CLI (ARCHITECTURE §3.3: git access = shell out to `git`).
// The controller owns a working copy; the reconciler drives it toward a target revision.

// Auth: the credential is held in memory and handed to git through a per-call credential
// helper that reads it from the process environment. The token is therefore NEVER put in a
// remote URL, in argv, in .git/config, or in an error message.
let authToken: string | undefined;
export function setGitToken(token?: string): void { authToken = token || undefined; }
// git strips the leading '!' and runs the rest in a shell; `f` prints the credential from
// $GIT_TOKEN (which we pass in the child env), so the secret stays out of the command line.
const CRED_HELPER = '!f() { echo username=x-access-token; echo "password=$GIT_TOKEN"; }; f';

/** Belt-and-suspenders: scrub any credential that still reaches a log/error line. */
export const redact = (s: string) =>
  s.replace(/(x-access-token:)[^@\s]+/g, "$1***").replace(/(password=)\S+/g, "$1***");

async function git(args: string[], cwd?: string): Promise<string> {
  const auth = authToken ? ["-c", `credential.helper=${CRED_HELPER}`] : [];
  const proc = Bun.spawn(["git", ...auth, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    ...(authToken ? { env: { ...process.env, GIT_TOKEN: authToken } } : {}),
  });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  // Redact the WHOLE message — the failing args can contain a URL/header, not just the output.
  if (code !== 0) throw new Error(redact(`git ${args.join(" ")} failed: ${(err || out).trim()}`));
  return out.trim();
}

export const Git = {
  setToken: setGitToken,
  clone: (url: string, dir: string) => git(["clone", "--quiet", url, dir]),
  /**
   * Materialize `url`@`branch` into a NON-empty `dir` (git clone refuses those — e.g. a k8s
   * PVC's `lost+found`). init → add remote → fetch → checkout, in place. Untracked leftovers
   * (lost+found) are simply ignored.
   */
  initFetchCheckout: async (url: string, dir: string, branch: string) => {
    await git(["init", "-q", "-b", branch, dir]);
    await git(["remote", "add", "origin", url], dir);
    await git(["fetch", "--quiet", "--all", "--prune"], dir);
    await git(["checkout", "-q", "-f", "-B", branch, `origin/${branch}`], dir);
  },
  fetch: (dir: string) => git(["fetch", "--quiet", "--all", "--prune"], dir),
  revParse: (dir: string, ref: string) => git(["rev-parse", ref], dir),
  headSha: (dir: string) => git(["rev-parse", "HEAD"], dir),
  // --force so a clean target checkout discards any per-project pins staged by a prior pass
  // (otherwise git preserves them as "local changes" and a held pin would never release).
  checkoutDetach: (dir: string, sha: string) => git(["checkout", "--quiet", "--force", "--detach", sha], dir),
  /** Restore one path in the working tree from a specific revision (per-project pinning). */
  checkoutPath: (dir: string, sha: string, path: string) => git(["checkout", sha, "--", path], dir),
  // ── write side (UI edits → commits, ARCHITECTURE §5) ──────────────────────
  checkoutBranch: (dir: string, branch: string) => git(["checkout", "-q", "-f", "-B", branch, `origin/${branch}`], dir),
  add: (dir: string) => git(["add", "-A"], dir),
  commit: (dir: string, message: string) => git(["-c", "user.email=mill@local", "-c", "user.name=Mill", "commit", "-q", "-m", message], dir),
  push: (dir: string, branch: string) => git(["push", "-q", "origin", branch], dir),
  /** name-status diff between two revisions, optionally scoped to a subpath. */
  diffNameStatus: (dir: string, from: string, to: string, subpath?: string) =>
    git(["diff", "--name-status", `${from}..${to}`, ...(subpath ? ["--", subpath] : [])], dir),
  worktreeAdd: (dir: string, path: string, sha: string) => git(["worktree", "add", "--quiet", "--detach", path, sha], dir),
  worktreeRemove: (dir: string, path: string) => git(["worktree", "remove", "--force", path], dir).catch(() => {}),
  short: (sha: string) => sha.slice(0, 7),
};
