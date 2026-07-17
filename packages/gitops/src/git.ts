// Thin wrapper over the git CLI (ARCHITECTURE §3.3: git access = shell out to `git`).
// The controller owns a working copy; the reconciler drives it toward a target revision.

async function git(args: string[], cwd?: string): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${redact((err || out).trim())}`);
  return out.trim();
}

/** Inject a token into an HTTPS remote (GitHub accepts x-access-token:<token>). */
export function authUrl(url: string, token?: string): string {
  if (token && url.startsWith("https://")) return url.replace("https://", `https://x-access-token:${token}@`);
  return url;
}
/** Keep tokens out of error messages/logs. */
const redact = (s: string) => s.replace(/x-access-token:[^@]+@/g, "x-access-token:***@");

export const Git = {
  clone: (url: string, dir: string, token?: string) => git(["clone", "--quiet", authUrl(url, token), dir]),
  fetch: (dir: string) => git(["fetch", "--quiet", "--all", "--prune"], dir),
  revParse: (dir: string, ref: string) => git(["rev-parse", ref], dir),
  headSha: (dir: string) => git(["rev-parse", "HEAD"], dir),
  checkoutDetach: (dir: string, sha: string) => git(["checkout", "--quiet", "--detach", sha], dir),
  // ── write side (UI edits → commits, ARCHITECTURE §5) ──────────────────────
  checkoutBranch: (dir: string, branch: string) => git(["checkout", "-q", "-B", branch, `origin/${branch}`], dir),
  add: (dir: string) => git(["add", "-A"], dir),
  commit: (dir: string, message: string) => git(["-c", "user.email=mill@local", "-c", "user.name=Mill", "commit", "-q", "-m", message], dir),
  push: (dir: string, branch: string) => git(["push", "-q", "origin", branch], dir),
  worktreeAdd: (dir: string, path: string, sha: string) => git(["worktree", "add", "--quiet", "--detach", path, sha], dir),
  worktreeRemove: (dir: string, path: string) => git(["worktree", "remove", "--force", path], dir).catch(() => {}),
  short: (sha: string) => sha.slice(0, 7),
};
