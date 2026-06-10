import http from 'http';
import https from 'https';
import { performance } from 'perf_hooks';
import { URL } from 'url';
import type { ParsedCurl, RequestResult, AggregateStats } from './types';

function round(n: number) { return Math.round(n * 100) / 100; }

function pct(arr: number[], p: number) {
  const s = [...arr].sort((a, b) => a - b);
  return round(s[Math.max(0, Math.ceil((p / 100) * s.length) - 1)]);
}

export function makeRequest(parsed: ParsedCurl, redirectCount = 0, timeoutMs = 30_000): Promise<RequestResult> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try { url = new URL(parsed.url!); } catch {
      return reject(new Error(`Invalid URL: ${parsed.url}`));
    }

    const isHttps = url.protocol === 'https:';
    const transport = isHttps ? https : http;
    const t = { t0: 0, t1: 0, t2: 0, t3: 0, t4: 0, t5: 0 };

    const reqHeaders: Record<string, string | number> = { ...parsed.headers };
    let bodyBuf: Buffer | null = null;
    if (parsed.body) {
      bodyBuf = Buffer.from(parsed.body, 'utf-8');
      reqHeaders['Content-Length'] = bodyBuf.length;
    }

    const options: https.RequestOptions = {
      hostname: url.hostname,
      port: url.port ? parseInt(url.port) : (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: parsed.method,
      headers: reqHeaders,
      rejectUnauthorized: !parsed.insecure,
    };

    t.t0 = performance.now();

    const req = transport.request(options, (res) => {
      if (
        parsed.followRedirects &&
        res.statusCode !== undefined &&
        [301, 302, 303, 307, 308].includes(res.statusCode) &&
        res.headers.location &&
        redirectCount < 5
      ) {
        res.resume();
        const redirectUrl = new URL(res.headers.location, parsed.url!).href;
        return makeRequest(
          { ...parsed, url: redirectUrl, method: res.statusCode === 303 ? 'GET' : parsed.method, body: res.statusCode === 303 ? null : parsed.body },
          redirectCount + 1,
          timeoutMs
        ).then(resolve).catch(reject);
      }

      let firstByte = false;
      const chunks: Buffer[] = [];

      res.on('data', (chunk: Buffer) => {
        if (!firstByte) { t.t4 = performance.now(); firstByte = true; }
        chunks.push(chunk);
      });

      res.on('end', () => {
        t.t5 = performance.now();
        if (!firstByte) t.t4 = t.t5;

        const bodyRaw = Buffer.concat(chunks);
        const bodyStr = bodyRaw.toString('utf-8');

        let bodyFormatted = bodyStr;
        let isJson = false;
        const ct = (res.headers['content-type'] as string) || '';
        if (ct.includes('json')) {
          try { bodyFormatted = JSON.stringify(JSON.parse(bodyStr), null, 2); isJson = true; } catch { /* not json */ }
        }

        const afterConnect = isHttps ? t.t3 : t.t2;

        resolve({
          statusCode:    res.statusCode ?? 0,
          statusMessage: res.statusMessage ?? '',
          httpVersion:   res.httpVersion,
          headers:       res.headers as Record<string, string | string[]>,
          body:          bodyStr.slice(0, 200_000),
          bodyFormatted: bodyFormatted.slice(0, 200_000),
          bodySize:      bodyRaw.length,
          isJson,
          url:    parsed.url!,
          method: parsed.method,
          timing: {
            dnsPlusQueue: round(t.t1 - t.t0),
            tcpConnect:   round(t.t2 - t.t1),
            tlsHandshake: isHttps ? round(t.t3 - t.t2) : 0,
            ttfb:         round(t.t4 - afterConnect),
            download:     round(t.t5 - t.t4),
            total:        round(t.t5 - t.t0),
          },
        });
      });

      res.on('error', (err: Error) => reject(new Error(`Response error: ${err.message}`)));
    });

    req.on('socket', (socket) => {
      t.t1 = performance.now();
      socket.on('connect', () => {
        t.t2 = performance.now();
        if (!isHttps) t.t3 = t.t2;
      });
      socket.on('secureConnect', () => {
        t.t3 = performance.now();
      });
    });

    req.on('error', (err: Error) => reject(new Error(`Request error: ${err.message}`)));
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Timed out after ${timeoutMs / 1000}s`)));

    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

export function buildStats(good: RequestResult[], all: RequestResult[], testDurationMs: number, vus: number): AggregateStats {
  const totals = good.map(r => r.timing.total);
  const ttfbs  = good.map(r => r.timing.ttfb);
  const throughput = testDurationMs > 0 ? round(all.length / (testDurationMs / 1000)) : 0;
  const errorRate  = all.length > 0 ? round(((all.length - good.length) / all.length) * 100) : 0;
  return {
    runs: all.length,
    successful: good.length,
    vus,
    totalDuration: Math.round(testDurationMs),
    throughput,
    errorRate,
    total: good.length > 0
      ? { min: Math.min(...totals), max: Math.max(...totals), avg: round(totals.reduce((a, b) => a + b, 0) / totals.length), p95: pct(totals, 95) }
      : { min: 0, max: 0, avg: 0, p95: 0 },
    ttfb: good.length > 0
      ? { min: Math.min(...ttfbs), max: Math.max(...ttfbs), avg: round(ttfbs.reduce((a, b) => a + b, 0) / ttfbs.length), p95: pct(ttfbs, 95) }
      : { min: 0, max: 0, avg: 0, p95: 0 },
  };
}
