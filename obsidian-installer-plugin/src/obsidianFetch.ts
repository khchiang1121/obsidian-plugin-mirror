import type { RequestUrlParam, RequestUrlResponse } from 'obsidian';

export type RequestUrlFn = (request: RequestUrlParam) => Promise<RequestUrlResponse>;

export interface FetchLikeResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

export type FetchLike = (url: string) => Promise<FetchLikeResponse>;

/**
 * Obsidian's renderer enforces CORS on the global `fetch`, which blocks plain
 * requests to an unmodified nginx mirror (no Access-Control-Allow-Origin).
 * `requestUrl` goes through Obsidian's own HTTP client instead of the page's
 * fetch, so it isn't subject to CORS at all.
 */
export function createObsidianFetch(requestUrlFn: RequestUrlFn): FetchLike {
  return async (url: string) => {
    const response = await requestUrlFn({
      url,
      throw: false,
      // Belt-and-suspenders alongside the cache-busting query param in
      // registry.ts: Obsidian's requestUrl runs on Electron's Chromium
      // network stack, which can otherwise cache and replay a stale
      // response for the mirror's index.json/versions.json — files that are
      // rewritten in place on every rebuild, with no way for a cached hit to
      // signal it's stale.
      headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate', Pragma: 'no-cache' },
    });
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      text: async () => response.text,
      json: async () => response.json,
    };
  };
}
