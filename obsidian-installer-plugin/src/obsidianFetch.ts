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
    const response = await requestUrlFn({ url, throw: false });
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      text: async () => response.text,
      json: async () => response.json,
    };
  };
}
