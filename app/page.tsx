'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import type { RequestResult, AggregateStats, AuthConfig, AuthType, SuiteRequestResult } from '@/lib/types';

type LiveItem = { result: RequestResult; vuIdx: number; runIdx: number; seq: number; requestIdx: number; requestName: string };
type RequestEntry = { id: string; name: string; curl: string; method: string; body: string; contentType: string };
type Tab = 'timing' | 'stats' | 'response' | 'body' | 'request';
type ParsedRef = { url: string; method: string; headers: Record<string, string>; body: string | null };

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
function statusClass(sc: number) {
  if (sc >= 500) return 's-5xx';
  if (sc >= 400) return 's-4xx';
  if (sc >= 300) return 's-3xx';
  if (sc >= 200) return 's-2xx';
  return 's-err';
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
            <div className="t-val" style={{ color: c.color }}>{c.val}<span className="t-unit">ms</span></div>
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
              <div className="wf-val">{p.val}<span className="wf-unit"> ms</span></div>
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
      <div className="stats-row"><span className="s-label">Min</span><span className="s-val" style={{ color: '#3fb950' }}>{s.min} ms</span></div>
      <div className="stats-row"><span className="s-label">Max</span><span className="s-val" style={{ color: '#f85149' }}>{s.max} ms</span></div>
      <div className="stats-row"><span className="s-label">Avg</span><span className="s-val">{s.avg} ms</span></div>
      <div className="stats-row"><span className="s-label">P95</span><span className="s-val" style={{ color: '#ffa657' }}>{s.p95} ms</span></div>
    </div>
  );
  return (
    <>
      <div className="load-summary">
        <div className="load-metric"><div className="lm-val">{stats.runs}</div><div className="lm-label">Total</div></div>
        <div className="load-metric"><div className="lm-val" style={{ color: '#3fb950' }}>{stats.successful}</div><div className="lm-label">Success</div></div>
        <div className="load-metric"><div className="lm-val" style={{ color: stats.errorRate > 0 ? '#f85149' : '#3fb950' }}>{stats.errorRate}%</div><div className="lm-label">Error Rate</div></div>
        <div className="load-metric"><div className="lm-val" style={{ color: '#58a6ff' }}>{stats.throughput}</div><div className="lm-label">Req/s</div></div>
        <div className="load-metric"><div className="lm-val">{stats.vus}</div><div className="lm-label">VUs</div></div>
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
            {(['timing', ...(hasStats ? ['stats'] : []), 'response', 'body', 'request'] as Tab[]).map(tab => (
              <div key={tab} className={`tab ${activeTab === tab ? 'active' : ''}`} onClick={() => setActiveTab(tab)}>
                {tab === 'timing' && 'Timing'}
                {tab === 'stats' && <>Stats <span className="cnt">{sr.results.length}</span></>}
                {tab === 'response' && <>Headers <span className="cnt">{hdrCount}</span></>}
                {tab === 'body' && 'Body'}
                {tab === 'request' && 'Request'}
              </div>
            ))}
          </div>

          <div className="tab-panels">
            <div className={`tab-content ${activeTab === 'timing' ? 'active' : ''}`}><TimingView result={result} /></div>
            {hasStats && sr.stats && (
              <div className={`tab-content ${activeTab === 'stats' ? 'active' : ''}`}><StatsView stats={sr.stats} results={sr.results} /></div>
            )}
            <div className={`tab-content ${activeTab === 'response' ? 'active' : ''}`}><HeadersView headers={result.headers} /></div>
            <div className={`tab-content ${activeTab === 'body' ? 'active' : ''}`}><BodyView result={result} /></div>
            <div className={`tab-content ${activeTab === 'request' ? 'active' : ''}`}>{sr.parsed && <RequestView parsed={sr.parsed} />}</div>
          </div>
        </>
      ) : (
        <div style={{ padding: 20 }}>
          <div className="error-box">
            <strong>Request Failed</strong>{result?.error ?? 'No result received'}
          </div>
        </div>
      )}
    </>
  );
}

// ─── Main Page ───────────────────────────────────────────────────────────────

