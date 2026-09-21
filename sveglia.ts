// Supabase Edge Function: sveglia
// Gira ogni 10 minuti (cron) e manda i promemoria a orario: scadenze delle missioni,
// finestra del colpo grosso, flash in scadenza, turni dei servizi e dei bidoni,
// riepilogo della domenica.
//
// Non tocca mai lo stato della casa: legge e basta.
//
// Versione allineata all'app v6:
//  - chi è via di casa (S.fantasmi) non riceve nessun avviso e non ha turni;
//  - i turni si dividono solo fra chi è in casa, con i blocchi dei servizi
//    sostituiti dalla rotazione giorno per giorno quando manca qualcuno;
//  - rispetta i turni congelati (S.turniOv / S.servOv) e i turni passati con un
//    gettone (S.deleghe);
//  - quote aggiornate e nessuna penale sui servizi;
//  - promemoria degli eventi di famiglia (la sera prima e la mattina stessa).
//
// Secrets richiesti: VAPID_PUBLIC, VAPID_PRIVATE, VAPID_SOGGETTO (facoltativo)

import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const PUB = Deno.env.get("VAPID_PUBLIC") ?? "";
const PRIV = Deno.env.get("VAPID_PRIVATE") ?? "";
const SOGG = Deno.env.get("VAPID_SOGGETTO") ?? "mailto:casa@roulette.app";
webpush.setVapidDetails(SOGG, PUB, PRIV);

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

/* ==================== COSTANTI (uguali a index.html) ==================== */
const TZ = "Europe/Rome";
const NOMI = ["Sonia", "Tony", "Samuel", "Thomas"];
const QUOTA: Record<string, number> = {
  facile: 5, media: 8, difficile: 12, mensile: 20, spazzatura: 10, servizio: 0, svuota: 5,
};
const EPOCA = romaTs(2026, 1, 5, 0, 0);
const TIPI = [
  { k: "umido", nome: "Umido", ogni: 1 },
  { k: "plastica", nome: "Plastica e lattine", ogni: 2 },
  { k: "carta", nome: "Carta e cartone", ogni: 2 },
  { k: "indiff", nome: "Indifferenziata", ogni: 1 },
];
const SERVIZI = [
  { k: "tavola", nome: "Sparecchiare e pulire il tavolo" },
  { k: "piatti", nome: "Piatti e lavastoviglie" },
];
const BLOCCHI = [
  { k: "a", gg: [0, 1, 2, 3] },
  { k: "b", gg: [4, 5, 6] },
];

const GIORNO = 864e5;
const eur = (v: number) => "€" + (Math.round(v * 100) / 100).toString().replace(".", ",");

/* ==================== ORA DI ROMA ==================== */
function offsetMin(ts: number) {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(new Date(ts))) p[x.type] = x.value;
  const locale = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return (locale - Math.floor(ts / 1000) * 1000) / 60000;
}
/* mese 1-12 */
function romaTs(y: number, mese: number, g: number, h: number, mi: number) {
  const grezzo = Date.UTC(y, mese - 1, g, h, mi, 0);
  let ts = grezzo - offsetMin(grezzo) * 60000;
  const o2 = offsetMin(ts);
  const ts2 = grezzo - o2 * 60000;
  if (ts2 !== ts) ts = ts2;
  return ts;
}
function pezzi(ts: number) {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, hour12: false, weekday: "short",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(new Date(ts))) p[x.type] = x.value;
  const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday);
  return { y: +p.year, m: +p.month, g: +p.day, h: +p.hour % 24, mi: +p.minute, dow };
}
function daIso(k: string, h: number, mi: number) {
  const [y, m, g] = k.split("-").map(Number);
  return romaTs(y, m, g, h, mi);
}
const giornoDopo = (gk: string) => iso(daIso(gk, 12, 0) + GIORNO);
const giornoPrima = (gk: string) => iso(daIso(gk, 12, 0) - GIORNO);
function iso(ts: number) {
  const p = pezzi(ts);
  return p.y + "-" + String(p.m).padStart(2, "0") + "-" + String(p.g).padStart(2, "0");
}
function lunedi(ts: number) {
  const p = pezzi(ts);
  const mezzanotte = romaTs(p.y, p.m, p.g, 0, 0);
  return mezzanotte - ((p.dow + 6) % 7) * GIORNO;
}
function piuGiorni(ts: number, n: number) {
  const p = pezzi(ts + n * GIORNO);
  return romaTs(p.y, p.m, p.g, 0, 0);
}
const settIdx = (ts: number) => Math.round((lunedi(ts) - EPOCA) / (7 * GIORNO));

