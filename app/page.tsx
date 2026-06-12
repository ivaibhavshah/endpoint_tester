'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import type { RequestResult, AggregateStats, AuthConfig, AuthType, SuiteRequestResult } from '@/lib/types';

type LiveItem = { result: RequestResult; vuIdx: number; runIdx: number; seq: number; requestIdx: number; requestName: string };
type FormRow = { id: string; key: string; value: string };
type RequestEntry = { id: string; name: string; curl: string; method: string; body: string; contentType: string; formRows: FormRow[]; headerRows: FormRow[] };
type Tab = 'timing' | 'stats' | 'response' | 'body' | 'request' | 'runs';
type ParsedRef = { url: string; method: string; headers: Record<string, string>; body: string | null };
type HistoryEntry = { id: string; timestamp: number; requests: RequestEntry[]; config: { runs: number; vus: number; thinkTime: number; timeoutSec: number } };

// ─── Helpers ─────────────────────────────────────────────────────────────────

function escHtml(s: string | number | undefined | null) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function truncate(s: string, n: number) { return s.length > n ? s.slice(0, n) + '…' : s; }
function formatBytes(b: number) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(2)} MB`;
}
function highlightJson(str: string) {
  return escHtml(str)
    .replace(/(&quot;)((?:[^&]|&(?!quot;))*?)(&quot;)\s*:/g, '<span class="j-key">$1$2$3</span>:')
    .replace(/:(\s*)(&quot;)((?:[^&]|&(?!quot;))*?)(&quot;)/g, ':$1<span class="j-str">$2$3$4</span>')
    .replace(/:\s*(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g, ': <span class="j-num">$1</span>')
    .replace(/:\s*(true|false)/g, ': <span class="j-bool">$1</span>')
    .replace(/:\s*(null)/g, ': <span class="j-null">$1</span>');
}
const msToS = (ms: number) => `${(ms / 1000).toFixed(3)}s`;
function cleanError(msg: string | null | undefined): string {
  if (!msg) return 'An unknown error occurred — check the URL and try again';
  const t = msg.trim();
  if (!t || t.endsWith(':') || t === 'Request error') return 'Request failed — check the URL and network connectivity';
  return t;
}
function statusClass(sc: number) {
  if (sc >= 500) return 's-5xx';
  if (sc >= 400) return 's-4xx';
  if (sc >= 300) return 's-3xx';
  if (sc >= 200) return 's-2xx';
  return 's-err';
}

// ─── Local storage ────────────────────────────────────────────────────────────

const REQUESTS_KEY = 'curl-perf-requests';
const HISTORY_KEY  = 'curl-perf-history';
const MAX_HISTORY  = 30;

function loadStorage<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback;
  try { const v = localStorage.getItem(key); return v ? (JSON.parse(v) as T) : fallback; }
  catch { return fallback; }
}
function saveStorage(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}
function formatRelTime(ts: number): string {
  const d = Date.now() - ts;
  if (d < 60_000)     return 'just now';
  if (d < 3_600_000)  return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// ─── Download helpers ─────────────────────────────────────────────────────────

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
}

function downloadCSV(results: SuiteRequestResult[]) {
  const header = ['Request','Name','URL','Method','#','VU','Run','Status','StatusText','Total(ms)','TTFB(ms)','DNS(ms)','TCP(ms)','TLS(ms)','DL(ms)','BodySize(B)','Error'];
  const rows: (string | number)[][] = [header];
  results.forEach((sr, ri) => {
    sr.items.forEach((item, i) => {
      const r = item.result;
      rows.push([
        ri + 1, sr.name || `Request ${ri + 1}`,
        sr.parsed?.url ?? '', sr.parsed?.method ?? '',
        i + 1, item.vuIdx + 1, item.runIdx + 1,
        r.statusCode ?? '', r.statusMessage ?? '',
        r.timing?.total ?? '', r.timing?.ttfb ?? '',
        r.timing?.dnsPlusQueue ?? '', r.timing?.tcpConnect ?? '',
        r.timing?.tlsHandshake ?? '', r.timing?.download ?? '',
        r.bodySize ?? '', r.error ?? '',
      ]);
    });
  });
  const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
  triggerDownload(new Blob([csv], { type: 'text/csv' }), `perf-report-${Date.now()}.csv`);
}

function downloadJSON(results: SuiteRequestResult[], opts: object) {
  const report = {
    timestamp: new Date().toISOString(),
    options: opts,
    requests: results.map(sr => ({
      name: sr.name, url: sr.parsed?.url, method: sr.parsed?.method,
      stats: sr.stats,
      results: sr.items.map(item => ({
        vu: item.vuIdx + 1, run: item.runIdx + 1,
        status: item.result.statusCode, statusText: item.result.statusMessage,
        timing: item.result.timing, bodySize: item.result.bodySize,
        error: item.result.error,
      })),
    })),
  };
  triggerDownload(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }), `perf-report-${Date.now()}.json`);
}

function serializeFormRows(rows: FormRow[]) {
  return rows.filter(r => r.key.trim()).map(r => `${encodeURIComponent(r.key)}=${encodeURIComponent(r.value)}`).join('&');
}
const defaultFormRows = (): FormRow[] => [{ id: 'r1', key: '', value: '' }];

// ─── Excel import / export ────────────────────────────────────────────────────

const EXCEL_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const EXCEL_COLS = [{ wch: 20 }, { wch: 55 }, { wch: 10 }, { wch: 32 }, { wch: 45 }, { wch: 55 }];

function buildExcelRows(requests: RequestEntry[]) {
  return requests.map(r => ({
    Name: r.name,
    Input: r.curl,
    Method: isUrlMode(r.curl) ? r.method : '',
    ContentType: isUrlMode(r.curl) ? r.contentType : '',
    Body: isUrlMode(r.curl)
      ? (r.contentType === 'application/x-www-form-urlencoded' ? serializeFormRows(r.formRows) : r.body)
      : '',
    Headers: isUrlMode(r.curl)
      ? r.headerRows.filter(h => h.key.trim()).map(h => `${h.key}: ${h.value}`).join(' | ')
      : '',
  }));
}

async function exportRequestsToExcel(requests: RequestEntry[]) {
  const XLSX = (await import('xlsx')).default;
  const ws = XLSX.utils.json_to_sheet(buildExcelRows(requests));
  ws['!cols'] = EXCEL_COLS;
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Requests');
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  triggerDownload(new Blob([buf], { type: EXCEL_MIME }), `requests-${Date.now()}.xlsx`);
}

async function downloadSampleExcel() {
  try {
  const XLSX = (await import('xlsx')).default;
  const sample = [
    { Name: 'Get Users', Input: 'https://api.example.com/users', Method: 'GET', ContentType: '', Body: '', Headers: 'Authorization: Bearer my-token' },
    { Name: 'Create User', Input: 'https://api.example.com/users', Method: 'POST', ContentType: 'application/json', Body: '{"name":"John","email":"john@example.com"}', Headers: 'Authorization: Bearer my-token | X-Request-ID: abc123' },
    { Name: 'Submit Form', Input: 'https://api.example.com/submit', Method: 'POST', ContentType: 'application/x-www-form-urlencoded', Body: 'name=John&email=john%40example.com', Headers: '' },
    { Name: 'Raw Curl', Input: 'curl https://api.example.com/data -H "Authorization: Bearer token" -d \'{"key":"value"}\'', Method: '', ContentType: '', Body: '', Headers: '' },
  ];
  const ws = XLSX.utils.json_to_sheet(sample);
  ws['!cols'] = EXCEL_COLS;
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Requests');
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  triggerDownload(new Blob([buf], { type: EXCEL_MIME }), 'sample-requests.xlsx');
  } catch (err) { console.error('Sample download failed:', err); alert('Failed to generate sample file. Please try again.'); }
}

async function importRequestsFromExcel(file: File): Promise<RequestEntry[]> {
  const XLSX = (await import('xlsx')).default;
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const data = new Uint8Array(e.target!.result as ArrayBuffer);
        const wb = XLSX.read(data, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json<Record<string, string>>(ws);
        const entries: RequestEntry[] = rows
          .filter(row => (row.Input ?? '').trim())
          .map((row, i) => {
            const ct = (row.ContentType ?? '').trim();
            const rawBody = (row.Body ?? '').trim();
            const rawHeaders = (row.Headers ?? '').trim();

            const headerRows: FormRow[] = rawHeaders
              ? rawHeaders.split('|').map((h, j) => {
                  const ci = h.indexOf(':');
                  return { id: `ih-${i}-${j}`, key: ci >= 0 ? h.slice(0, ci).trim() : h.trim(), value: ci >= 0 ? h.slice(ci + 1).trim() : '' };
                })
              : defaultFormRows();

            const formRows: FormRow[] = ct === 'application/x-www-form-urlencoded' && rawBody
              ? rawBody.split('&').map((pair, j) => {
                  const ei = pair.indexOf('=');
                  return {
                    id: `if-${i}-${j}`,
                    key: decodeURIComponent(ei >= 0 ? pair.slice(0, ei) : pair),
                    value: decodeURIComponent(ei >= 0 ? pair.slice(ei + 1) : ''),
                  };
                })
              : defaultFormRows();

            return {
              id: `imp-${i}-${Date.now()}`,
              name: (row.Name ?? '').trim(),
              curl: (row.Input ?? '').trim(),
              method: (row.Method ?? 'GET').trim() || 'GET',
              contentType: ct,
              body: ct !== 'application/x-www-form-urlencoded' ? rawBody : '',
              headerRows,
              formRows,
            };
          });
        resolve(entries);
      } catch (err) { reject(err); }
    };
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

// ─── Sub-views ───────────────────────────────────────────────────────────────

function TimingView({ result }: { result: RequestResult }) {
  const t = result.timing;
  const isHttps = result.url?.startsWith('https');
  const total = t.total;
  const phases = [
    { label: 'DNS + Queue',    val: t.dnsPlusQueue, cls: 'bar-dns',  color: '#bc8cff' },
    { label: 'TCP Connect',    val: t.tcpConnect,   cls: 'bar-tcp',  color: '#58a6ff' },
    ...(isHttps ? [{ label: 'TLS Handshake', val: t.tlsHandshake, cls: 'bar-tls', color: '#39c5cf' }] : []),
    { label: 'Waiting (TTFB)', val: t.ttfb,         cls: 'bar-wait', color: '#ffa657' },
    { label: 'Download',       val: t.download,     cls: 'bar-dl',   color: '#3fb950' },
  ];
  const cards = [
    { label: 'Total Time',  val: t.total,        color: '#e6edf3' },
    { label: 'TTFB',        val: t.ttfb,         color: '#ffa657' },
    { label: 'Download',    val: t.download,     color: '#3fb950' },
    { label: 'DNS + Queue', val: t.dnsPlusQueue, color: '#bc8cff' },
    { label: 'TCP Connect', val: t.tcpConnect,   color: '#58a6ff' },
    ...(isHttps ? [{ label: 'TLS Handshake', val: t.tlsHandshake, color: '#39c5cf' }] : []),
  ];
  return (
    <>
      <div className="timing-grid">
        {cards.map(c => (
          <div className="timing-card" key={c.label}>
            <div className="t-label">{c.label}</div>
            <div className="t-val" style={{ color: c.color }}><span title={msToS(c.val)} className="ms-tip">{c.val}</span><span className="t-unit">ms</span></div>
          </div>
        ))}
      </div>
      <div>
        <div className="wf-section-title">Waterfall Breakdown</div>
        {phases.map(p => {
          const pct = total > 0 ? Math.max(0.5, (p.val / total) * 100) : 0;
          return (
            <div className="wf-row" key={p.label}>
              <div className="wf-label">{p.label}</div>
              <div className="wf-track"><div className={`wf-bar ${p.cls}`} style={{ width: `${pct}%` }} /></div>
              <div className="wf-val"><span title={msToS(p.val)} className="ms-tip">{p.val}</span><span className="wf-unit"> ms</span></div>
            </div>
          );
        })}
        <div className="legend">
          {phases.map(p => (
            <div className="legend-item" key={p.label}>
              <div className="legend-dot" style={{ background: p.color }} />
              {p.label}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function StatsView({ stats, results }: { stats: AggregateStats; results: RequestResult[] }) {
  const good = results.filter(r => !r.error);
  const maxTotal = good.length > 0 ? Math.max(...good.map(r => r.timing.total)) : 0;
  const StatCard = ({ title, s }: { title: string; s: { min: number; max: number; avg: number; p95: number } }) => (
    <div className="stats-card">
      <h3>{title}</h3>
      <div className="stats-row"><span className="s-label">Min</span><span className="s-val" style={{ color: '#3fb950' }}><span title={msToS(s.min)} className="ms-tip">{s.min}</span> ms</span></div>
      <div className="stats-row"><span className="s-label">Max</span><span className="s-val" style={{ color: '#f85149' }}><span title={msToS(s.max)} className="ms-tip">{s.max}</span> ms</span></div>
      <div className="stats-row"><span className="s-label">Avg</span><span className="s-val"><span title={msToS(s.avg)} className="ms-tip">{s.avg}</span> ms</span></div>
      <div className="stats-row"><span className="s-label">P95</span><span className="s-val" style={{ color: '#ffa657' }}><span title={msToS(s.p95)} className="ms-tip">{s.p95}</span> ms</span></div>
    </div>
  );
  return (
    <>
      <div className="load-summary">
        <div className="load-metric"><div className="lm-val">{stats.runs}</div><div className="lm-label">Total</div></div>
        <div className="load-metric"><div className="lm-val" style={{ color: '#3fb950' }}>{stats.successful}</div><div className="lm-label">Success</div></div>
        <div className="load-metric"><div className="lm-val" style={{ color: stats.errorRate > 0 ? '#f85149' : '#3fb950' }}>{stats.errorRate}%</div><div className="lm-label">Error Rate</div></div>
        <div className="load-metric"><div className="lm-val" style={{ color: '#58a6ff' }}>{stats.throughput}</div><div className="lm-label">Req/s</div></div>
        <div className="load-metric"><div className="lm-val">{stats.vus}</div><div className="lm-label">Users</div></div>
        <div className="load-metric"><div className="lm-val">{(stats.totalDuration / 1000).toFixed(2)}s</div><div className="lm-label">Duration</div></div>
      </div>
      {good.length > 0 && (
        <>
          <div className="stats-grid">
            <StatCard title="Total Time" s={stats.total} />
            <StatCard title="Time to First Byte" s={stats.ttfb} />
          </div>
          <div style={{ marginTop: 20 }}>
            <div className="section-subheader">Per-Request Breakdown</div>
            <div className="runs-list">
              {results.map((r, i) => {
                const pct = maxTotal > 0 && !r.error ? (r.timing.total / maxTotal) * 100 : 0;
                return (
                  <div className="run-item" key={i}>
                    <div className="run-num">#{i + 1}</div>
                    <div className="run-bar-track">
                      {r.error
                        ? <div className="run-bar" style={{ width: '100%', background: '#f85149', opacity: 0.4 }} />
                        : <div className="run-bar" style={{ width: `${pct}%` }} />}
                    </div>
                    <div className="run-val" style={{ color: r.error ? '#f85149' : (r.statusCode ?? 0) >= 400 ? '#f85149' : '#3fb950' }}>
                      {r.error ? 'ERR' : `${r.timing.total} ms`}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}
    </>
  );
}

function HeadersView({ headers }: { headers: Record<string, string | string[]> }) {
  const entries = Object.entries(headers);
  if (!entries.length) return <div style={{ color: 'var(--mu)' }}>No headers</div>;
  return (
    <table className="headers-table">
      <thead><tr><th>Header</th><th>Value</th></tr></thead>
      <tbody>
        {entries.map(([k, v]) => (
          <tr key={k}><td>{k}</td><td>{Array.isArray(v) ? v.join(', ') : v}</td></tr>
        ))}
      </tbody>
    </table>
  );
}

function BodyView({ result }: { result: RequestResult }) {
  const [copyLabel, setCopyLabel] = useState('Copy');
  const ct = (result.headers?.['content-type'] as string) || 'unknown';
  const onCopy = () => {
    const text = result.isJson ? result.bodyFormatted : result.body;
    navigator.clipboard.writeText(text).then(() => { setCopyLabel('Copied!'); setTimeout(() => setCopyLabel('Copy'), 1500); });
  };
  if (!result.body && result.bodySize === 0) return <div style={{ color: 'var(--mu)' }}>Empty body</div>;
  return (
    <>
      <div className="body-toolbar">
        <span className="size-badge">{formatBytes(result.bodySize)}</span>
        <span className="size-badge" style={{ marginLeft: 8 }}>{ct}</span>
        {result.isJson && <span className="size-badge" style={{ color: 'var(--gn)', marginLeft: 8 }}>✓ valid JSON</span>}
        <button className="copy-btn" onClick={onCopy}>{copyLabel}</button>
      </div>
      <pre className="body-pre" dangerouslySetInnerHTML={{ __html: result.isJson ? highlightJson(result.bodyFormatted) : escHtml(result.body) }} />
    </>
  );
}

function RequestView({ parsed }: { parsed: ParsedRef }) {
  const entries = Object.entries(parsed.headers || {});
  return (
    <>
      <div className="req-section">
        <h3>URL</h3>
        <div className="url-box"><span className="method-tag">{parsed.method}</span>{parsed.url}</div>
      </div>
      {entries.length > 0 && (
        <div className="req-section">
          <h3>Request Headers</h3>
          <table className="headers-table">
            <thead><tr><th>Header</th><th>Value</th></tr></thead>
            <tbody>{entries.map(([k, v]) => <tr key={k}><td>{k}</td><td>{v}</td></tr>)}</tbody>
          </table>
        </div>
      )}
      {parsed.body && (
        <div className="req-section">
          <h3>Request Body</h3>
          <pre className="body-pre">{parsed.body}</pre>
        </div>
      )}
    </>
  );
}

// ─── Live streaming view ─────────────────────────────────────────────────────

function LiveView({ items, total, sort, onToggleSort, showVu, showReq, currentRequest }: {
  items: LiveItem[];
  total: number;
  sort: 'asc' | 'desc';
  onToggleSort: () => void;
  showVu: boolean;
  showReq: boolean;
  currentRequest?: string;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const good = items.filter(i => !i.result.error);
  const errors = items.length - good.length;
  const maxTotal = good.length > 0 ? Math.max(...good.map(i => i.result.timing.total)) : 0;
  const pct = total > 0 ? Math.round((items.length / total) * 100) : 0;
  const okRate = items.length > 0 ? Math.round((good.length / items.length) * 100) : 100;
  const avgMs = good.length > 0 ? Math.round(good.reduce((s, i) => s + i.result.timing.total, 0) / good.length) : 0;
  const displayed = sort === 'desc' ? [...items].reverse() : items;

  useEffect(() => {
    if (sort === 'asc' && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [items.length, sort]);

  return (
    <div className="live-panel">
      <div className="live-header">
        <div className="live-header-left">
          <div className="live-title">
            <div className="live-dot" />
            Live
            {currentRequest && <span className="live-req-name">{currentRequest}</span>}
          </div>
          <div className="live-meta">
            <span className="live-counter">{items.length}<span className="live-counter-sep"> / </span>{total}</span>
            {errors > 0
              ? <span className="live-err">{errors} err · {okRate}% OK</span>
              : <span className="live-ok">{okRate}% OK</span>}
            {avgMs > 0 && <span className="live-avg">avg {avgMs}ms</span>}
          </div>
        </div>
        <button className="sort-btn" onClick={onToggleSort}>
          {sort === 'desc' ? '↓ Newest first' : '↑ Oldest first'}
        </button>
      </div>

      <div className="live-progress-wrap">
        <div className="live-track"><div className="live-bar" style={{ width: `${pct}%` }} /></div>
        <span className="live-pct">{pct}%</span>
      </div>

      <div className="live-list" ref={listRef}>
        {displayed.map((item) => {
          const r = item.result;
          const sc = r.statusCode ?? 0;
          const barPct = maxTotal > 0 && !r.error ? Math.max(2, (r.timing.total / maxTotal) * 100) : 100;
          const isHttps = !r.error && r.url?.startsWith('https');
          const barColor = r.error ? 'var(--rd)' : sc >= 500 ? 'var(--rd)' : sc >= 400 ? 'var(--yw)' : 'var(--bl)';
          const valColor = r.error ? 'var(--rd)' : sc >= 500 ? 'var(--rd)' : sc >= 400 ? 'var(--yw)' : 'var(--gn)';
          return (
            <div className="live-item" key={item.seq}>
              <div className="live-item-row">
                <span className="live-idx">#{item.seq}</span>
                {showVu && <span className="live-vu">VU{item.vuIdx + 1}·R{item.runIdx + 1}</span>}
                {showReq && <span className="live-req-badge">{item.requestName}</span>}
                <div className="live-item-track">
                  <div className="live-item-bar" style={{ width: `${barPct}%`, background: barColor }} />
                </div>
                <span className="live-item-val" style={{ color: valColor }}>
                  {r.error ? 'ERR' : `${r.timing.total}ms`}
                </span>
                <span className={`live-sc ${r.error ? 's-err' : statusClass(sc)}`}>
                  {r.error ? '—' : sc}
                </span>
              </div>
              {r.error ? (
                <div className="live-item-error">{r.error}</div>
              ) : (
                <div className="live-item-breakdown">
                  <span><span className="bd-label">DNS</span>{r.timing.dnsPlusQueue}ms</span>
                  <span className="bd-sep">·</span>
                  <span><span className="bd-label">TCP</span>{r.timing.tcpConnect}ms</span>
                  {isHttps && <><span className="bd-sep">·</span><span><span className="bd-label">TLS</span>{r.timing.tlsHandshake}ms</span></>}
                  <span className="bd-sep">·</span>
                  <span><span className="bd-label">TTFB</span>{r.timing.ttfb}ms</span>
                  <span className="bd-sep">·</span>
                  <span><span className="bd-label">DL</span>{r.timing.download}ms</span>
                  {r.statusMessage && <><span className="bd-sep">·</span><span className="bd-status">{r.statusMessage}</span></>}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Form data table ─────────────────────────────────────────────────────────

function FormTable({ rows, onAdd, onRemove, onUpdate, keyPlaceholder = 'key', valuePlaceholder = 'value', minRows = 1 }: {
  rows: FormRow[];
  onAdd: () => void;
  onRemove: (id: string) => void;
  onUpdate: (id: string, field: 'key' | 'value', val: string) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  minRows?: number;
}) {
  return (
    <div className="form-table">
      <div className="ft-head"><span>Key</span><span>Value</span></div>
      {rows.map(row => (
        <div className="ft-row" key={row.id}>
          <input className="ft-input" placeholder={keyPlaceholder} value={row.key} onChange={e => onUpdate(row.id, 'key', e.target.value)} />
          <input className="ft-input" placeholder={valuePlaceholder} value={row.value} onChange={e => onUpdate(row.id, 'value', e.target.value)} />
          <button className="ft-del" onClick={() => onRemove(row.id)} disabled={rows.length <= minRows}>×</button>
        </div>
      ))}
      <button className="ft-add" onClick={onAdd}>+ Add Row</button>
    </div>
  );
}

// ─── All-runs response list ───────────────────────────────────────────────────

function ResponsesView({ items }: { items: Array<{ result: RequestResult; vuIdx: number; runIdx: number }> }) {
  const [expanded, setExpanded] = useState<number | null>(null);
  const errors = items.filter(it => it.result.error).length;
  return (
    <div className="responses-list">
      {errors > 0 && (
        <div className="resp-summary-err">{errors} error{errors > 1 ? 's' : ''} out of {items.length} responses</div>
      )}
      <div className="resp-table-head">
        <span>VU</span><span>Run</span><span>Status</span><span>Total</span><span>TTFB</span><span>Size</span><span />
      </div>
      {items.map((item, i) => {
        const r = item.result;
        const isExp = expanded === i;
        const sc = r.statusCode ?? 0;
        return (
          <div key={i} className="resp-item">
            <div className={`resp-row ${isExp ? 'resp-row-open' : ''}`} onClick={() => setExpanded(isExp ? null : i)}>
              <span className="resp-vu-chip">VU{item.vuIdx + 1}</span>
              <span className="resp-run-chip">#{item.runIdx + 1}</span>
              {r.error
                ? <span className="status-badge s-err" style={{ fontSize: 11, padding: '1px 6px' }}>ERR</span>
                : <span className={`status-badge ${statusClass(sc)}`} style={{ fontSize: 11, padding: '1px 6px' }}>{sc}</span>}
              <span className="resp-num">{r.error ? '—' : <span title={msToS(r.timing.total)} className="ms-tip">{r.timing.total}ms</span>}</span>
              <span className="resp-num">{r.error ? '—' : <span title={msToS(r.timing.ttfb)} className="ms-tip">{r.timing.ttfb}ms</span>}</span>
              <span className="resp-num">{r.error ? '—' : formatBytes(r.bodySize)}</span>
              <span className="resp-chev">{isExp ? '▾' : '▸'}</span>
            </div>
            {isExp && (
              <div className="resp-expand">
                {r.error
                  ? <div className="error-box" style={{ margin: 0 }}><strong>Error</strong>{r.error}</div>
                  : <pre className="resp-body-pre">{r.bodyFormatted || r.body || '(empty)'}</pre>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── CMD curl sanitizer ───────────────────────────────────────────────────────

function sanitizeCmdCurl(input: string): string {
  if (!input.includes('^')) return input;
  return input
    .replace(/\^\\\^"/g, '"')
    .replace(/\^"/g, '"')
    .replace(/\s*\^\s*\r?\n\s*/g, ' \\\n  ')
    .replace(/\^&/g, '&')
    .replace(/\^/g, '');
}

function isUrlMode(curl: string) {
  const t = curl.trim();
  return /^https?:\/\//i.test(t) && !t.toLowerCase().startsWith('curl');
}

function looksLikeBareUrl(curl: string): boolean {
  const t = curl.trim();
  if (!t || /^https?:\/\//i.test(t) || t.toLowerCase().startsWith('curl')) return false;
  return /^localhost(:\d+)?(\/|$)/.test(t) ||
    /^[a-zA-Z0-9][\w.-]*\.[a-zA-Z]{2,}(:\d+)?(\/\S*)?$/.test(t);
}

// ─── Auth panel ───────────────────────────────────────────────────────────────

function AuthPanel({ auth, onChange }: { auth: AuthConfig; onChange: (a: AuthConfig) => void }) {
  return (
    <div className="auth-panel">
      <div className="field">
        <label className="field-label">Type</label>
        <select value={auth.type} onChange={e => onChange({ type: e.target.value as AuthType })}>
          <option value="none">No Auth</option>
          <option value="bearer">Bearer Token</option>
          <option value="basic">Basic Auth</option>
          <option value="apikey">API Key</option>
        </select>
      </div>
      {auth.type === 'bearer' && (
        <div className="field" style={{ marginTop: 10 }}>
          <label className="field-label">Token</label>
          <input type="text" className="full-input" placeholder="eyJhbGci…" value={auth.token ?? ''} onChange={e => onChange({ ...auth, token: e.target.value })} />
        </div>
      )}
      {auth.type === 'basic' && (
        <div className="row" style={{ marginTop: 10 }}>
          <div className="field">
            <label className="field-label">Username</label>
            <input type="text" placeholder="user" value={auth.username ?? ''} onChange={e => onChange({ ...auth, username: e.target.value })} />
          </div>
          <div className="field">
            <label className="field-label">Password</label>
            <input type="password" placeholder="••••" value={auth.password ?? ''} onChange={e => onChange({ ...auth, password: e.target.value })} />
          </div>
        </div>
      )}
      {auth.type === 'apikey' && (
        <div className="row" style={{ marginTop: 10 }}>
          <div className="field">
            <label className="field-label">Header</label>
            <input type="text" placeholder="X-API-Key" value={auth.keyName ?? ''} onChange={e => onChange({ ...auth, keyName: e.target.value })} />
          </div>
          <div className="field">
            <label className="field-label">Value</label>
            <input type="text" placeholder="sk-…" value={auth.keyValue ?? ''} onChange={e => onChange({ ...auth, keyValue: e.target.value })} />
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Suite results view ───────────────────────────────────────────────────────

function ExportMenu({ onDownload }: { onDownload: (f: 'csv' | 'json') => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handler = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);
  return (
    <div className="dl-wrap" ref={ref}>
      <button className="dl-btn" onClick={() => setOpen(o => !o)}>↓ Export</button>
      {open && (
        <div className="dl-menu">
          <button onClick={() => { onDownload('csv'); setOpen(false); }}>Download CSV</button>
          <button onClick={() => { onDownload('json'); setOpen(false); }}>Download JSON</button>
        </div>
      )}
    </div>
  );
}

function SuiteResultsView({ suiteResults, onDownload }: { suiteResults: SuiteRequestResult[]; onDownload: (f: 'csv' | 'json') => void }) {
  const [activeReqIdx, setActiveReqIdx] = useState(0);
  const [activeTab, setActiveTab] = useState<Tab>('timing');

  const clampedIdx = Math.min(activeReqIdx, suiteResults.length - 1);
  const sr = suiteResults[clampedIdx];
  if (!sr) return null;

  const result = sr.results[0];
  const hasStats = !!sr.stats && sr.results.length > 1;
  const sc = result?.statusCode ?? 0;
  const hdrCount = result ? Object.keys(result.headers || {}).length : 0;

  const selectReq = (i: number) => {
    setActiveReqIdx(i);
    const s = suiteResults[i];
    setActiveTab(s?.stats && s.results.length > 1 ? 'stats' : 'timing');
  };

  return (
    <>
      {suiteResults.length > 1 && (
        <div className="req-selector">
          {suiteResults.map((s, i) => {
            const first = s.results[0];
            const dot = first?.error ? 's-err' : first ? statusClass(first.statusCode ?? 0) : 's-err';
            return (
              <div key={i} className={`req-sel-tab ${clampedIdx === i ? 'active' : ''}`} onClick={() => selectReq(i)}>
                <span className={`req-sel-dot ${dot}`} />
                <span className="req-sel-label">{s.name || `#${i + 1}`}</span>
                {s.stats && <span className="req-sel-meta">{s.stats.total.avg}ms</span>}
              </div>
            );
          })}
          <div style={{ flex: 1 }} />
          <ExportMenu onDownload={onDownload} />
        </div>
      )}

      {result && !result.error ? (
        <>
          <div className="status-bar">
            <div className={`status-badge ${statusClass(sc)}`}>{sc} {result.statusMessage}</div>
            <div className="meta-chip"><strong>{result.method}</strong></div>
            <div className="meta-chip" title={result.url}>{truncate(result.url, 55)}</div>
            <div className="meta-chip">HTTP/{result.httpVersion}</div>
            <div className="meta-chip">{formatBytes(result.bodySize)}</div>
            <div className="total-time">{result.timing.total}<span>ms</span></div>
            {suiteResults.length === 1 && (
              <div style={{ marginLeft: 'auto' }}><ExportMenu onDownload={onDownload} /></div>
            )}
          </div>

          <div className="tabs">
            {(['timing', ...(hasStats ? ['stats'] : []), 'runs', 'response', 'body', 'request'] as Tab[]).map(tab => (
              <div key={tab} className={`tab ${activeTab === tab ? 'active' : ''}`} onClick={() => setActiveTab(tab)}>
                {tab === 'timing' && 'Timing'}
                {tab === 'stats' && <>Stats <span className="cnt">{sr.results.length}</span></>}
                {tab === 'runs' && <>Responses <span className="cnt">{sr.items.length}</span></>}
                {tab === 'response' && <>Headers <span className="cnt">{hdrCount}</span></>}
                {tab === 'body' && 'Response'}
                {tab === 'request' && 'Request'}
              </div>
            ))}
          </div>

          <div className="tab-panels">
            <div className={`tab-content ${activeTab === 'timing' ? 'active' : ''}`}><TimingView result={result} /></div>
            {hasStats && sr.stats && (
              <div className={`tab-content ${activeTab === 'stats' ? 'active' : ''}`}><StatsView stats={sr.stats} results={sr.results} /></div>
            )}
            <div className={`tab-content ${activeTab === 'runs' ? 'active' : ''}`}><ResponsesView items={sr.items} /></div>
            <div className={`tab-content ${activeTab === 'response' ? 'active' : ''}`}><HeadersView headers={result.headers} /></div>
            <div className={`tab-content ${activeTab === 'body' ? 'active' : ''}`}><BodyView result={result} /></div>
            <div className={`tab-content ${activeTab === 'request' ? 'active' : ''}`}>{sr.parsed && <RequestView parsed={sr.parsed} />}</div>
          </div>
        </>
      ) : (
        <div className="panel-error-scroll">
          <div className="error-box"><strong>Request Failed</strong>{cleanError(result?.error)}</div>
          {sr.items.length > 1 && (
            <div style={{ marginTop: 16 }}>
              <div className="section-subheader" style={{ marginBottom: 8 }}>All Responses</div>
              <ResponsesView items={sr.items} />
            </div>
          )}
        </div>
      )}
    </>
  );
}

