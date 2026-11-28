/** Minimal structural Express types (`express` is not a direct dependency under pnpm strict). */
export interface ReqLike {
  method: string;
  originalUrl: string;
  url: string;
  path: string;
  query: Record<string, unknown>;
  headers: Record<string, string | string[] | undefined>;
  requestId?: string;
}

export interface ResLike {
  statusCode: number;
  headersSent: boolean;
  setHeader(name: string, value: string): unknown;
  getHeader(name: string): unknown;
  status(code: number): ResLike;
  send(body?: unknown): unknown;
  json(body: unknown): unknown;
  end(body?: unknown): unknown;
}

export type NextLike = (err?: unknown) => void;