/* ==================== CHI È IN CASA ==================== */
const settimanaKey = (ts: number) => iso(lunedi(ts));
function assenti(S: any, ts: number): string[] {
  const g = ((S.fantasmi || {})[settimanaKey(ts)]) || {};
  return NOMI.filter((n) => !!g[n]);
}
function attivi(S: any, ts: number): string[] {
  const via = assenti(S, ts);
  const dentro = NOMI.filter((n) => !via.includes(n));
  return dentro.length ? dentro : NOMI.slice();
}

/* ==================== REGOLE DELLA CASA ==================== */
const bloccato = (liv: string, w: number) =>
  (liv === "media" && w <= 1) || ((liv === "difficile" || liv === "mensile") && w <= 2);
const quotaDi = (m: any) => QUOTA[m.liv] || 0;

function attivo(S: any, tp: any, ms: number) {
  if ((tp.ogni || 1) === 1) return true;
  return ((((settIdx(ms) % 2) + 2) % 2)) === ((S.parita || {})[tp.k] || 0);
}
/* turni dei bidoni della settimana che contiene ms */
function turniSett(S: any, ms: number) {
  const mon = lunedi(ms), w = settIdx(ms), out: any[] = [];
  const dentro = attivi(S, mon);
  let i = 0;
  for (let d = 0; d < 7; d++) {
    const giorno = piuGiorni(mon, d);
    const dow = pezzi(giorno).dow;
    for (const tp of TIPI) {
      if (((S.ritiri || {})[tp.k] || []).includes(dow) && attivo(S, tp, mon)) {
        const gk = iso(giorno);
        const k = gk + "|" + tp.k;
        const st = (S.spazz || {})[k] || {};
        const dl = ((S.deleghe || {})[k]) || null;
        const base = ((S.turniOv || {})[k]) ||
          dentro[(((w + i) % dentro.length) + dentro.length) % dentro.length];
        out.push({
          k, tp, giorno: gk, ts: daIso(gk, 7, 0),
          chi: dl ? dl.a : base,
          fatta: !!st.fatta,
        });
        i++;
      }
    }
  }
  return out;
}
/* turni dei servizi: a blocchi con tutti in casa, giorno per giorno se manca qualcuno */
function serviziSett(S: any, ms: number) {
  const mon = lunedi(ms), w = settIdx(ms), out: any[] = [];
  const dentro = attivi(S, mon);
  const aGiorni = dentro.length < NOMI.length;
  SERVIZI.forEach((sv, si) => BLOCCHI.forEach((bl, bi) => {
    const slot = si * BLOCCHI.length + bi;
    const baseBlocco = dentro[(((w + slot) % dentro.length) + dentro.length) % dentro.length];
    const primo = iso(piuGiorni(mon, bl.gg[0]));
    const bk = primo + "|" + sv.k + "|" + bl.k;
    const ov = (S.servTurni || {})[bk] || {};
    const chiBlocco = ov.chi || baseBlocco;
    bl.gg.forEach((off) => {
      const gk = iso(piuGiorni(mon, off));
      const k = gk + "|" + sv.k;
      const st = (S.serv || {})[k] || {};
      const dl = ((S.deleghe || {})[k]) || null;
      const giorni = aGiorni
        ? dentro[(((w + si + off) % dentro.length) + dentro.length) % dentro.length]
        : chiBlocco;
      const base = ((S.servOv || {})[k]) || giorni;
      out.push({
        k, sv, giorno: gk, ts: daIso(giornoDopo(gk), 10, 0),
        chi: dl ? dl.a : base, fatta: !!st.fatta,
      });
    });
  }));
  return out;
}

