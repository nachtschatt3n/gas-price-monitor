export type FuelType = "e5" | "e10" | "diesel";
export type RequestedFuel = FuelType | "all";

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
  stations?: RawStation[];
}

interface RawStation {
  id?: unknown;
  name?: unknown;
  brand?: unknown;
  street?: unknown;
  houseNumber?: unknown;
  postCode?: unknown;
  place?: unknown;
  lat?: unknown;
  lng?: unknown;
  dist?: unknown;
  isOpen?: unknown;
  e5?: unknown;
  e10?: unknown;
  diesel?: unknown;
  price?: unknown;
}

export interface ListQuery {
  lat: number;
  lng: number;
  radius: number;
  type?: RequestedFuel;
  sort?: "dist" | "price";
}

const BASE = "https://creativecommons.tankerkoenig.de/json/list.php";

export class TankerkoenigError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = "TankerkoenigError";
  }
}

export interface ListStationsDeps {
  fetch?: typeof globalThis.fetch;
}

export async function listStations(
  query: ListQuery,
  apiKey: string,
  deps: ListStationsDeps = {},
): Promise<Station[]> {
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
  const fetchImpl = deps.fetch ?? globalThis.fetch;

  let res: Response;
  try {
    res = await fetchImpl(url, { headers: { Accept: "application/json" } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "fetch failed";
    throw new TankerkoenigError(`upstream unreachable: ${msg}`, 502);
  }

  if (!res.ok) {
    throw new TankerkoenigError(`upstream HTTP ${res.status}`, 502);
  }

  let body: ListResponse;
  try {
    body = (await res.json()) as ListResponse;
  } catch {
    throw new TankerkoenigError("upstream returned malformed JSON", 502);
  }

  if (!body.ok) {
    throw new TankerkoenigError(body.message ?? "upstream returned ok=false", 502);
  }

  return (body.stations ?? []).map((raw) => normalizeStation(raw, type));
}

function normalizeStation(raw: RawStation, requestedType: RequestedFuel): Station {
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const price = (v: unknown): number | false => (typeof v === "number" && v > 0 ? v : false);

  let e5: number | false = false;
  let e10: number | false = false;
  let diesel: number | false = false;

  if (requestedType === "all") {
    e5 = price(raw.e5);
    e10 = price(raw.e10);
    diesel = price(raw.diesel);
  } else {
    const p = price(raw.price);
    if (requestedType === "e5") e5 = p;
    else if (requestedType === "e10") e10 = p;
    else if (requestedType === "diesel") diesel = p;
  }

  return {
    id: str(raw.id),
    name: str(raw.name),
    brand: str(raw.brand),
    street: str(raw.street),
    houseNumber: str(raw.houseNumber),
    postCode: typeof raw.postCode === "number" ? raw.postCode : 0,
    place: str(raw.place),
    lat: num(raw.lat),
    lng: num(raw.lng),
    dist: num(raw.dist),
    isOpen: raw.isOpen === true,
    e5,
    e10,
    diesel,
  };
}
