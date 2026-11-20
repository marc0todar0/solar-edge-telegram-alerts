// One-time OAuth consent: node scripts/authorize.mjs
// Reads CLIENT_ID / CLIENT_SECRET from env.txt, listens on 127.0.0.1:8080/callback,
// exchanges the code and writes data/tokens.json (never printed).
import http from "node:http";
import fs from "node:fs";
import crypto from "node:crypto";

const env = Object.fromEntries(
  fs.readFileSync(new URL("../env.txt", import.meta.url), "utf8")
    .split("\n").filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
const REDIRECT = "http://127.0.0.1:8080/callback";
const state = crypto.randomBytes(12).toString("hex");
const url = new URL("https://connect.solaredge.com/authorize");
url.search = new URLSearchParams({
  client_id: env.CLIENT_ID, scope: "SITE_DATA DEVICE_DATA", redirect_uri: REDIRECT, response_type: "code", state,
}).toString();

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, REDIRECT);
  if (u.pathname !== "/callback") return res.end();
  const done = (msg) => { res.end(msg); console.log(msg); server.close(); };
  console.log("callback params:", [...u.searchParams.keys()].join(", "));
  const got = u.searchParams.get("state");
  if (got !== null && got !== state) return done(`State mismatch (got ${got.length} chars)`);
  if (!u.searchParams.get("code")) return done("No code: " + u.search);
  const r = await fetch("https://monitoringapi.solaredge.com/v2/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code", code: u.searchParams.get("code"),
      client_id: env.CLIENT_ID, client_secret: env.CLIENT_SECRET, redirect_uri: REDIRECT,
    }),
  });
  const body = await r.json();
  if (!r.ok) return done(`Token exchange failed ${r.status}: ${body.error || ""} ${body.error_description || ""}`);
  fs.mkdirSync(new URL("../data/", import.meta.url), { recursive: true });
  fs.writeFileSync(new URL("../data/tokens.json", import.meta.url),
    JSON.stringify({ ...body, site_id: u.searchParams.get("site_id"), obtained_at: Date.now() }, null, 2), { mode: 0o600 });
  done(`OK: tokens saved for site ${u.searchParams.get("site_id")} (fields: ${Object.keys(body).join(", ")})`);
});
server.listen(8080, "127.0.0.1", () => console.log("Open this URL in your browser:\n" + url));