/* ==================== COSTRUZIONE DEI PROMEMORIA ==================== */
type Avviso = {
  k: string; quando: number; a: string | string[] | "tutti";
  escludi?: string | string[] | null; titolo: string; testo: string; tag: string; vista: string;
  finestra?: number;
};

export function daMandare(S: any, ora: number): Avviso[] {
  const out: Avviso[] = [];
  const w = S.settimana || 1;
  const viaOra = assenti(S, ora);
  const inCasa = (n: string) => !viaOra.includes(n);
  const add = (a: Avviso) => { if (a.quando <= ora && ora < a.quando + (a.finestra ?? 6 * 36e5)) out.push(a); };

  /* ---- missioni della settimana ---- */
  (S.missioni || []).forEach((m: any) => {
    if (m.fatta || bloccato(m.liv, w) || !m.scad) return;
    if (!inCasa(m.chi)) return;
    const q = quotaDi(m);
    add({
      k: "m:" + m.id + ":24", quando: m.scad - 24 * 36e5, a: m.chi,
      titolo: "Ultimo giorno", tag: "scad-" + m.id, vista: "missioni",
      testo: "«" + m.t + "» scade domani. Se resta lì sono " + eur(q) +
        " in cassa, e da adesso gli altri possono rubartela.",
    });
    add({
      k: "m:" + m.id + ":ruba", quando: m.scad - 24 * 36e5, a: "tutti", escludi: [m.chi, ...viaOra],
      titolo: "Colpo grosso", tag: "ruba-" + m.id, vista: "missioni",
      testo: "«" + m.t + "» di " + m.chi + " scade fra 24 ore. Se la rubi e la fai, " +
        m.chi + " paga " + eur(q) + " in cassa e tu prendi un suo gettone più il premio.",
    });
    add({
      k: "m:" + m.id + ":3", quando: m.scad - 3 * 36e5, a: m.chi, finestra: 2 * 36e5,
      titolo: "Restano tre ore", tag: "scad-" + m.id, vista: "missioni",
      testo: "«" + m.t + "» chiude alle 21. " + eur(q) + " in ballo.",
    });
    add({
      k: "m:" + m.id + ":fine", quando: m.scad, a: m.chi, finestra: 12 * 36e5,
      titolo: "Missione saltata", tag: "salt-" + m.id, vista: "tesoretto",
      testo: "«" + m.t + "» è scaduta. " + eur(q) + " vanno in cassa comune alla chiusura di domenica.",
    });
  });

  /* ---- missioni flash ---- */
  (S.flash || []).forEach((f: any) => {
    if (f.fatta || f.chiuso || !f.scad) return;
    if (inCasa(f.a)) add({
      k: "f:" + f.id + ":12", quando: f.scad - 12 * 36e5, a: f.a,
      titolo: "Flash in scadenza", tag: "flash-" + f.id, vista: "flash",
      testo: "Restano 12 ore per «" + f.t + "». Nessuna penale se scade, ma il gettone di " +
        f.da + " è già stato speso.",
    });
    if (inCasa(f.da)) add({
      k: "f:" + f.id + ":fda", quando: f.scad, a: f.da, finestra: 12 * 36e5,
      titolo: "Flash a vuoto", tag: "flash-" + f.id, vista: "flash",
      testo: "La flash che avevi lanciato a " + f.a + " è scaduta. Il gettone torna a te alla chiusura.",
    });
  });

  /* ---- servizi di casa ---- */
  [-1, 0].forEach((dw) => {
    serviziSett(S, ora + dw * 7 * GIORNO).forEach((t: any) => {
      if (t.ts < (S.servDa || 0)) return;
      if (t.fatta || !inCasa(t.chi)) return;
      add({
        k: "sv:" + t.k + ":sera", quando: daIso(t.giorno, 20, 30), a: t.chi, finestra: 3 * 36e5,
        titolo: "Tocca a te", tag: "serv-" + t.k, vista: "servizi",
        testo: t.sv.nome + ", stasera. Spunta quando è fatto.",
      });
      add({
        k: "sv:" + t.k + ":fine", quando: t.ts, a: t.chi, finestra: 8 * 36e5,
        titolo: "Servizio da recuperare", tag: "serv-" + t.k, vista: "servizi",
        testo: t.sv.nome + " di ieri non è spuntato. Nessuna penale: puoi ancora segnarlo " +
          "entro domenica, oppure lo copre qualcun altro e si prende un tuo gettone.",
      });
    });
  });

  /* ---- bidoni ---- */
  [-1, 0, 1].forEach((dw) => {
    turniSett(S, ora + dw * 7 * GIORNO).forEach((t: any) => {
      if (t.ts < (S.spazzDa || 0)) return;
      if (t.fatta || !inCasa(t.chi)) return;
      add({
        k: "sp:" + t.k + ":sera", quando: daIso(giornoPrima(t.giorno), 20, 30), a: t.chi, finestra: 3 * 36e5,
        titolo: "Bidone fuori stasera", tag: "bid-" + t.k, vista: "spazzatura",
        testo: "Domani mattina passa " + t.tp.nome.toLowerCase() + " e il turno è tuo. " +
          eur(QUOTA.spazzatura) + " se resta dentro.",
      });
      add({
        k: "sp:" + t.k + ":fine", quando: t.ts, a: t.chi, finestra: 8 * 36e5,
        titolo: "Bidone dimenticato", tag: "bid-" + t.k, vista: "spazzatura",
        testo: t.tp.nome + ": turno saltato, " + eur(QUOTA.spazzatura) + " in cassa. " +
          "Se lo segni entro la fine della settimana la penale viene tolta.",
      });
    });
  });

  /* ---- eventi di famiglia ---- */
  (S.eventi || []).forEach((e: any) => {
    if (!e || !e.d || !e.t) return;
    const suo = e.chi && e.chi !== "Tutti" && NOMI.includes(e.chi) ? e.chi : null;
    if (suo && !inCasa(suo)) return;
    const a: string | "tutti" = suo ?? "tutti";
    const escludi = suo ? null : viaOra;
    const quando = e.ora ? " alle " + e.ora : "";
    add({
      k: "ev:" + e.id + ":sera", quando: daIso(giornoPrima(e.d), 21, 0), a, escludi, finestra: 3 * 36e5,
      titolo: "Domani in famiglia", tag: "ev-" + e.id, vista: "calendario",
      testo: "«" + e.t + "» domani" + quando + ".",
    });
    add({
      k: "ev:" + e.id + ":giorno", quando: daIso(e.d, 8, 30), a, escludi, finestra: 4 * 36e5,
      titolo: "Oggi in famiglia", tag: "ev-" + e.id, vista: "calendario",
      testo: "«" + e.t + "» oggi" + quando + ".",
    });
  });

  /* ---- riepilogo della domenica sera ---- */
  const dom = lunedi(ora) + 6 * GIORNO;
  const domSera = daIso(iso(dom), 20, 0);
  NOMI.filter(inCasa).forEach((n) => {
    const mie = (S.missioni || []).filter((m: any) => m.chi === n && !m.fatta && !bloccato(m.liv, w));
    if (!mie.length) return;
    const tot = mie.reduce((a: number, m: any) => a + quotaDi(m), 0);
    add({
      k: "dom:" + w + ":" + n, quando: domSera, a: n, finestra: 3 * 36e5,
      titolo: "Ultima chiamata", tag: "riepilogo", vista: "missioni",
      testo: mie.length === 1
        ? "Ti resta una missione aperta. Se la lasci lì, stanotte " + eur(tot) + " vanno in cassa."
        : "Ti restano " + mie.length + " missioni aperte: " + eur(tot) + " che stanotte finiscono in cassa.",
    });
  });

  /* ---- lunedì mattina ---- */
  const lun = lunedi(ora);
  add({
    k: "lun:" + settIdx(ora), quando: daIso(iso(lun), 8, 0), a: "tutti", escludi: viaOra,
    finestra: 5 * 36e5,
    titolo: "Settimana nuova", tag: "settimana", vista: "missioni",
    testo: "La ruota ha girato. Apri l'app e scopri cosa ti è toccato.",
  });

  /* ---- chi è via: un promemoria a chi resta, il lunedì ---- */
  if (viaOra.length) {
    add({
      k: "via:" + settIdx(ora), quando: daIso(iso(lun), 8, 5), a: "tutti", escludi: viaOra,
      finestra: 5 * 36e5,
      titolo: "Questa settimana manca qualcuno", tag: "settimana", vista: "servizi",
      testo: viaOra.join(" e ") + (viaOra.length === 1 ? " è via" : " sono via") +
        ": bidoni e servizi sono già divisi fra chi è in casa.",
    });
  }

  /* ---- quote da versare, il primo del mese ---- */
  const p = pezzi(ora);
  const primo = romaTs(p.y, p.m, 1, 9, 0);
  NOMI.forEach((n) => {
    const d = (S.debiti || {})[n] || 0;
    if (d <= 0) return;
    add({
      k: "deb:" + p.y + "-" + p.m + ":" + n, quando: primo, a: n, finestra: 8 * 36e5,
      titolo: "Quote da versare", tag: "cassa", vista: "tesoretto",
      testo: "Hai " + eur(d) + " di quote arretrate da mettere in cassa comune.",
    });
  });

  return out;
}

