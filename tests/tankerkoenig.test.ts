import { describe, expect, test } from "bun:test";
import { listStations, TankerkoenigError } from "../src/tankerkoenig.ts";

function mockFetch(response: { status?: number; body: unknown; reject?: Error }): typeof fetch {
  return (async () => {
    if (response.reject) throw response.reject;
    return new Response(
      typeof response.body === "string" ? response.body : JSON.stringify(response.body),
      { status: response.status ?? 200, headers: { "Content-Type": "application/json" } },
    );
  }) as unknown as typeof fetch;
}

const STATION_ALL_BODY = {
  ok: true,
  stations: [
    {
      id: "abc",
      name: "Aral",
      brand: "Aral",
      street: "Hauptstr",
      houseNumber: "1",
      postCode: 10115,
      place: "Berlin",
      lat: 52.5,
      lng: 13.4,
      dist: 1.2,
      isOpen: true,
      e5: 1.789,
      e10: 1.749,
      diesel: 1.659,
    },
  ],
};

const STATION_E10_BODY = {
  ok: true,
  stations: [
    {
      id: "abc",
      name: "Aral",
      brand: "Aral",
      street: "Hauptstr",
      houseNumber: "1",
      postCode: 10115,
      place: "Berlin",
      lat: 52.5,
      lng: 13.4,
      dist: 1.2,
      isOpen: true,
      price: 1.749,
    },
  ],
};

describe("listStations", () => {
  test("throws TankerkoenigError when apiKey is empty", async () => {
    await expect(
      listStations({ lat: 52.5, lng: 13.4, radius: 5 }, "", { fetch: mockFetch({ body: STATION_ALL_BODY }) }),
    ).rejects.toMatchObject({ name: "TankerkoenigError", status: 500 });
  });

  test("throws 400 when sort=price with type=all", async () => {
    await expect(
      listStations(
        { lat: 52.5, lng: 13.4, radius: 5, type: "all", sort: "price" },
        "key",
        { fetch: mockFetch({ body: STATION_ALL_BODY }) },
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  test("maps upstream 500 to 502", async () => {
    await expect(
      listStations({ lat: 52.5, lng: 13.4, radius: 5 }, "key", {
        fetch: mockFetch({ status: 500, body: "broken" }),
      }),
    ).rejects.toMatchObject({ status: 502 });
  });

  test("maps upstream malformed JSON to 502", async () => {
    await expect(
      listStations({ lat: 52.5, lng: 13.4, radius: 5 }, "key", {
        fetch: mockFetch({ body: "<html>not json</html>" }),
      }),
    ).rejects.toMatchObject({ status: 502 });
  });

  test("maps fetch rejection to 502", async () => {
    await expect(
      listStations({ lat: 52.5, lng: 13.4, radius: 5 }, "key", {
        fetch: mockFetch({ body: {}, reject: new Error("ENOTFOUND") }),
      }),
    ).rejects.toMatchObject({ status: 502 });
  });

  test("maps body.ok=false to 502 with upstream message", async () => {
    await expect(
      listStations({ lat: 52.5, lng: 13.4, radius: 5 }, "key", {
        fetch: mockFetch({ body: { ok: false, message: "key revoked" } }),
      }),
    ).rejects.toThrow(/key revoked/);
  });

  test("happy path with type=all returns e5/e10/diesel fields", async () => {
    const stations = await listStations(
      { lat: 52.5, lng: 13.4, radius: 5 },
      "key",
      { fetch: mockFetch({ body: STATION_ALL_BODY }) },
    );
    expect(stations).toHaveLength(1);
    expect(stations[0]).toMatchObject({
      id: "abc",
      e5: 1.789,
      e10: 1.749,
      diesel: 1.659,
      isOpen: true,
    });
  });

  test("normalizes single-fuel response: type=e10 puts price onto e10", async () => {
    const stations = await listStations(
      { lat: 52.5, lng: 13.4, radius: 5, type: "e10" },
      "key",
      { fetch: mockFetch({ body: STATION_E10_BODY }) },
    );
    expect(stations[0]).toMatchObject({ e10: 1.749, e5: false, diesel: false });
  });

  test("normalizes invalid prices to false (not 0, not NaN)", async () => {
    const stations = await listStations(
      { lat: 52.5, lng: 13.4, radius: 5 },
      "key",
      {
        fetch: mockFetch({
          body: {
            ok: true,
            stations: [
              { id: "x", e5: 0, e10: null, diesel: 1.6, isOpen: false, dist: 2, postCode: 10115 },
            ],
          },
        }),
      },
    );
    expect(stations[0]).toMatchObject({ e5: false, e10: false, diesel: 1.6 });
  });

  test("TankerkoenigError carries status code", () => {
    const err = new TankerkoenigError("nope", 418);
    expect(err.status).toBe(418);
    expect(err.name).toBe("TankerkoenigError");
  });
});
