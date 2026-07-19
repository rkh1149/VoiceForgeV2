import { describe, expect, it } from "vitest";
import {
  buildPlatformRecordReport,
  platformRecordsToCsv,
  queryPlatformRecords,
  type SearchableRecord,
} from "./records-query";

const records: SearchableRecord[] = [
  {
    id: "1",
    data: {
      name: "Park picnic",
      category: "Outdoors",
      status: "planned",
      cost: 25,
      planned_date: "2026-08-01",
    },
    createdAt: new Date("2026-07-01T10:00:00Z"),
    updatedAt: new Date("2026-07-03T10:00:00Z"),
    deletedAt: null,
  },
  {
    id: "2",
    data: {
      name: "Museum visit",
      category: "Learning",
      status: "done",
      cost: 40,
      planned_date: "2026-07-20",
    },
    createdAt: new Date("2026-07-02T10:00:00Z"),
    updatedAt: new Date("2026-07-04T10:00:00Z"),
    deletedAt: null,
  },
  {
    id: "3",
    data: {
      name: "Backyard games",
      category: "Outdoors",
      status: "planned",
      cost: 10,
      planned_date: "2026-07-25",
    },
    createdAt: new Date("2026-07-03T10:00:00Z"),
    updatedAt: new Date("2026-07-05T10:00:00Z"),
    deletedAt: null,
  },
];

describe("platform record query engine", () => {
  it("searches selected fields, filters, sorts, and paginates records", () => {
    const result = queryPlatformRecords(
      records,
      {
        query: "park",
        fields: ["name"],
        filters: [{ fieldKey: "status", operator: "equals", value: "planned" }],
        sort: [{ fieldKey: "cost", direction: "desc" }],
        limit: 1,
      },
      ["name", "category"],
    );

    expect(result.total).toBe(1);
    expect(result.records[0].id).toBe("1");
  });

  it("supports range filters and date-like sorting", () => {
    const result = queryPlatformRecords(records, {
      filters: [
        { fieldKey: "cost", operator: "between", value: 10, valueTo: 25 },
      ],
      sort: [{ fieldKey: "planned date", direction: "asc" }],
    });

    expect(result.records.map((record) => record.id)).toEqual(["3", "1"]);
  });

  it("builds grouped count and numeric reports", () => {
    const countReport = buildPlatformRecordReport(records, {
      groupByFieldKey: "category",
      metric: "count",
    });
    expect(countReport.rows).toContainEqual({
      label: "Outdoors",
      count: 2,
      sum: null,
      average: null,
    });

    const averageReport = buildPlatformRecordReport(records, {
      groupByFieldKey: "category",
      metric: "average",
      metricFieldKey: "cost",
    });
    expect(
      averageReport.rows.find((row) => row.label === "Outdoors")?.average,
    ).toBe(17.5);
  });

  it("exports records as real CSV with escaped cells", () => {
    const firstData = records[0].data as Record<string, unknown>;
    const csv = platformRecordsToCsv(
      [
        {
          ...records[0],
          data: { ...firstData, notes: 'Bring "snacks", water' },
        },
      ],
      ["name", "notes"],
    );

    expect(csv).toContain("id,createdAt,updatedAt,name,notes");
    expect(csv).toContain('"Bring ""snacks"", water"');
  });
});