// ─── History panel ───────────────────────────────────────────────────────────

function HistoryPanel({ history, onRestore, onClear }: {
  history: HistoryEntry[];
  onRestore: (e: HistoryEntry) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div className="panel-section">
      <div className="ps-header" style={{ cursor: 'pointer' }} onClick={() => setOpen(o => !o)}>
        <span className="ps-title">History</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {history.length > 0 && <span className="hist-count">{history.length}</span>}
          <span style={{ color: 'var(--mu)', fontSize: 12, lineHeight: 1 }}>{open ? '▾' : '▸'}</span>
        </div>
      </div>
      {open && (
        history.length === 0
          ? <div className="hist-empty">No history yet — run a request to record it</div>
          : <div className="hist-list">
              {history.map(entry => {
                const label = entry.requests
                  .map(r => r.name || truncate(r.curl.replace(/^curl\s+/i, '').trim(), 38))
                  .join(' · ');
                return (
                  <div className="hist-item" key={entry.id}>
                    <div className="hist-meta">
                      <span className="hist-time">{formatRelTime(entry.timestamp)}</span>
                      <span className="hist-badge">{entry.requests.length} req{entry.requests.length > 1 ? 's' : ''}</span>
                      {(entry.config.vus > 1 || entry.config.runs > 1) && (
                        <span className="hist-badge">{entry.config.vus}VU·{entry.config.runs}r</span>
                      )}
                      <button className="hist-load" onClick={() => onRestore(entry)}>Load</button>
                    </div>
                    <div className="hist-label">{label}</div>
                  </div>
                );
              })}
              <button className="hist-clear" onClick={onClear}>Clear history</button>
            </div>
      )}
    </div>
  );
}

