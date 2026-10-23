export type GameResult = "win" | "loss" | "draw";

export interface PlayerSummary {
  username: string;
  rating: number;
  result: GameResult;
  accuracy?: number;
}

export interface GameSummary {
  uuid: string;
  chessComId: string;
  timeControl: string;
  timeClass: "bullet" | "blitz" | "rapid" | "daily";
  rated: boolean;
  playedAt: number;
  white: PlayerSummary;
  black: PlayerSummary;
  opening?: string;
  analyzed: boolean;
  analysisStatus?: "pending" | "running" | "done" | "error";
  myAccuracy?: number;
  myCpl?: number;
  /** My move counts, available once an analysis is stored with the summary columns. */
  myCounts?: { inaccuracy: number; mistake: number; blunder: number };
  /** Chess.com game URL. */
  url?: string;
}

export interface GameDetail extends GameSummary {
  pgn: string;
  moves: string[];
  fens: string[];
}

export interface EngineLine {
  uci: string;
  san: string;
  cp: number | null;
  mate: number | null;
  pv: string[];
}

export interface MoveAnalysis {
  ply: number;
  san: string;
  fenBefore: string;
  fenAfter: string;
  uci: string;
  cpBefore: number | null;
  cpAfter: number | null;
  mateBefore: number | null;
  mateAfter: number | null;
  cpl: number | null;
  classification:
    | "best"
    | "excellent"
    | "good"
    | "inaccuracy"
    | "mistake"
    | "blunder"
    | "book";
  bestMove?: string;
  bestMoveSan?: string;
  lines: EngineLine[];
}

export interface GameAnalysis {
  gameUuid: string;
  /** `revision` is absent on analyses saved before the engine-reset change. */
  engine: { name: string; version: string; depth: number; multiPv: number; revision?: number };
  moves: MoveAnalysis[];
  summary: {
    myAccuracy: number;
    myCpl: number;
    opponentAccuracy: number;
    counts: Record<MoveAnalysis["classification"], number>;
  };
}

export interface EngineStatus {
  name: string;
  version: string;
  ready: boolean;
}

export interface SyncResult {
  newGames: number;
  totalGames: number;
}

export interface ProfileStats {
  username: string;
  games: number;
  analyzedGames: number;
  wins: number;
  draws: number;
  losses: number;
  /** wins divided by games; null when there are no games. */
  winRate: number | null;
  avgAccuracy: number | null;
  avgCpl: number | null;
  /** This player's analyses by queue status. Failed counts status "error". */
  queue: { pending: number; running: number; failed: number };
}

export type ApiError = { error: string };

export const FEATURE_NAMES = ["trades", "queensOff", "centerLock", "openFiles", "aggression", "pawnStorm", "kingSafety", "materialRisk", "activity", "restriction", "complexity", "endgame", "development", "centerControl"] as const;
export type FeatureName = typeof FEATURE_NAMES[number];
export type MoveFeatures = Record<FeatureName, number>;

export interface StyleCandidate extends EngineLine {
  features: MoveFeatures;
  /** Centipawns from the mover's perspective. Mate lines are excluded from choice training. */
  value: number;
}

export interface Decision {
  gameUuid: string;
  /** Unix seconds; zero only for fixtures without historical dates. */
  playedAt: number;
  ply: number;
  fen: string;
  played: string;
  candidates: StyleCandidate[];
  clockLeft: number | null;
  timeSpent: number | null;
  phase: "opening" | "middlegame" | "endgame";
  nextTenPlyCpl: number | null;
}

export interface StyleTrait {
  feature: FeatureName;
  preference: number;
  performanceCp: number | null;
  samples: number;
  contributionPp: number;
  performanceFolds: (number | null)[];
  examples: { gameUuid: string; ply: number; san: string }[];
}

export interface StyleProfile {
  username: string;
  status: "no_signal" | "weak_signal" | "confirmed";
  enoughData: boolean;
  pValue: number;
  gainPp: number;
  modelOnly: number;
  engineOnly: number;
  folds: StyleFold[];
  selectedFeatures: FeatureName[];
  ablations: { feature: FeatureName; contributionPp: number }[];
  recencyHalfLifeDays: number;
  featureSelection?: {
    adopted: boolean;
    originalMatch: number | null;
    candidateMatch: number | null;
    candidateGainPp: number;
    candidatePValue: number;
    selectedFeatures: FeatureName[];
  };
  decisions: number;
  eligibleDecisions: number;
  trainingGames: number;
  heldOutGames: number;
  heldOutDecisions: number;
  baselineMatch: number | null;
  modelMatch: number | null;
  weights: MoveFeatures;
  scales: MoveFeatures;
  lambda: number;
  traits: StyleTrait[];
  /** Set by the HTTP layer when a stale profile is being retrained in the background. */
  updating?: boolean;
}

export interface StyleFold {
  fold: number;
  games: number;
  decisions: number;
  modelCorrect: number;
  engineCorrect: number;
  modelOnly: number;
  engineOnly: number;
  lambda: number;
  selectedFeatures: FeatureName[];
}

export interface Recommendation {
  engineBest: StyleCandidate | null;
  forYou: StyleCandidate | null;
  reason: string;
  tolerance: number;
}
