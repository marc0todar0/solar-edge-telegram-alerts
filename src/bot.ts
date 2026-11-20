import { Bot } from "grammy";
import { AuthError, getSnapshot, Snapshot } from "./solaredge";
require("dotenv").config();

/*
 * Env:
 *   TELEGRAM_TOKEN, chatID, MY_SOLAR_EDGE_SITE, SE_CLIENT_ID, SE_CLIENT_SECRET
 *   POLLING_RATE_SEC        how often to check SolarEdge (default 1800 = 30 min)
 *   ACTIVE_HOURS            local hours to poll in, "start-end" (default "8-18")
 *   MINUTES_BEFORE_UPDATE   min gap between two export alerts (default 120)
 * Free tier budget: 2000 credits/month; each check costs 2.
 */

const POLL_SEC = parseInt(process.env.POLLING_RATE_SEC || "1800");
const [START_H, END_H] = (process.env.ACTIVE_HOURS || "8-18").split("-").map((n) => parseInt(n));
const ALERT_GAP_MIN = parseInt(process.env.MINUTES_BEFORE_UPDATE || "120");
const EXPORT_MIN_W = 300; // notify above this
const EXPORT_WARN_W = 500;
const EXPORT_ALARM_W = 2000;

const bot = new Bot(process.env.TELEGRAM_TOKEN || "");
const chatId = process.env.chatID + "";

const kw = (w: number | null) => (w === null ? "n/d" : (w / 1000).toFixed(2));
const hhmm = (ts: string | null) => (ts ? ts.slice(11, 16) : "?");

const formatSnapshot = (s: Snapshot) => {
  const lines: string[] = [];
  if (s.exportW > EXPORT_ALARM_W) {
    lines.push(`🚨🚨🚨Troppa energia in rete: <b>${kw(s.exportW)}kW</b> USALA!!🚨🚨🚨`);
  } else if (s.exportW > EXPORT_WARN_W) {
    lines.push(`⚠️Attenzione stai mandando energia in rete, <b>${kw(s.exportW)}kW</b>! Sfruttala ORA⚠️`);
  }
  lines.push(`STATO (media 15 min delle ${hhmm(s.timestamp)}):`);
  lines.push(`Sun Power 🌤️: <b>${kw(s.pvW)}kW</b>`);
  const batt = s.batteryPct === null ? "n/d" : `${Math.round(s.batteryPct)}%`;
  const battFlow =
    s.chargeW > 20 ? `in carica ${kw(s.chargeW)}kW` : s.dischargeW > 20 ? `in scarica ${kw(s.dischargeW)}kW` : "ferma";
  lines.push(`Battery% 🔋: <b>${batt}</b>, ${battFlow}`);
  lines.push(`Consumi 🏠: <b>${kw(s.loadW)}kW</b>`);
  if (s.exportW > 20) lines.push(`Rete ⚡: immetti <b>${kw(s.exportW)}kW</b>`);
  else if (s.importW > 20) lines.push(`Rete ⚡: prelevi <b>${kw(s.importW)}kW</b>`);
  return lines.join("\n");
};

/* ERROR REPORTING: tell the chat once when things break and once when they recover. */
let failing = false;
const reportError = async (err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[${new Date().toISOString()}] ${msg}`);
  if (failing) return;
  failing = true;
  const hint = err instanceof AuthError ? "\nServe rifare l'autorizzazione OAuth (scripts/authorize.mjs)." : "";
  await bot.api.sendMessage(chatId, `❌ Errore SolarEdge: ${msg}${hint}`).catch(() => {});
};
const reportOk = async () => {
  if (!failing) return;
  failing = false;
  await bot.api.sendMessage(chatId, "✅ SolarEdge di nuovo raggiungibile").catch(() => {});
};

/* COMMANDS */
bot.command("yo", (ctx) => ctx.reply(`Yo ${ctx.from?.username}`));
bot.command("now", async (ctx) => {
  try {
    const s = await getSnapshot();
    await reportOk();
    await ctx.reply(formatSnapshot(s), { parse_mode: "HTML" });
  } catch (err) {
    await reportError(err);
    await ctx.reply("Non riesco a leggere i dati da SolarEdge in questo momento.");
  }
});
const intro =
  `/now per ricevere dati attuali (medie di 15 minuti, ~15 min di ritardo)\n` +
  `Le notifiche importanti te le mando io!\n` +
  `Controllo ogni ${Math.round(POLL_SEC / 60)} min dalle ${START_H} alle ${END_H}: ` +
  `ti scrivo se mandi in rete più di ${EXPORT_MIN_W / 1000}kW ` +
  `(warning se > ${EXPORT_WARN_W / 1000}kW, alert se > ${EXPORT_ALARM_W / 1000}kW)`;
bot.command("start", (ctx) => ctx.reply(intro));
bot.on("message", (ctx) => ctx.reply(intro));
bot.catch((err) => console.error(`Telegram handler error: ${err.message}`));

/* PERIODIC CHECK */
let lastAlert = 0;
const check = async () => {
  const hour = new Date().getHours();
  if (hour < START_H || hour >= END_H) return;
  if (Date.now() - lastAlert < ALERT_GAP_MIN * 60 * 1000) return; // don't spend credits while muted
  try {
    const s = await getSnapshot();
    await reportOk();
    console.log(`[${new Date().toISOString()}] check: pv=${s.pvW} load=${s.loadW} export=${s.exportW} batt=${s.batteryPct}`);
    if (s.exportW > EXPORT_MIN_W) {
      lastAlert = Date.now();
      await bot.api.sendMessage(chatId, formatSnapshot(s), { parse_mode: "HTML" });
    }
  } catch (err) {
    await reportError(err);
  }
};

/* Keeps the 14-day refresh token alive even if checks are skipped for a long time. */
const keepAlive = () => getSnapshot().then(reportOk).catch(reportError);

if (process.argv.includes("--once")) {
  // Local dry run: print one snapshot, no Telegram.
  getSnapshot()
    .then((s) => console.log(s, "\n\n" + formatSnapshot(s)))
    .catch((e) => (console.error(e.message), process.exit(1)));
} else {
  setInterval(check, POLL_SEC * 1000);
  setInterval(keepAlive, 3 * 24 * 3600 * 1000);
  bot.api
    .setMyCommands([
      { command: "yo", description: "Be greeted by the bot" },
      { command: "now", description: "per ricevere dati attuali" },
    ])
    .catch((e) => console.error(`setMyCommands failed: ${e.message}`));
  check();
  console.log(`Bot running: poll ${POLL_SEC}s, hours ${START_H}-${END_H}`);
  bot.start();
}
