import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
        test: { name: "worker", include: ["test/worker/**/*.test.ts"] },
      },
      {
        test: {
          name: "client",
          environment: "node",
          include: ["test/client/**/*.test.ts", "test/shared/**/*.test.ts"],
        },
      },
    ],
  },
});
