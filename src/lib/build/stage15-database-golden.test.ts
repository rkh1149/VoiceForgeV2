import { describe, expect, it } from "vitest";
import { runStage15DatabaseGolden } from "./stage15-database-golden";

const enabled = process.env.RUN_STAGE15_DATABASE_GOLDEN === "1";

describe("Stage 15 Neon database golden", () => {
  it.skipIf(!enabled)(
    "proves validation, role enforcement, refresh, search, reports, and exports",
    async () => {
      const result = await runStage15DatabaseGolden();
      expect(result.viewerReadCount).toBe(1);
      expect(result.searchCount).toBe(1);
      expect(result.reportCount).toBe(1);
      expect(result.csvRowCount).toBe(1);
      expect(result.viewerWriteRejected).toBe(true);
      expect(result.invalidFieldRejected).toBe(true);
    },
    2 * 60_000,
  );
});