// ─── Main Page ───────────────────────────────────────────────────────────────

export default function Home() {
  const [requests, setRequests] = useState<RequestEntry[]>([{ id: '1', name: '', curl: '', method: 'GET', body: '', contentType: '', formRows: defaultFormRows(), headerRows: defaultFormRows() }]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [auth, setAuth] = useState<AuthConfig>({ type: 'none' });
  const [runs, setRuns] = useState(1);
  const [vus, setVus] = useState(1);
  const [thinkTime, setThinkTime] = useState(0);
  const [timeoutSec, setTimeoutSec] = useState(30);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suiteResults, setSuiteResults] = useState<SuiteRequestResult[]>([]);
  const [liveItems, setLiveItems] = useState<LiveItem[]>([]);
  const [liveStatus, setLiveStatus] = useState('');
  const [liveSort, setLiveSort] = useState<'asc' | 'desc'>('desc');
  const [isPaused, setIsPaused] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const pauseCtrlRef = useRef<{ promise: Promise<void> | null; resolve: (() => void) | null }>({ promise: null, resolve: null });

  const validRequests = requests.filter(r => r.curl.trim());
  const canRun = !loading && validRequests.length > 0 && runs >= 1 && vus >= 1;
  const totalLive = vus * runs * validRequests.length;

  const runTest = useCallback(async () => {
    if (!canRun) return;
    setLoading(true);
    setError(null);
    setSuiteResults([]);
    setLiveItems([]);
    setLiveStatus('');
    setIsPaused(false);
    pauseCtrlRef.current = { promise: null, resolve: null };
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch('/api/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requests: validRequests.map(r => ({
            id: r.id, name: r.name, curl: r.curl, method: r.method, contentType: r.contentType,
            body: r.contentType === 'application/x-www-form-urlencoded' ? serializeFormRows(r.formRows) : r.body,
            customHeaders: isUrlMode(r.curl) ? r.headerRows.filter(h => h.key.trim()).map(h => `${h.key.trim()}: ${h.value}`) : undefined,
          })),
          auth, runs, vus, thinkTime, timeout: timeoutSec,
        }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        const json = await res.json().catch(() => ({ message: 'Request failed' }));
        setError(json.message);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const perReq = new Map<number, { results: RequestResult[]; items: Array<{ result: RequestResult; vuIdx: number; runIdx: number }> }>();
      const completedSuite: SuiteRequestResult[] = [];
      const collectedItems: LiveItem[] = [];
      const reqNames = new Map<number, string>();
      let seq = 0;

      while (true) {
        if (pauseCtrlRef.current.promise) await pauseCtrlRef.current.promise;
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.type === 'request_start') {
              perReq.set(msg.requestIdx, { results: [], items: [] });
              reqNames.set(msg.requestIdx, msg.name);
              setLiveStatus(`${msg.name} (${msg.requestIdx + 1}/${msg.totalRequests})`);
            } else if (msg.type === 'result') {
              const entry = perReq.get(msg.requestIdx);
              if (entry) {
                entry.results.push(msg.result);
                entry.items.push({ result: msg.result, vuIdx: msg.vuIdx ?? 0, runIdx: msg.runIdx ?? 0 });
              }
              seq++;
              collectedItems.push({
                result: msg.result,
                vuIdx: msg.vuIdx ?? 0, runIdx: msg.runIdx ?? 0, seq,
                requestIdx: msg.requestIdx,
                requestName: reqNames.get(msg.requestIdx) ?? `#${msg.requestIdx + 1}`,
              });
              setLiveItems([...collectedItems]);
            } else if (msg.type === 'request_done') {
              const entry = perReq.get(msg.requestIdx);
              completedSuite.push({
                idx: msg.requestIdx, name: msg.name,
                results: entry?.results ?? [],
                items: entry?.items ?? [],
                stats: msg.stats, parsed: msg.parsed,
              });
              setSuiteResults([...completedSuite]);
            } else if (msg.type === 'error' || msg.type === 'request_error') {
              setError(msg.message);
            }
          } catch { /* malformed line */ }
        }
      }
      if (completedSuite.length > 0) {
        const entry: HistoryEntry = {
          id: `h${Date.now()}`,
          timestamp: Date.now(),
          requests: validRequests,
          config: { runs, vus, thinkTime, timeoutSec },
        };
        setHistory(prev => {
          const next = [entry, ...prev].slice(0, MAX_HISTORY);
          saveStorage(HISTORY_KEY, next);
          return next;
        });
      }
    } catch (err) {
      if ((err as DOMException).name !== 'AbortError') setError((err as Error).message);
    } finally {
      setLoading(false);
      setIsPaused(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requests, auth, runs, vus, thinkTime, timeoutSec, canRun]);

  useEffect(() => {
    const saved = loadStorage<RequestEntry[]>(REQUESTS_KEY, []);
    if (saved.length > 0) {
      setRequests(saved.map(r => ({ ...r, formRows: r.formRows ?? defaultFormRows(), headerRows: r.headerRows ?? defaultFormRows() })));
    }
    setHistory(loadStorage<HistoryEntry[]>(HISTORY_KEY, []));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { saveStorage(REQUESTS_KEY, requests); }, [requests]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') runTest(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [runTest]);

  const addRequest = () => setRequests(p => [...p, { id: Date.now().toString(), name: '', curl: '', method: 'GET', body: '', contentType: '', formRows: defaultFormRows(), headerRows: defaultFormRows() }]);
  const removeRequest = (id: string) => setRequests(p => p.filter(r => r.id !== id));
  const updateRequest = (id: string, field: 'name' | 'curl' | 'method' | 'body' | 'contentType', value: string) =>
    setRequests(p => p.map(r => {
      if (r.id !== id) return r;
      const updated = { ...r, [field]: field === 'curl' ? sanitizeCmdCurl(value) : value };
      if (field === 'method' && ['POST', 'PUT', 'PATCH'].includes(value) && !r.contentType) {
        updated.contentType = 'application/json';
      }
      return updated;
    }));
  const addFormRow      = (reqId: string) => setRequests(p => p.map(r => r.id !== reqId ? r : { ...r, formRows: [...r.formRows, { id: Date.now().toString(), key: '', value: '' }] }));
  const removeFormRow   = (reqId: string, rowId: string) => setRequests(p => p.map(r => r.id !== reqId ? r : { ...r, formRows: r.formRows.filter(row => row.id !== rowId) }));
  const updateFormRow   = (reqId: string, rowId: string, field: 'key' | 'value', val: string) => setRequests(p => p.map(r => r.id !== reqId ? r : { ...r, formRows: r.formRows.map(row => row.id !== rowId ? row : { ...row, [field]: val }) }));
  const addHeaderRow    = (reqId: string) => setRequests(p => p.map(r => r.id !== reqId ? r : { ...r, headerRows: [...r.headerRows, { id: Date.now().toString(), key: '', value: '' }] }));
  const removeHeaderRow = (reqId: string, rowId: string) => setRequests(p => p.map(r => r.id !== reqId ? r : { ...r, headerRows: r.headerRows.filter(row => row.id !== rowId) }));
  const updateHeaderRow = (reqId: string, rowId: string, field: 'key' | 'value', val: string) => setRequests(p => p.map(r => r.id !== reqId ? r : { ...r, headerRows: r.headerRows.map(row => row.id !== rowId ? row : { ...row, [field]: val }) }));

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const imported = await importRequestsFromExcel(file);
      if (imported.length > 0) {
        setRequests(prev => {
          const isEmpty = prev.length === 1 && !prev[0].curl.trim() && !prev[0].name.trim();
          return isEmpty ? imported : [...prev, ...imported];
        });
      }
    } catch { setError('Failed to import — check the Excel format matches the sample.'); }
    e.target.value = '';
  };

  const handleDownload = (format: 'csv' | 'json') => {
    if (format === 'csv') downloadCSV(suiteResults);
    else downloadJSON(suiteResults, { runs, vus, thinkTime, timeoutSec, auth: { type: auth.type } });
  };

  const restoreHistory = (entry: HistoryEntry) => {
    setRequests(entry.requests);
    setRuns(entry.config.runs);
    setVus(entry.config.vus);
    setThinkTime(entry.config.thinkTime);
    setTimeoutSec(entry.config.timeoutSec);
  };
  const clearHistory = () => { setHistory([]); saveStorage(HISTORY_KEY, []); };
  const newSession = () => {
    setRequests([{ id: Date.now().toString(), name: '', curl: '', method: 'GET', body: '', contentType: '', formRows: defaultFormRows(), headerRows: defaultFormRows() }]);
    setSuiteResults([]);
    setError(null);
  };

  const handlePause = () => {
    setIsPaused(true);
    pauseCtrlRef.current.promise = new Promise<void>(resolve => { pauseCtrlRef.current.resolve = resolve; });
  };
  const handleResume = () => {
    setIsPaused(false);
    pauseCtrlRef.current.resolve?.();
    pauseCtrlRef.current.resolve = null;
    pauseCtrlRef.current.promise = null;
  };
  const handleStop = () => {
    pauseCtrlRef.current.resolve?.();
    pauseCtrlRef.current.resolve = null;
    pauseCtrlRef.current.promise = null;
    setIsPaused(false);
    abortRef.current?.abort();
  };

  return (
    <div className="app">
      <header>
        <div className="logo">Endpoint<span>Tester</span></div>
        <div className="badge">HTTP Performance &amp; Load Testing</div>
      </header>

      <main>
        {/* ── Left panel ── */}
        <div className="panel-left">

          {/* Requests */}
          <div className="panel-section">
            <div className="ps-header">
              <span className="ps-title">Requests</span>
              <div className="req-actions">
                <label className="icon-btn icon-btn-import" title="Import requests from Excel">
                  ↑ Import
                  <input type="file" accept=".xlsx,.xls" style={{ display: 'none' }} onChange={handleImport} />
                </label>
                <button className="icon-btn icon-btn-export" title="Export requests to Excel" onClick={() => exportRequestsToExcel(requests)}>↓ Export</button>
                <button className="icon-btn icon-btn-sample" title="Download sample Excel template" onClick={downloadSampleExcel}>Sample</button>
                <button className="icon-btn icon-btn-new" title="Clear all and start a new session" onClick={newSession}>New</button>
                <button className="ps-add-btn" onClick={addRequest}>+ Add</button>
              </div>
            </div>
            <div className="req-list">
              {requests.map((req, i) => (
                <div className="req-entry" key={req.id}>
                  <div className="req-entry-top">
                    <span className="req-num">{i + 1}</span>
                    <input
                      className="req-name-input"
                      placeholder="Name (optional)"
                      value={req.name}
                      onChange={e => updateRequest(req.id, 'name', e.target.value)}
                    />
                    {requests.length > 1 && (
                      <button className="req-del" onClick={() => removeRequest(req.id)}>×</button>
                    )}
                  </div>
                  <textarea
                    className="req-curl-input"
                    placeholder={`curl https://api.example.com/endpoint\nor just: https://api.example.com/endpoint`}
                    value={req.curl}
                    onChange={e => updateRequest(req.id, 'curl', e.target.value)}
                  />
                  {looksLikeBareUrl(req.curl) && (
                    <div className="proto-hint">
                      <span className="proto-hint-label">Add protocol?</span>
                      <button className="proto-btn" onClick={() => updateRequest(req.id, 'curl', `https://${req.curl.trim()}`)}>https://</button>
                      <button className="proto-btn proto-btn-http" onClick={() => updateRequest(req.id, 'curl', `http://${req.curl.trim()}`)}>http://</button>
                    </div>
                  )}
                  {isUrlMode(req.curl) && (
                    <div className="url-mode-panel">
                      <div className="url-mode-row">
                        <select className="method-select" value={req.method} onChange={e => updateRequest(req.id, 'method', e.target.value)}>
                          <option>GET</option>
                          <option>POST</option>
                          <option>PUT</option>
                          <option>PATCH</option>
                          <option>DELETE</option>
                          <option>HEAD</option>
                          <option>OPTIONS</option>
                        </select>
                        <select className="ct-select" value={req.contentType} onChange={e => updateRequest(req.id, 'contentType', e.target.value)}>
                          <option value="">No Body</option>
                          <option value="application/json">JSON</option>
                          <option value="application/x-www-form-urlencoded">Form</option>
                          <option value="text/plain">Raw</option>
                        </select>
                      </div>
                      <div className="url-subsection">
                        <span className="url-sub-label">Headers</span>
                        <FormTable
                          rows={req.headerRows}
                          keyPlaceholder="Header-Name"
                          valuePlaceholder="value"
                          minRows={0}
                          onAdd={() => addHeaderRow(req.id)}
                          onRemove={rowId => removeHeaderRow(req.id, rowId)}
                          onUpdate={(rowId, field, val) => updateHeaderRow(req.id, rowId, field, val)}
                        />
                      </div>
                      {req.contentType === 'application/x-www-form-urlencoded' && (
                        <div className="url-subsection">
                          <span className="url-sub-label">Form Data</span>
                          <FormTable
                            rows={req.formRows}
                            onAdd={() => addFormRow(req.id)}
                            onRemove={rowId => removeFormRow(req.id, rowId)}
                            onUpdate={(rowId, field, val) => updateFormRow(req.id, rowId, field, val)}
                          />
                        </div>
                      )}
                      {req.contentType && req.contentType !== 'application/x-www-form-urlencoded' && (
                        <div className="url-subsection">
                          <span className="url-sub-label">Body</span>
                          <textarea
                            className="req-body-input"
                            placeholder={req.contentType === 'application/json' ? '{"key": "value"}' : 'Body...'}
                            value={req.body}
                            onChange={e => updateRequest(req.id, 'body', e.target.value)}
                          />
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Authentication */}
          <div className="panel-section">
            <div className="ps-header"><span className="ps-title">Authentication</span></div>
            <AuthPanel auth={auth} onChange={setAuth} />
          </div>

          {/* Options */}
          <div className="panel-section">
            <div className="ps-header"><span className="ps-title">Options</span></div>
            <div className="row">
              <div className="field">
                <label className="field-label">Runs <span className="field-hint">per user</span></label>
                <input type="number" value={runs || ''} min={1}
                  onChange={e => setRuns(parseInt(e.target.value) || 0)}
                  onBlur={() => setRuns(r => Math.max(1, r || 1))} />
              </div>
              <div className="field">
                <label className="field-label">Users <span className="field-hint">concurrent</span></label>
                <input type="number" value={vus || ''} min={1}
                  onChange={e => setVus(parseInt(e.target.value) || 0)}
                  onBlur={() => setVus(v => Math.max(1, v || 1))} />
              </div>
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              <div className="field">
                <label className="field-label">Think Time <span className="field-hint">ms between</span></label>
                <input type="number" value={thinkTime} min={0} step={100} onChange={e => setThinkTime(Math.max(0, parseInt(e.target.value) || 0))} />
              </div>
              <div className="field">
                <label className="field-label">Timeout <span className="field-hint">per request</span></label>
                <select value={timeoutSec} onChange={e => setTimeoutSec(parseInt(e.target.value))}>
                  <option value="5">5s</option>
                  <option value="10">10s</option>
                  <option value="30">30s</option>
                  <option value="60">60s</option>
                  <option value="120">120s</option>
                  <option value="300">300s</option>
                </select>
              </div>
            </div>
            {(validRequests.length > 1 || vus > 1 || runs > 1) && (
              <div className="load-preview" style={{ marginTop: 10 }}>
                {validRequests.length} req{validRequests.length > 1 ? 's' : ''} × {vus} user{vus > 1 ? 's' : ''} × {runs} run{runs > 1 ? 's' : ''} = <strong>{totalLive}</strong> total
                {thinkTime > 0 && ` · ${thinkTime}ms think`}
              </div>
            )}
          </div>

          <button className="btn-run" onClick={runTest} disabled={!canRun}>
            {loading && !isPaused && <div className="spinner" />}
            {loading && isPaused && <span style={{ fontSize: 14, lineHeight: 1 }}>⏸</span>}
            {loading
              ? (isPaused ? 'Paused' : liveStatus ? `Testing ${liveStatus}` : 'Connecting…')
              : `▶ Run${validRequests.length > 1 ? ' All' : ''}`}
          </button>
          {loading && (
            <div className="run-controls">
              <button className={`ctrl-btn ${isPaused ? 'ctrl-resume' : 'ctrl-pause'}`} onClick={isPaused ? handleResume : handlePause}>
                {isPaused ? (
                  <><svg width="11" height="11" viewBox="0 0 11 11" fill="currentColor"><path d="M2 1.5L9.5 5.5L2 10V1.5Z"/></svg>Resume</>
                ) : (
                  <><svg width="11" height="11" viewBox="0 0 11 11" fill="currentColor"><rect x="1" y="1" width="3.5" height="9" rx="0.75"/><rect x="6.5" y="1" width="3.5" height="9" rx="0.75"/></svg>Pause</>
                )}
              </button>
              <button className="ctrl-btn ctrl-stop" onClick={handleStop}>
                <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"><rect x="0.5" y="0.5" width="9" height="9" rx="1.5"/></svg>
                Stop
              </button>
            </div>
          )}

          <div className="hint-box">
            Accepts <code>curl</code> commands or plain URLs · CMD <code>^</code> escaping auto-cleaned · Auth applied globally
          </div>

          <HistoryPanel history={history} onRestore={restoreHistory} onClear={clearHistory} />
        </div>

        {/* ── Right panel ── */}
        <div className="panel-right">
          {!loading && suiteResults.length === 0 && !error && (
            <div className="empty-state">
              <div className="empty-icon">⚡</div>
              <p>Add requests and hit Run</p>
              <p style={{ fontSize: 11 }}>Ctrl+Enter to run</p>
            </div>
          )}

          {loading && liveItems.length === 0 && (
            <div className="empty-state">
              <div className="spinner" style={{ width: 28, height: 28, borderWidth: 3 }} />
              <p style={{ color: 'var(--mu)' }}>Connecting…</p>
            </div>
          )}

          {loading && liveItems.length > 0 && (
            <LiveView
              items={liveItems}
              total={totalLive}
              sort={liveSort}
              onToggleSort={() => setLiveSort(s => s === 'asc' ? 'desc' : 'asc')}
              showVu={vus > 1 || runs > 1}
              showReq={validRequests.length > 1}
              currentRequest={liveStatus}
            />
          )}

          {!loading && error && suiteResults.length === 0 && (
            <div style={{ padding: 20 }}>
              <div className="error-box"><strong>Error</strong>{cleanError(error)}</div>
            </div>
          )}

          {!loading && suiteResults.length > 0 && (
            <SuiteResultsView suiteResults={suiteResults} onDownload={handleDownload} />
          )}
        </div>
      </main>
      <footer className="app-footer">
        Developed by{' '}
        <a href="https://ivaibhavshah.vercel.app" target="_blank" rel="noopener noreferrer">
          Vaibhav Shah
        </a>
      </footer>
    </div>
  );
}
