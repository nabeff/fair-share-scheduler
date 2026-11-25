// The only file that talks to the API.

export interface TenantLoad {
  id: string;
  weight: number;
  running: number;
  waiting: number;
}

/** GET /pool */
export interface Pool {
  slots: number;
  tenants: TenantLoad[];
}

export type JobStatus = "pending" | "running" | "succeeded" | "failed" | "dead";

/** GET /jobs/:id. Times are ISO strings. */
export interface Job {
  id: string;
  tenant_id: string;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  /** Next retry, after a failed attempt. */
  run_at: string;
  last_error: string | null;
}

/** `status` is 0 when no answer came at all. */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

// Proxied by Vite in dev and nginx in Docker, so no CORS.
const BASE = "/api";

// A bit longer than the API's own 5 s, so we get its 503 instead.
const TIMEOUT_MS = 6000;

async function call(path: string, init: RequestInit = {}): Promise<unknown> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const signal = init.signal
    ? AbortSignal.any([init.signal, timeout])
    : timeout;

  let response: Response;
  let text: string;
  try {
    response = await fetch(BASE + path, { ...init, signal });
    text = await response.text();
  } catch (err) {
    if (init.signal?.aborted) throw err;
    throw new ApiError(0, "The API does not answer.");
  }

  // nginx may answer with HTML.
  const answer = parseJson(text);
  if (!response.ok) {
    const words = isObject(answer) ? answer.error : undefined;
    throw new ApiError(
      response.status,
      typeof words === "string"
        ? words
        : `The API answered ${response.status}.`,
    );
  }
  return answer;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

// Validate answers here, so components can trust the types.
const unexpected = () =>
  new ApiError(200, "The API sent an answer this page does not understand.");

const isTenantLoad = (value: unknown): value is TenantLoad =>
  isObject(value) &&
  typeof value.id === "string" &&
  typeof value.weight === "number" &&
  typeof value.running === "number" &&
  typeof value.waiting === "number";

const isPool = (value: unknown): value is Pool =>
  isObject(value) &&
  typeof value.slots === "number" &&
  Array.isArray(value.tenants) &&
  value.tenants.every(isTenantLoad);

const isJob = (value: unknown): value is Job =>
  isObject(value) &&
  typeof value.id === "string" &&
  typeof value.tenant_id === "string" &&
  typeof value.status === "string" &&
  typeof value.attempts === "number" &&
  typeof value.max_attempts === "number" &&
  typeof value.created_at === "string";

export async function getPool(signal?: AbortSignal): Promise<Pool> {
  const answer = await call("/pool", { signal });
  if (!isPool(answer)) throw unexpected();
  return answer;
}

/** Returns the new job id. */
export async function submitJob(
  tenantId: string,
  payload: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<string> {
  const answer = await call("/jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tenant_id: tenantId, payload }),
    signal,
  });
  if (!isObject(answer) || typeof answer.id !== "string") throw unexpected();
  return answer.id;
}

/** Null if the job doesn't exist. */
export async function getJob(
  id: string,
  signal?: AbortSignal,
): Promise<Job | null> {
  try {
    const answer = await call(`/jobs/${encodeURIComponent(id)}`, { signal });
    if (!isJob(answer)) throw unexpected();
    return answer;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}