/* ==================== INVIO ==================== */
async function spedisci(
  casa: string, a: string | string[] | "tutti", payload: any,
  escludi?: string | string[] | null,
) {
  let q = admin.from("push").select("endpoint,chi,sub").eq("casa", casa);
  if (a !== "tutti") q = q.in("chi", Array.isArray(a) ? a : [a]);
  const { data, error } = await q;
  if (error || !data) return 0;
  const fuori = escludi ? (Array.isArray(escludi) ? escludi : [escludi]) : [];
  const righe = fuori.length ? data.filter((r: any) => !fuori.includes(r.chi)) : data;
  const corpo = JSON.stringify(payload);
  let n = 0;
  const morti: string[] = [];
  await Promise.all(righe.map(async (r: any) => {
    try { await webpush.sendNotification(r.sub, corpo, { TTL: 60 * 60 * 12 }); n++; }
    catch (e: any) { const c = e?.statusCode ?? 0; if (c === 404 || c === 410) morti.push(r.endpoint); }
  }));
  if (morti.length) await admin.from("push").delete().in("endpoint", morti);
  return n;
}

/* segna l'avviso come già mandato; torna false se c'era già */
async function primaVolta(casa: string, k: string) {
  const { error } = await admin.from("avvisi").insert({ casa, k });
  if (!error) return true;
  if (error.code === "23505") return false; // duplicato: già mandato
  console.error("avvisi:", error.message);
  return false;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok");
  if (!PUB || !PRIV) return new Response("chiavi VAPID mancanti", { status: 500 });

  const ora = Date.now();
  const { data: case_, error } = await admin.from("stato").select("casa,dati");
  if (error) return new Response(error.message, { status: 500 });

  const esito: any[] = [];
  for (const riga of case_ ?? []) {
    const S = riga.dati;
    if (!S) continue;
    for (const av of daMandare(S, ora)) {
      if (!(await primaVolta(riga.casa, av.k))) continue;
      const n = await spedisci(riga.casa, av.a, {
        titolo: av.titolo, testo: av.testo, tag: av.tag, vista: av.vista,
      }, av.escludi ?? null);
      esito.push({ k: av.k, inviate: n });
    }
  }

  /* pulizia: gli avvisi vecchi di 60 giorni non servono più */
  await admin.from("avvisi").delete().lt("ts", new Date(ora - 60 * GIORNO).toISOString());

  return new Response(JSON.stringify({ ok: true, mandati: esito.length, esito }), {
    headers: { "Content-Type": "application/json" },
  });
});
