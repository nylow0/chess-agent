// Tests never open the user's game database, even when invoked with plain `bun test`.
process.env.CHESS_DB_PATH = ":memory:";
