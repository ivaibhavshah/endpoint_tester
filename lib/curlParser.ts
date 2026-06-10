import type { ParsedCurl } from './types';

function tokenize(cmd: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let i = 0;
  while (i < cmd.length) {
    const c = cmd[i];
    if (c === '\\' && !inSingle && i + 1 < cmd.length) {
      current += cmd[++i];
    } else if (c === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (c === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if ((c === ' ' || c === '\t') && !inSingle && !inDouble) {
      if (current) { tokens.push(current); current = ''; }
    } else {
      current += c;
    }
    i++;
  }
  if (current) tokens.push(current);
  return tokens;
}

const VALUE_FLAGS = new Set([
  '-o', '--output', '-m', '--max-time', '--connect-timeout', '--keepalive-time',
  '--limit-rate', '--retry', '--retry-delay', '--retry-max-time', '--interface',
  '--local-port', '--unix-socket', '--abstract-unix-socket', '--cacert', '--capath',
  '--cert', '--key', '--pass', '--proxy', '-x', '--resolve', '--dns-servers',
  '-e', '--referer', '--max-filesize',
]);

export function parseCurlCommand(curlCmd: string): ParsedCurl {
  // Normalize line continuations (Unix \\\n and Windows \\\r\n)
  let cmd = curlCmd.replace(/\\\r?\n\s*/g, ' ').trim();
  if (/^curl\s/i.test(cmd)) cmd = cmd.slice(cmd.indexOf(' ') + 1);

  const result: ParsedCurl = {
    url: null,
    method: '',
    headers: {},
    body: null,
    followRedirects: true,
    insecure: false,
  };

  const tokens = tokenize(cmd);
  let i = 0;

  while (i < tokens.length) {
    const t = tokens[i];

    if (t === '-X' || t === '--request') {
      result.method = tokens[++i]?.toUpperCase() ?? '';
    } else if (t === '-H' || t === '--header') {
      const h = tokens[++i] ?? '';
      const ci = h.indexOf(':');
      if (ci > -1) result.headers[h.slice(0, ci).trim()] = h.slice(ci + 1).trim();
    } else if (['-d', '--data', '--data-raw', '--data-binary', '--data-urlencode'].includes(t)) {
      result.body = tokens[++i] ?? '';
      if (!result.method) result.method = 'POST';
    } else if (t === '--json') {
      result.body = tokens[++i] ?? '';
      result.method = result.method || 'POST';
      result.headers['Content-Type'] = result.headers['Content-Type'] || 'application/json';
      result.headers['Accept'] = result.headers['Accept'] || 'application/json, */*';
    } else if (t === '-L' || t === '--location') {
      result.followRedirects = true;
    } else if (t === '-k' || t === '--insecure') {
      result.insecure = true;
    } else if (t === '-u' || t === '--user') {
      result.headers['Authorization'] = 'Basic ' + Buffer.from(tokens[++i] ?? '').toString('base64');
    } else if (t === '-A' || t === '--user-agent') {
      result.headers['User-Agent'] = tokens[++i] ?? '';
    } else if (t === '-b' || t === '--cookie') {
      result.headers['Cookie'] = tokens[++i] ?? '';
    } else if (t === '--url') {
      result.url = tokens[++i] ?? null;
    } else if (t === '-I' || t === '--head') {
      result.method = 'HEAD';
    } else if (t === '-G' || t === '--get') {
      result.method = 'GET';
    } else if (VALUE_FLAGS.has(t)) {
      i++;
    } else if (!t.startsWith('-')) {
      if (!result.url) result.url = t;
    }

    i++;
  }

  if (!result.method) result.method = result.body ? 'POST' : 'GET';
  return result;
}
