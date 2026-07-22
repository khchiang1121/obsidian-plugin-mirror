import { describe, it, expect } from 'vitest';
import { createObsidianFetch, type RequestUrlFn } from '../src/obsidianFetch';

function fakeRequestUrl(status: number, text: string, json: unknown): RequestUrlFn {
  return async () => ({ status, text, json, headers: {}, arrayBuffer: new ArrayBuffer(0) });
}

describe('createObsidianFetch', () => {
  it('marks 2xx responses as ok and exposes text/json', async () => {
    const fetchFn = createObsidianFetch(fakeRequestUrl(200, '{"a":1}', { a: 1 }));
    const response = await fetchFn('https://plugins.internal.example.test/index.json');
    expect(response.ok).toBe(true);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"a":1}');
    expect(await response.json()).toEqual({ a: 1 });
  });

  it('marks non-2xx responses as not ok, without throwing', async () => {
    const fetchFn = createObsidianFetch(fakeRequestUrl(404, 'not found', null));
    const response = await fetchFn('https://plugins.internal.example.test/missing.json');
    expect(response.ok).toBe(false);
    expect(response.status).toBe(404);
  });

  it('requests with throw:false so a 500 does not reject the promise', async () => {
    let capturedRequest: unknown;
    const requestUrlFn: RequestUrlFn = async (request) => {
      capturedRequest = request;
      return { status: 500, text: '', json: null, headers: {}, arrayBuffer: new ArrayBuffer(0) };
    };
    const fetchFn = createObsidianFetch(requestUrlFn);
    const response = await fetchFn('https://plugins.internal.example.test/index.json');
    expect(response.status).toBe(500);
    expect(capturedRequest).toEqual({ url: 'https://plugins.internal.example.test/index.json', throw: false });
  });
});
