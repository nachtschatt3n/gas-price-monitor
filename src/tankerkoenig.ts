export type FuelType = "e5" | "e10" | "diesel";

export interface Station {
  id: string;
  name: string;
  brand: string;
  street: string;
  houseNumber: string;
  postCode: number;
  place: string;
  lat: number;
  lng: number;
  dist: number;
  isOpen: boolean;
  e5: number | false;
  e10: number | false;
  diesel: number | false;
}

interface ListResponse {
  ok: boolean;
  license?: string;
  data?: string;
  status?: string;
  message?: string;
  stations?: Station[];
}

export interface ListQuery {
  lat: number;
  lng: number;
  radius: number;
  type?: FuelType | "all";
  sort?: "dist" | "price";
}

const BASE = "https://creativecommons.tankerkoenig.de/json/list.php";

export class TankerkoenigError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = "TankerkoenigError";
  }
}

export async function listStations(query: ListQuery, apiKey: string): Promise<Station[]> {
  if (!apiKey) {
    throw new TankerkoenigError("API key missing — set TANKERKOENIG_API_KEY", 500);
  }

  const sort = query.sort ?? "dist";
  const type = query.type ?? "all";

  if (sort === "price" && type === "all") {
    throw new TankerkoenigError("sort=price requires a specific fuel type (not 'all')", 400);
  }

  const params = new URLSearchParams({
    lat: query.lat.toString(),
    lng: query.lng.toString(),
    rad: query.radius.toString(),
    sort,
    type,
    apikey: apiKey,
  });

  const url = `${BASE}?${params}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });

  if (!res.ok) {
    throw new TankerkoenigError(`upstream HTTP ${res.status}`, res.status);
  }

  const body = (await res.json()) as ListResponse;

  if (!body.ok) {
    throw new TankerkoenigError(body.message ?? "upstream returned ok=false", 502);
  }

  return body.stations ?? [];
}
