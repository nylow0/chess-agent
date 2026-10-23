import { defineConfig } from "@playwright/test";
import { player } from "./tests/helpers";

export default defineConfig({
  testDir: "./tests",
  outputDir: ".artifacts/playwright",
  workers: 1,
  timeout: 60000,
  use: {
    baseURL: "http://localhost:3210",
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
  },
  // One server only: the API, which also serves the built web app from
  // apps/web/dist. The e2e-server script builds the app before it starts.
  webServer: {
    command: "bun tests/e2e-server.ts",
    url: `http://localhost:3210/api/profile/${encodeURIComponent(player)}`,
    timeout: 180_000,
    reuseExistingServer: false,
  },
});
