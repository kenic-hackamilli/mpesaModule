export type FetchOptions = {
  method?: string;
  headers?: Record<string, string>;
  body?: any;
  timeoutMs?: number;
};

export type FetchResult<T> = {
  ok: boolean;
  status: number;
  data: T | null;
  raw: string | null;
  error?: unknown;
};

export const fetchJson = async <T>(url: string, options: FetchOptions = {}): Promise<FetchResult<T>> => {
  const controller = new AbortController();
  const timeout = options.timeoutMs ? setTimeout(() => controller.abort(), options.timeoutMs) : null;

  try {
    const res = await fetch(url, {
      method: options.method ?? "GET",
      headers: {
        "Content-Type": "application/json",
        ...(options.headers ?? {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });

    const raw = await res.text();
    let data: T | null = null;

    if (raw) {
      try {
        data = JSON.parse(raw) as T;
      } catch {
        data = null;
      }
    }

    return { ok: res.ok, status: res.status, data, raw };
  } catch (error) {
    return { ok: false, status: 0, data: null, raw: null, error };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};
