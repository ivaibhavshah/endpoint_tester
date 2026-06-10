export interface ParsedCurl {
  url: string | null;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  followRedirects: boolean;
  insecure: boolean;
}

export interface Timing {
  dnsPlusQueue: number;
  tcpConnect: number;
  tlsHandshake: number;
  ttfb: number;
  download: number;
  total: number;
}

export interface RequestResult {
  statusCode: number;
  statusMessage: string;
  httpVersion: string;
  headers: Record<string, string | string[]>;
  body: string;
  bodyFormatted: string;
  bodySize: number;
  isJson: boolean;
  url: string;
  method: string;
  timing: Timing;
  error?: string;
}

export interface AggregateStats {
  runs: number;
  successful: number;
  vus: number;
  totalDuration: number;
  throughput: number;
  errorRate: number;
  total: { min: number; max: number; avg: number; p95: number };
  ttfb:  { min: number; max: number; avg: number; p95: number };
}

export type AuthType = 'none' | 'bearer' | 'basic' | 'apikey';

export interface AuthConfig {
  type: AuthType;
  token?: string;
  username?: string;
  password?: string;
  keyName?: string;
  keyValue?: string;
}

export interface SuiteRequestResult {
  idx: number;
  name: string;
  results: RequestResult[];
  items: Array<{ result: RequestResult; vuIdx: number; runIdx: number }>;
  stats: AggregateStats | null;
  parsed: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string | null;
  };
}

// kept for legacy compat
export interface TestResponseData {
  result: RequestResult;
  allResults: RequestResult[];
  stats: AggregateStats | null;
  parsed: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string | null;
  };
}
