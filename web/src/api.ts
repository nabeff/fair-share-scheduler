// The client of the scheduler's HTTP API. Everything the page knows about the
// API is in this file: the paths, the shape of the answers, and what a failure
// looks like. No component calls fetch itself.

/** What one tenant holds and waits for right now. */
export interface TenantLoad {
  id: string;
  weight: number;
  /** Jobs that run on a worker now. */
  running: number;
  /** Jobs that wait: not started yet, or waiting for a retry. */
  waiting: number;
}

/** The answer of GET /pool. */
export interface Pool {
  /** Worker slots that are alive. */
  slots: number;
  tenants: TenantLoad[];
}

export type JobStatus = "pending" | "running" | "succeeded" | "failed" | "dead";

/** The answer of GET /jobs/:id. Times are ISO strings. */
export interface Job {
  id: string;
  tenant_id: string;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  created_at: string;
  /** Start of the latest attempt. */
  started_at: string | null;
  finished_at: string | null;
  /** After a failed attempt: the time of the next one. */
  run_at: string;
  last_error: string | null;
}

/**
 * A call that did not work. `status` is the HTTP status, or 0 when no answer
 * came at all: the API is down, the network is gone, or the call took too long.
 */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

// The same address as the page. Vite (in development) and nginx (in Docker)
// pass everything under /api on to the API, so the browser needs no CORS.
const BASE = "/api";

// The API gives Postgres 5 seconds and then answers 503. We wait a little
// longer than that, to get its answer and not our own timeout.
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
    // The caller stopped the call. That says nothing about the API.
    if (init.signal?.aborted) throw err;
    throw new ApiError(0, "The API does not answer.");
  }

  // Not always JSON: a proxy in front of the API answers with an HTML page.
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

// An answer is checked once, here, where it enters the page. Past this point
// the types can be trusted, and a wrong answer is an error like any other
// instead of a crash somewhere in a component.
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

/** Who holds the workers right now, and who waits. */
export async function getPool(signal?: AbortSignal): Promise<Pool> {
  const answer = await call("/pool", { signal });
  if (!isPool(answer)) throw unexpected();
  return answer;
}

/** Stores one job and returns its id. */
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

/** Reads one job. Null when there is no job with this id. */
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
