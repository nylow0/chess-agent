# Post-mortem

Post-mortem reviews recorded chess games and learns a player's preferences among near-equal moves.

## Language

**Game analysis**:
An engine-backed review of a recorded game's moves, including evaluations, move verdicts and a summary from a selected player's perspective.
_Avoid_: Position evaluation

**Position evaluation**:
An engine assessment of a board position, as distinct from a review of a recorded game's move history.

**Decision**:
A player's recorded move choice at a particular point in a game, together with candidate moves and position context. A decision can exist without being eligible for style training.

**Style profile**:
A learned account of a player's preferences among near-equal moves, together with evidence for how well those preferences predict choices.
_Avoid_: Player stats
