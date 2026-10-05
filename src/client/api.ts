import type {
  ClaimSecretResponse,
  CreateSecretRequest,
  CreateSecretResponse,
  SecretStatusResponse,
} from "../shared/protocol";

export type ApiFailure = "not_found" | "rate_limited" | "too_large" | "network" | "server";

export type ApiResult<T> = { ok: true; data: T } | { ok: false; failure: ApiFailure };

async function request<T>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      credentials: "omit",
    });
  } catch {
    return { ok: false, failure: "network" };
  }
  if (response.ok) {
    try {
      return { ok: true, data: (await response.json()) as T };
    } catch {
      return { ok: false, failure: "network" };
    }
  }
  if (response.status === 404) return { ok: false, failure: "not_found" };
  if (response.status === 429) return { ok: false, failure: "rate_limited" };
  if (response.status === 413) return { ok: false, failure: "too_large" };
  return { ok: false, failure: "server" };
}

export function createSecret(body: CreateSecretRequest) {
  return request<CreateSecretResponse>("/api/secrets", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function secretStatus(id: string) {
  return request<SecretStatusResponse>(`/api/secrets/${id}`);
}

export function claimSecret(id: string) {
  return request<ClaimSecretResponse>(`/api/secrets/${id}/claim`, { method: "POST" });
}