export default function Home() {
  const [requests, setRequests] = useState<RequestEntry[]>([{ id: '1', name: '', curl: '', method: 'GET', body: '', contentType: '' }]);
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

  const validRequests = requests.filter(r => r.curl.trim());
  const canRun = !loading && validRequests.length > 0;
  const totalLive = vus * runs * validRequests.length;

  const runTest = useCallback(async () => {
    if (!canRun) return;
    setLoading(true);
    setError(null);
    setSuiteResults([]);
    setLiveItems([]);
    setLiveStatus('');

    try {
      const res = await fetch('/api/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requests: validRequests.map(r => ({ id: r.id, name: r.name, curl: r.curl, method: r.method, body: r.body, contentType: r.contentType })),
          auth, runs, vus, thinkTime, timeout: timeoutSec,
        }),
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
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requests, auth, runs, vus, thinkTime, timeoutSec, canRun]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') runTest(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [runTest]);

  const addRequest = () => setRequests(p => [...p, { id: Date.now().toString(), name: '', curl: '', method: 'GET', body: '', contentType: '' }]);
  const removeRequest = (id: string) => setRequests(p => p.filter(r => r.id !== id));
  const updateRequest = (id: string, field: keyof RequestEntry, value: string) =>
    setRequests(p => p.map(r => {
      if (r.id !== id) return r;
      const updated = { ...r, [field]: field === 'curl' ? sanitizeCmdCurl(value) : value };
      if (field === 'method' && ['POST', 'PUT', 'PATCH'].includes(value) && !r.contentType) {
        updated.contentType = 'application/json';
      }
      return updated;
    }));

  const handleDownload = (format: 'csv' | 'json') => {
    if (format === 'csv') downloadCSV(suiteResults);
    else downloadJSON(suiteResults, { runs, vus, thinkTime, timeoutSec, auth: { type: auth.type } });
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
              <button className="ps-add-btn" onClick={addRequest}>+ Add</button>
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
                  {isUrlMode(req.curl) && (
                    <div className="url-mode-panel">
                      <div className="url-mode-row">
                        <select
                          className="method-select"
                          value={req.method}
                          onChange={e => updateRequest(req.id, 'method', e.target.value)}
                        >
                          <option>GET</option>
                          <option>POST</option>
                          <option>PUT</option>
                          <option>PATCH</option>
                          <option>DELETE</option>
                          <option>HEAD</option>
                          <option>OPTIONS</option>
                        </select>
                        <select
                          className="ct-select"
                          value={req.contentType}
                          onChange={e => updateRequest(req.id, 'contentType', e.target.value)}
                        >
                          <option value="">No Body</option>
                          <option value="application/json">JSON</option>
                          <option value="application/x-www-form-urlencoded">Form</option>
                          <option value="text/plain">Raw</option>
                        </select>
                      </div>
                      {req.contentType && (
                        <textarea
                          className="req-body-input"
                          placeholder={
                            req.contentType === 'application/json' ? '{"key": "value"}'
                            : req.contentType === 'application/x-www-form-urlencoded' ? 'key=value&key2=value2'
                            : 'Body...'
                          }
                          value={req.body}
                          onChange={e => updateRequest(req.id, 'body', e.target.value)}
                        />
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
                <label className="field-label">Runs <span className="field-hint">per VU</span></label>
                <input type="number" value={runs} min={1} onChange={e => setRuns(Math.max(1, parseInt(e.target.value) || 1))} />
              </div>
              <div className="field">
                <label className="field-label">VUs <span className="field-hint">concurrent</span></label>
                <input type="number" value={vus} min={1} onChange={e => setVus(Math.max(1, parseInt(e.target.value) || 1))} />
              </div>
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              <div className="field">
                <label className="field-label">Think Time <span className="field-hint">ms</span></label>
                <input type="number" value={thinkTime} min={0} step={100} onChange={e => setThinkTime(Math.max(0, parseInt(e.target.value) || 0))} />
              </div>
              <div className="field">
                <label className="field-label">Timeout</label>
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
                {validRequests.length} req{validRequests.length > 1 ? 's' : ''} × {vus} VU{vus > 1 ? 's' : ''} × {runs} run{runs > 1 ? 's' : ''} = <strong>{totalLive}</strong> total
                {thinkTime > 0 && ` · ${thinkTime}ms think`}
              </div>
            )}
          </div>

          <button className="btn-run" onClick={runTest} disabled={!canRun}>
            {loading && <div className="spinner" />}
            {loading
              ? (liveStatus ? `Testing ${liveStatus}` : 'Connecting…')
              : `▶ Run${validRequests.length > 1 ? ' All' : ''}`}
          </button>

          <div className="hint-box">
            Accepts <code>curl</code> commands or plain URLs · CMD <code>^</code> escaping auto-cleaned · Auth applied globally
          </div>
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
              <div className="error-box"><strong>Error</strong>{error}</div>
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
