import { Octokit } from '@octokit/rest';
import pLimit from 'p-limit';

export interface FetchedReleaseAsset {
  name: string;
  downloadUrl: string;
}

export interface FetchedRelease {
  tagName: string;
  prerelease: boolean;
  publishedAt: string;
  assets: FetchedReleaseAsset[];
}

export function createGithubClient(token?: string): Octokit {
  return new Octokit(token ? { auth: token } : {});
}

export async function fetchReleasesForRepo(client: Octokit, repo: string): Promise<FetchedRelease[]> {
  const [owner, name] = repo.split('/');
  const releases = await client.paginate(client.rest.repos.listReleases, {
    owner,
    repo: name,
    per_page: 100,
  });
  return releases.map((r) => ({
    tagName: r.tag_name,
    prerelease: r.prerelease,
    publishedAt: r.published_at ?? r.created_at,
    assets: r.assets.map((a) => ({ name: a.name, downloadUrl: a.browser_download_url })),
  }));
}

export type RepoFetchResult =
  | { status: 'ok'; releases: FetchedRelease[] }
  | { status: 'error'; error: Error };

export async function fetchReleasesForRepos(
  client: Octokit,
  repos: string[],
  concurrency = 5
): Promise<Map<string, RepoFetchResult>> {
  const limit = pLimit(concurrency);
  const results = new Map<string, RepoFetchResult>();
  await Promise.all(
    repos.map((repo) =>
      limit(async () => {
        try {
          const releases = await fetchReleasesForRepo(client, repo);
          results.set(repo, { status: 'ok', releases });
        } catch (error) {
          results.set(repo, { status: 'error', error: error as Error });
        }
      })
    )
  );
  return results;
}
