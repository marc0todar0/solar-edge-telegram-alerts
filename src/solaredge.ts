import fs from "node:fs";
import path from "node:path";

/*
 * SolarEdge Monitoring API V2 client (Site Access / OAuth2, Free tier).
 * Tokens live in DATA_DIR/tokens.json. The refresh token rotates on every refresh
 * and expires after 14 days unused, so the newest one is always written back.
 */

const BASE = "https://monitoringapi.solaredge.com/v2";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const TOKENS_FILE = path.join(DATA_DIR, "tokens.json");

type Tokens = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  obtained_at: number;
};

export class AuthError extends Error {}

const loadTokens = (): Tokens => {
  try {
    return JSON.parse(fs.readFileSync(TOKENS_FILE, "utf8"));
  } catch {
    throw new AuthError(`Token file missing or unreadable: ${TOKENS_FILE}. Run scripts/authorize.mjs.`);
  }
};

const saveTokens = (t: Tokens) => {
  const tmp = TOKENS_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(t, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, TOKENS_FILE);
};

let refreshing: Promise<Tokens> | null = null;

const refresh = (old: Tokens): Promise<Tokens> => {
  // Single in-flight refresh: a rotated refresh token can only be used once.
  refreshing ??= (async () => {
    const r = await fetch(`${BASE}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: old.refresh_token,
        client_id: process.env.SE_CLIENT_ID,
        client_secret: process.env.SE_CLIENT_SECRET,
      }),
    });
    const body: any = await r.json().catch(() => ({}));
    if (!r.ok) {
      throw new AuthError(`Token refresh failed (${r.status} ${body.error || ""}). Re-run scripts/authorize.mjs.`);
    }
    const t: Tokens = { ...old, ...body, obtained_at: Date.now() };
    saveTokens(t);
    console.log("SolarEdge token refreshed");
    return t;
  })().finally(() => (refreshing = null));
  return refreshing;
};

const validTokens = async (): Promise<Tokens> => {
  const t = loadTokens();
  const expiresAt = t.obtained_at + (t.expires_in - 300) * 1000; // 5 min margin
  return Date.now() < expiresAt ? t : refresh(t);
};

const get = async (p: string, params: Record<string, string>): Promise<any> => {
  const url = `${BASE}/sites/${process.env.MY_SOLAR_EDGE_SITE}/${p}?${new URLSearchParams(params)}`;
  let t = await validTokens();
  let r = await fetch(url, { headers: { Authorization: `Bearer ${t.access_token}` } });
  if (r.status === 401) {
    t = await refresh(t);
    r = await fetch(url, { headers: { Authorization: `Bearer ${t.access_token}` } });
  }
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`SolarEdge ${p} -> HTTP ${r.status}: ${body.slice(0, 200)}`);
  }
  return r.json();
};

/* Latest non-null value of a { unit, values: [{timestamp, value}] } series. */
const latest = (series: any): { value: number; timestamp: string } | null => {
  const vals = (series?.values || []).filter((v: any) => v.value !== null && v.value !== undefined);
  return vals.length ? vals[vals.length - 1] : null;
};

/* Sum the latest value of `metric` across every device in a telemetry map. */
const sumLatest = (devices: Record<string, any>, metric: string) => {
  let value = 0;
  let timestamp: string | null = null;
  let found = false;
  for (const dev of Object.values(devices || {})) {
    const l = latest(dev?.[metric]);
    if (l) {
      value += l.value;
      found = true;
      if (!timestamp || l.timestamp > timestamp) timestamp = l.timestamp;
    }
  }
  return found ? { value, timestamp } : null;
};

export type Snapshot = {
  timestamp: string | null; // start of the 15-min bucket, site local time
  pvW: number | null;
  loadW: number | null;
  importW: number;
  exportW: number;
  chargeW: number;
  dischargeW: number;
  batteryPct: number | null;
};

/* 2 API calls (2 credits). Data is 15-minute averages, typically ~15 min behind. */
export const getSnapshot = async (): Promise<Snapshot> => {
  const to = new Date();
  const from = new Date(to.getTime() - 60 * 60 * 1000);
  const params = {
    from: from.toISOString().replace(/\.\d+Z$/, "Z"),
    to: to.toISOString().replace(/\.\d+Z$/, "Z"),
    resolution: "QUARTER_HOUR",
  };
  const [meters, storage] = await Promise.all([get("meters/telemetry", params), get("storage/telemetry", params)]);

  const m = meters.meters || {};
  const s = storage.storage || {};
  const load = sumLatest(m, "consumptionPower");
  const imp = sumLatest(m, "importPower");
  const exp = sumLatest(m, "exportPower");
  const prod = sumLatest(m, "productionPower");
  const charge = sumLatest(s, "chargePower");
  const discharge = sumLatest(s, "dischargePower");
  const soe = sumLatest(s, "stateOfEnergy");
  const nBatteries = Object.values(s).filter((d: any) => latest(d?.stateOfEnergy)).length;

  const importW = imp?.value ?? 0;
  const exportW = exp?.value ?? 0;
  const chargeW = charge?.value ?? 0;
  const dischargeW = discharge?.value ?? 0;
  // No production meter on this site: derive PV from the energy balance.
  const pvW = prod
    ? prod.value
    : load
    ? Math.max(0, load.value + exportW + chargeW - importW - dischargeW)
    : null;

  // stateOfEnergy comes as a 0..1 fraction despite unit "PERCENTAGE".
  let batteryPct: number | null = null;
  if (soe && nBatteries) {
    const avg = soe.value / nBatteries;
    batteryPct = avg <= 1 ? avg * 100 : avg;
  }

  return {
    timestamp: load?.timestamp ?? exp?.timestamp ?? null,
    pvW,
    loadW: load?.value ?? null,
    importW,
    exportW,
    chargeW,
    dischargeW,
    batteryPct,
  };
};
