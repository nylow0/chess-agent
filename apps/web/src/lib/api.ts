import type {
  GameSummary,
  GameDetail,
  GameAnalysis,
  ProfileStats,
  SyncResult,
  StyleProfile,
  Recommendation,
} from "@shared";
import { normalizeTime } from "./chessUtils";

export interface LoginResult {
  username: string;
  avatar?: string;
  url?: string;
  joined?: number;
  followers?: number;
}

export type AnalysisStatus = "pending" | "running" | "done" | "error" | "unanalyzed";

export interface AnalysisPoll {
  status: AnalysisStatus;
  analysis?: GameAnalysis;
  error?: string;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(body?.error ?? `Request failed (${res.status})`, res.status);
  }
  return (await res.json()) as T;
}

export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export const api = {
  login: (username: string) =>
    request<LoginResult>("/api/login", {
      method: "POST",
      body: JSON.stringify({ username }),
    }),

  sync: (username: string, allHistory = false) =>
    request<SyncResult>("/api/sync", {
      method: "POST",
      body: JSON.stringify({ username, allHistory }),
    }),

  games: async (username: string) => {
    const list = await request<GameSummary[]>(
      `/api/games?username=${encodeURIComponent(username)}`,
    );
    return list.map((g) => ({ ...g, playedAt: normalizeTime(g.playedAt) }));
  },

  game: async (uuid: string, username: string) => {
    const detail = await request<GameDetail>(`/api/games/${uuid}?username=${encodeURIComponent(username)}`);
    return { ...detail, playedAt: normalizeTime(detail.playedAt) };
  },

  analyze: (username: string, gameUuids: string[]) =>
    request<{ queued: number }>("/api/analyze", {
      method: "POST",
      body: JSON.stringify({ username, gameUuids }),
    }),

  cancelAnalysis: (username: string) =>
    request<{ cancelled: number }>("/api/analyze/cancel", {
      method: "POST",
      body: JSON.stringify({ username }),
    }),

  analysis: (uuid: string, username: string) =>
    request<AnalysisPoll>(`/api/analysis/${uuid}?username=${encodeURIComponent(username)}`),

  profile: (username: string) =>
    request<ProfileStats>(`/api/profile/${encodeURIComponent(username)}`),

  style: (username: string) => request<StyleProfile>(`/api/style/${encodeURIComponent(username)}`),

  recommend: (username: string, uuid: string, ply: number, tolerance: number, preferenceOnly: boolean) =>
    request<Recommendation>(`/api/recommend/${uuid}/${ply}?username=${encodeURIComponent(username)}&tolerance=${tolerance}&mode=${preferenceOnly ? "preference" : "combined"}`),
};
