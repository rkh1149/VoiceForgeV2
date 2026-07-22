import { afterEach, describe, expect, it, vi } from "vitest";
import { listPlatformRecords } from "../../../templates/nextjs-base/src/lib/platform-data";

describe("generated app platform data helper", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("clamps list record limits to the platform maximum", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      return Response.json({ records: [], observedLimit: body.limit });
    });
    vi.stubGlobal("fetch", fetchMock);

    await listPlatformRecords("route_track_point", { limit: 1000 });

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body).toMatchObject({
      action: "listRecords",
      entityKey: "route_track_point",
      limit: 200,
    });
  });
});
