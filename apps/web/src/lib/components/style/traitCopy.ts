import type { FeatureName } from "@shared";

export interface TraitCopy {
  name: string;
  sentence: string;
}

/**
 * Player-facing name and one-line explanation for each style feature, split by
 * the sign of the learned preference. A positive preference means the player
 * picks moves with more of the feature; a negative preference means fewer.
 */
export const traitCopy: Record<FeatureName, { positive: TraitCopy; negative: TraitCopy }> = {
  trades: {
    positive: { name: "Trading pieces", sentence: "You more often pick the move that leads to an exchange." },
    negative: { name: "Avoiding trades", sentence: "You more often pick the move that keeps the pieces on." },
  },
  queensOff: {
    positive: { name: "Queenless positions", sentence: "You more often pick the move that takes the queens off." },
    negative: { name: "Keeping the queens", sentence: "You more often pick the move that keeps the queens on." },
  },
  centerLock: {
    positive: { name: "Locked centres", sentence: "You more often pick the move that leaves the central pawns blocked." },
    negative: { name: "Open centres", sentence: "You more often pick the move that keeps the central pawns free." },
  },
  openFiles: {
    positive: { name: "Open files", sentence: "You more often pick the move that opens a file." },
    negative: { name: "Closed files", sentence: "You more often pick the move that keeps the files closed." },
  },
  aggression: {
    positive: { name: "Forcing moves", sentence: "You more often pick checks, captures and moves toward the enemy king." },
    negative: { name: "Quiet moves", sentence: "You more often pick the calm move over a check or capture." },
  },
  pawnStorm: {
    positive: { name: "Pawn storms", sentence: "You more often push pawns on the side where the enemy king lives." },
    negative: { name: "Holding pawns back", sentence: "You more often keep the pawns near the enemy king at home." },
  },
  kingSafety: {
    positive: { name: "A safer king", sentence: "You more often pick the move that keeps your king sheltered." },
    negative: { name: "King risks", sentence: "You more often pick the move that loosens your own king's shelter." },
  },
  materialRisk: {
    positive: { name: "Giving up material", sentence: "You more often pick the move that leaves material to be taken." },
    negative: { name: "Holding on to material", sentence: "You more often pick the move that keeps your material safe." },
  },
  activity: {
    positive: { name: "Active pieces", sentence: "You more often pick the move that gives your pieces more squares." },
    negative: { name: "Compact setups", sentence: "You more often pick the move that keeps your pieces close together." },
  },
  restriction: {
    positive: { name: "Restricting the opponent", sentence: "You more often pick the move that leaves the opponent fewer replies." },
    negative: { name: "Leaving options open", sentence: "You more often pick the move that leaves the opponent more replies." },
  },
  complexity: {
    positive: { name: "Sharp positions", sentence: "You more often choose when the candidate moves differ a lot in value." },
    negative: { name: "Calm positions", sentence: "You more often choose when the candidate moves are close in value." },
  },
  endgame: {
    positive: { name: "Endgames", sentence: "You more often pick the move that heads for an endgame." },
    negative: { name: "Middlegames", sentence: "You more often pick the move that keeps more pieces on the board." },
  },
  development: {
    positive: { name: "Developing pieces", sentence: "You more often pick the move that brings a knight or bishop out, or castles." },
    negative: { name: "Other plans first", sentence: "You more often pick another plan before finishing development." },
  },
  centerControl: {
    positive: { name: "Central control", sentence: "You more often pick the move that attacks more central squares." },
    negative: { name: "Play on the wings", sentence: "You more often pick the move away from the centre." },
  },
};
