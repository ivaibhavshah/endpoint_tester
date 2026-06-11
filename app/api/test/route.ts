import { NextRequest, NextResponse } from 'next/server';
import { parseCurlCommand } from '@/lib/curlParser';
import { makeRequest, buildStats } from '@/lib/httpTester';
import type { RequestResult, AuthConfig } from '@/lib/types';

export const runtime = 'nodejs';

function normalizeInput(input: string, method?: string, body?: string, contentType?: string, customHeaders?: string[]): string {
  const t = input.trim();
  if (/^https?:\/\//i.test(t) && !t.includes(' ')) {
    const m = (method || 'GET').toUpperCase();
    let cmd = `curl "${t}"`;
    if (m !== 'GET') cmd += ` -X ${m}`;
    if (customHeaders?.length) {
      for (const h of customHeaders) cmd += ` -H "${h.replace(/"/g, '\\"')}"`;
    }
    if (contentType) cmd += ` -H "Content-Type: ${contentType}"`;
    if (body?.trim()) {
      const escaped = body.replace(/\\/g, '\\\\').replace(/'/g, "'\\''");
      cmd += ` -d '${escaped}'`;
    }
    return cmd;
  }
  return t;
}

function applyAuth(headers: Record<string, string>, auth: AuthConfig): void {
  const hasAuth = !!(headers['Authorization'] || headers['authorization']);
  if (hasAuth) return;
  if (auth.type === 'bearer' && auth.token?.trim()) {
    headers['Authorization'] = `Bearer ${auth.token.trim()}`;
  } else if (auth.type === 'basic' && auth.username) {
    headers['Authorization'] = 'Basic ' + Buffer.from(`${auth.username}:${auth.password ?? ''}`).toString('base64');
  } else if (auth.type === 'apikey' && auth.keyName?.trim() && auth.keyValue?.trim()) {
    headers[auth.keyName.trim()] = auth.keyValue.trim();
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    let requestList: Array<{ id: string; name: string; curl: string; method?: string; body?: string; contentType?: string; customHeaders?: string[] }>;
    if (Array.isArray(body.requests) && body.requests.length > 0) {
      requestList = body.requests;
    } else if (body.curlCommand) {
      requestList = [{ id: '1', name: '', curl: body.curlCommand }];
    } else {
      return NextResponse.json({ success: false, message: 'No requests provided' }, { status: 400 });
    }

    const { runs = 1, vus = 1, thinkTime = 0, timeout = 30, auth = { type: 'none' } } = body;
    const numRuns   = Math.max(1, parseInt(String(runs))      || 1);
    const numVus    = Math.max(1, parseInt(String(vus))       || 1);
    const thinkMs   = Math.max(0, parseInt(String(thinkTime)) || 0);
    const timeoutMs = Math.min(Math.max(5, parseInt(String(timeout)) || 30), 600) * 1000;

    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        const enqueue = (msg: object) =>
          controller.enqueue(encoder.encode(JSON.stringify(msg) + '\n'));

        try {
          for (let reqIdx = 0; reqIdx < requestList.length; reqIdx++) {
            const entry = requestList[reqIdx];
            const normalized = normalizeInput(entry.curl, entry.method, entry.body, entry.contentType, entry.customHeaders);

            if (!normalized) {
              enqueue({ type: 'request_error', requestIdx: reqIdx, message: 'Empty request' });
              continue;
            }
            if (!/^curl(\s|$)/i.test(normalized)) {
              enqueue({ type: 'request_error', requestIdx: reqIdx, message: `Not a valid curl command or URL` });
              continue;
            }

            const parsed = parseCurlCommand(normalized);
            if (!parsed.url) {
              enqueue({ type: 'request_error', requestIdx: reqIdx, message: 'No URL found in command' });
              continue;
            }

            applyAuth(parsed.headers, auth);

            enqueue({
              type: 'request_start',
              requestIdx: reqIdx,
              name: entry.name || `Request ${reqIdx + 1}`,
              total: numVus * numRuns,
              totalRequests: requestList.length,
            });

            const allResults: RequestResult[] = [];
            const allItems: Array<{ result: RequestResult; vuIdx: number; runIdx: number }> = [];
            const testStart = Date.now();

            await Promise.all(
              Array.from({ length: numVus }, async (_, vuIdx) => {
                for (let i = 0; i < numRuns; i++) {
                  let result: RequestResult;
                  try {
                    result = await makeRequest(parsed, 0, timeoutMs);
                  } catch (err) {
                    result = { error: (err as Error).message } as RequestResult;
                  }
                  allResults.push(result);
                  allItems.push({ result, vuIdx, runIdx: i });
                  enqueue({ type: 'result', requestIdx: reqIdx, vuIdx, runIdx: i, result });

                  if (i < numRuns - 1 && thinkMs > 0)
                    await new Promise(r => setTimeout(r, thinkMs));
                }
              })
            );

            const testDuration = Date.now() - testStart;
            const good = allResults.filter(r => !r.error);
            const stats = allResults.length > 1
              ? buildStats(good, allResults, testDuration, numVus)
              : null;

            enqueue({
              type: 'request_done',
              requestIdx: reqIdx,
              name: entry.name || `Request ${reqIdx + 1}`,
              stats,
              items: allItems,
              parsed: { url: parsed.url, method: parsed.method, headers: parsed.headers, body: parsed.body },
            });
          }

          enqueue({ type: 'suite_done' });
        } catch (err) {
          enqueue({ type: 'error', message: (err as Error).message || 'Internal error' });
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'application/x-ndjson',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ success: false, message: (err as Error).message || 'Internal error' }, { status: 500 });
  }
}
