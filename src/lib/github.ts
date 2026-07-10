import { Octokit } from "@octokit/rest";
import type { FileMap } from "@/lib/build/template";
import { audit } from "@/lib/audit";

/**
 * GitHub tool layer (Stage 2).
 * Auth: fine-grained personal access token in GITHUB_TOKEN, owner in
 * GITHUB_OWNER. Swappable for a GitHub App later — callers only use
 * these functions, never Octokit directly.
 */

function getOctokit(): Octokit {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("GITHUB_TOKEN is not set (see .env.example).");
  }
  return new Octokit({ auth: token });
}

function getOwner(): string {
  const owner = process.env.GITHUB_OWNER;
  if (!owner) {
    throw new Error("GITHUB_OWNER is not set (see .env.example).");
  }
  return owner;
}

export type RepoInfo = {
  owner: string;
  repo: string;
  htmlUrl: string;
  defaultBranch: string;
};

/** Create a private repo for a generated app (idempotent). */
export async function createRepoIfMissing(opts: {
  name: string;
  description: string;
  userId?: string;
  appId?: string;
}): Promise<RepoInfo> {
  const octokit = getOctokit();
  const owner = getOwner();

  try {
    const { data } = await octokit.repos.get({ owner, repo: opts.name });
    return {
      owner,
      repo: data.name,
      htmlUrl: data.html_url,
      defaultBranch: data.default_branch,
    };
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status !== 404) throw err;
  }

  const { data } = await octokit.repos.createForAuthenticatedUser({
    name: opts.name,
    description: opts.description.slice(0, 300),
    private: true,
    auto_init: true, // creates main branch so we can commit against it
  });

  await audit({
    userId: opts.userId,
    appId: opts.appId,
    action: "github.repoCreated",
    payload: { repo: data.full_name, url: data.html_url },
  });

  return {
    owner,
    repo: data.name,
    htmlUrl: data.html_url,
    defaultBranch: data.default_branch ?? "main",
  };
}

/** Commit a set of files as a single commit on a branch (git data API). */
export async function commitFiles(opts: {
  repo: string;
  branch: string;
  files: FileMap;
  message: string;
  userId?: string;
  appId?: string;
}): Promise<{ commitSha: string }> {
  const octokit = getOctokit();
  const owner = getOwner();
  const { repo, branch, files, message } = opts;

  const ref = await octokit.git.getRef({ owner, repo, ref: `heads/${branch}` });
  const parentSha = ref.data.object.sha;
  const parentCommit = await octokit.git.getCommit({
    owner,
    repo,
    commit_sha: parentSha,
  });

  const tree = await octokit.git.createTree({
    owner,
    repo,
    base_tree: parentCommit.data.tree.sha,
    tree: Object.entries(files).map(([path, content]) => ({
      path,
      mode: "100644" as const,
      type: "blob" as const,
      content,
    })),
  });

  const commit = await octokit.git.createCommit({
    owner,
    repo,
    message,
    tree: tree.data.sha,
    parents: [parentSha],
  });

  await octokit.git.updateRef({
    owner,
    repo,
    ref: `heads/${branch}`,
    sha: commit.data.sha,
  });

  await audit({
    userId: opts.userId,
    appId: opts.appId,
    action: "github.commit",
    payload: {
      repo: `${owner}/${repo}`,
      branch,
      commitSha: commit.data.sha,
      fileCount: Object.keys(files).length,
      message,
    },
  });

  return { commitSha: commit.data.sha };
}
