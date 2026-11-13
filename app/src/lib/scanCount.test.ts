import { describe, expect, it, vi } from 'vitest';
import { counterConfig, dayKey, handleScanCount } from '../../api/scan-count.ts';
import vercel from '../../vercel.json' with { type: 'json' };
import { countScan, SCAN_COUNT_PATH } from './scanCount';

describe('countScan (the site side)', () => {
  it('sends one empty POST with no cookie and no Referer, so the scanned address never leaves', () => {
    const send = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
    countScan(send as unknown as typeof fetch, true);
    expect(send).toHaveBeenCalledTimes(1);
    const [path, init] = send.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe('/api/scan-count');
    expect(init).toEqual({ method: 'POST', keepalive: true, credentials: 'omit', referrerPolicy: 'no-referrer' });
    expect(init.body).toBeUndefined();
  });

  it('sends nothing outside the production build', () => {
    const send = vi.fn();
    countScan(send as unknown as typeof fetch, false);
    expect(send).not.toHaveBeenCalled();
  });

  it('never throws, whether the request fails later or at once', async () => {
    const rejecting = vi.fn(() => Promise.reject(new Error('blocked')));
    expect(() => countScan(rejecting as unknown as typeof fetch, true)).not.toThrow();
    const throwing = vi.fn(() => {
      throw new TypeError('refused');
    });
    expect(() => countScan(throwing as unknown as typeof fetch, true)).not.toThrow();
    await Promise.resolve();
  });

  it('is not rewritten to index.html by vercel.json', () => {
    const [rewrite] = vercel.rewrites;
    const source = new RegExp(`^${rewrite.source}$`);
    expect(source.test(SCAN_COUNT_PATH)).toBe(false);
    expect(source.test('/bounty')).toBe(true);
  });
});

describe('api/scan-count (the function)', () => {
  const now = new Date('2026-11-13T23:59:59Z');

  it('keys the count by the UTC day', () => {
    expect(dayKey(now)).toBe('scans:2026-11-13');
    expect(dayKey(new Date('2026-11-14T00:00:00Z'))).toBe('scans:2026-11-14');
  });

  it('is off until both the URL and the token are set', () => {
    expect(counterConfig({})).toBeNull();
    expect(counterConfig({ KV_REST_API_URL: 'https://db.example' })).toBeNull();
    expect(counterConfig({ UPSTASH_REDIS_REST_TOKEN: 't' })).toBeNull();
    expect(counterConfig({ KV_REST_API_URL: 'https://db.example/', KV_REST_API_TOKEN: 't' })).toEqual({
      url: 'https://db.example',
      token: 't',
    });
    expect(counterConfig({ UPSTASH_REDIS_REST_URL: 'https://u.example', UPSTASH_REDIS_REST_TOKEN: 'u' })).toEqual({
      url: 'https://u.example',
      token: 'u',
    });
  });

  it('answers 204 and contacts nothing while counting is off', async () => {
    const send = vi.fn();
    const response = await handleScanCount({}, send as unknown as typeof fetch, now);
    expect(response.status).toBe(204);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(send).not.toHaveBeenCalled();
  });

  it("sends INCR of today's key to the REST root with the token", async () => {
    const send = vi.fn(() => Promise.resolve(new Response('{"result":1}')));
    const response = await handleScanCount(
      { KV_REST_API_URL: 'https://db.example/', KV_REST_API_TOKEN: 'secret' },
      send as unknown as typeof fetch,
      now,
    );
    expect(response.status).toBe(204);
    expect(send).toHaveBeenCalledTimes(1);
    const [url, init] = send.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://db.example');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ Authorization: 'Bearer secret', 'Content-Type': 'application/json' });
    expect(JSON.parse(String(init.body))).toEqual(['INCR', 'scans:2026-11-13']);
  });

  it('still answers 204, and logs the status but never the token, when the database refuses the count', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const send = vi.fn(() => Promise.resolve(new Response('{"error":"WRONGPASS"}', { status: 401 })));
      const response = await handleScanCount(
        { KV_REST_API_URL: 'https://db.example', KV_REST_API_TOKEN: 'secret-token' },
        send as unknown as typeof fetch,
        now,
      );
      expect(response.status).toBe(204);
      expect(error).toHaveBeenCalledWith('scan count refused: HTTP 401');
      expect(JSON.stringify(error.mock.calls)).not.toContain('secret-token');
    } finally {
      error.mockRestore();
    }
  });

  it('still answers 204 when the database cannot be reached', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const send = vi.fn(() => Promise.reject(new Error('down at https://u.example?token=u')));
      const response = await handleScanCount(
        { UPSTASH_REDIS_REST_URL: 'https://u.example', UPSTASH_REDIS_REST_TOKEN: 'u' },
        send as unknown as typeof fetch,
        now,
      );
      expect(response.status).toBe(204);
      expect(error).toHaveBeenCalledWith('scan count failed: Error');
    } finally {
      error.mockRestore();
    }
  });
});
