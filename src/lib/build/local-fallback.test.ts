import { afterEach, describe, expect, it } from "vitest";
import { POST } from "../../../templates/nextjs-base/src/app/api/data/route";

const schema = [
  {
    key: "activity",
    name: "Activity",
    fields: [
      {
        key: "name",
        label: "Activity name",
        type: "text",
        required: true,
        options: [],
      },
      {
        key: "planned_date",
        label: "Planned date",
        type: "date",
        required: false,
        options: [],
      },
      {
        key: "estimated_cost",
        label: "Estimated cost",
        type: "number",
        required: false,
        options: [],
      },
    ],
  },
];

describe("generated app local platform fallback", () => {
  afterEach(() => {
    delete process.env.VOICEFORGE_DATA_LOCAL_FALLBACK;
    delete process.env.VOICEFORGE_PLATFORM_SCHEMA_JSON;
  });

  it("validates local records against seeded platform schema keys", async () => {
    process.env.VOICEFORGE_DATA_LOCAL_FALLBACK = "1";
    process.env.VOICEFORGE_PLATFORM_SCHEMA_JSON = JSON.stringify(schema);

    const invalid = await POST(
      new Request("http://local.test/api/data", {
        method: "POST",
        body: JSON.stringify({
          action: "createRecord",
          entityKey: "Activity",
          data: {
            name: "Family picnic",
            plannedDate: "2026-07-18",
            estimatedCost: 12,
          },
        }),
      }),
    );

    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({
      code: "invalid_record",
      details: ['Unknown field "plannedDate".', 'Unknown field "estimatedCost".'],
    });

    const valid = await POST(
      new Request("http://local.test/api/data", {
        method: "POST",
        body: JSON.stringify({
          action: "createRecord",
          entityKey: "Activity",
          data: {
            name: "Family picnic",
            planned_date: "2026-07-18",
            estimated_cost: 12,
          },
        }),
      }),
    );

    expect(valid.status).toBe(201);
  });
});
