// Viki Gratis: the free (no paywall, no sign-in) part of Viki's catalogue in Kino.
//
// Catalogue: Viki's public JSON API (api.viki.io/v4), plain requests with Viki's public web
// app id, no session. Playback: the public watch page's player data (see playbackOf); Viki
// streams are DASH protected with Widevine, so the stream goes back with a `drm` block.

const API = "https://api.viki.io/v4";
const WEB = "https://www.viki.com";
const APP = "100000a";
const PER_PAGE = 30;
const EPISODES_PER_PAGE = 50;
const MAX_EPISODE_PAGES = 20;
const ID_RE = /^[0-9]{1,12}[a-z]{1,2}$/;

// The base filters every list uses: licensed, and nothing behind Viki Pass.
const FREE = "has_paywall_content=false&licensed=true";

const LISTS = {
  popular: { title: "Populares en Viki", query: "sort=views_recent", genre: "series" },
  series: { title: "Series populares", query: "type=series&sort=views_recent", genre: "series" },
  films: { title: "Películas", query: "type=film&sort=views_recent", genre: "peliculas" },
  new: { title: "Recién llegados", query: "sort=newest_video", genre: "series" },
  top: { title: "Mejor valorados", query: "sort=average_rating", genre: "series" },
};

const COUNTRIES = {
  kr: "Dramas coreanos",
  cn: "Dramas chinos",
  jp: "Dramas japoneses",
  tw: "Dramas taiwaneses",
  th: "Dramas tailandeses",
};

// Viki's genres (api.viki.io/v4/genres.json), Spanish names as Viki writes them.
const GENRES = [
  ["18g", "Comedia romántica"], ["1068g", "Romance"], ["9g", "Drama"], ["6g", "Comedia"],
  ["19g", "Fantasía"], ["1g", "Acción"], ["7g", "Crimen y misterio"], ["26g", "Thriller y suspenso"],
  ["25g", "Dramas de época"], ["1037g", "Histórico"], ["12g", "Sobrenatural"], ["1041g", "Melodrama"],
  ["1040g", "Dramas médicos"], ["1038g", "Drama con ídolos"], ["1045g", "Dramas de la red"],
  ["1044g", "Programas de variedades"], ["1067g", "BL"], ["1071g", "GL"], ["1063g", "Horror"],
  ["1064g", "Ciencia ficción"], ["2g", "Animación"], ["24g", "Familia y niños"], ["8g", "Documental"],
  ["17g", "Música"],
];

const SECTION_TABS = [
  { id: "inicio", label: "Inicio" },
  { id: "series", label: "Series" },
  { id: "peliculas", label: "Películas" },
  { id: "paises", label: "Por país" },
];

// ---- HTTP -------------------------------------------------------------------------------

async function api(path) {
  const sep = path.includes("?") ? "&" : "?";
  const r = await kino.fetch(`${API}${path}${sep}app=${APP}`, {
    // Viki trims `titles` and `descriptions` to the languages asked here.
    headers: { Accept: "application/json", "Accept-Language": "es, en;q=0.8" },
    timeoutMs: 15000,
  });
  if (r.status === 404) throw kino.error("not_found", `viki ${r.status}`);
  if (r.status === 429) throw kino.error("rate_limited", "viki 429");
  if (!r.ok) throw kino.error("unavailable", `viki ${r.status}`);
  return r.json();
}

// ---- Mapping ----------------------------------------------------------------------------

function pick(map) {
  if (!map || typeof map !== "object") return "";
  return map.es || map.en || Object.values(map).find((v) => typeof v === "string" && v) || "";
}

function sized(url, size) {
  if (typeof url !== "string" || !/^https:\/\//.test(url)) return undefined;
  const base = url.replace(/[?&]a=0x0/, "");
  return base + (base.includes("?") ? "&" : "?") + "s=" + size;
}

function posterOf(images) {
  if (!images) return undefined;
  const portrait = images.thumbnails?.["2x3"]?.url || images.billboards?.["2x3"]?.[0]?.url;
  return sized(portrait || images.poster?.url, portrait ? "400x600" : "640x360");
}

function backdropOf(images) {
  if (!images) return undefined;
  const wide = images.atv_cover?.url || images.billboards?.["16x9"]?.[0]?.url || images.poster?.url;
  return sized(wide, "1280x720");
}

function yearOf(c) {
  const d = c.distributors?.[0]?.from || c.created_at;
  const m = typeof d === "string" && d.match(/^(\d{4})/);
  return m ? m[1] : undefined;
}

function isFree(c) {
  return !c.blocking?.paywall && !c.blocking?.geo && !c.paywallable?.svod && !c.paywallable?.tvod;
}

function itemOf(c) {
  if (!c || !ID_RE.test(String(c.id))) return null;
  const kind = c.type === "film" ? "movie" : c.type === "series" ? "series" : null;
  if (!kind) return null;
  const item = {
    id: String(c.id),
    ref: String(c.id),
    title: pick(c.titles) || "Sin título",
    kind,
    poster: posterOf(c.images),
    backdrop: backdropOf(c.images),
  };
  const overview = pick(c.descriptions);
  if (overview) item.overview = overview.slice(0, 1000);
  const year = yearOf(c);
  if (year) item.year = year;
  const rating = c.review_stats?.average_rating;
  if (typeof rating === "number" && rating > 0) item.rating = Math.round(rating * 10) / 10;
  if (c.origin?.language) item.lang = c.origin.language;
  const genres = (c.genres || []).map((g) => GENRES.find(([id]) => id === g)?.[1]).filter(Boolean);
  if (genres.length) item.genres = genres.slice(0, 5);
  if (kind === "movie" && c.watch_now?.duration) item.runtimeMinutes = Math.round(c.watch_now.duration / 60);
  return item;
}

// A search hit is a short form: t = type, i = image, te/tt = Spanish/English title.
function itemOfHit(h) {
  if (!h || !ID_RE.test(String(h.id)) || h.blocking?.paywall || h.paywallable?.svod) return null;
  const kind = h.t === "film" ? "movie" : h.t === "series" ? "series" : null;
  if (!kind) return null;
  return {
    id: String(h.id),
    ref: String(h.id),
    title: h.te || h.tt || "Sin título",
    kind,
    poster: sized(h.i, "640x360"),
  };
}

// ---- Lists ------------------------------------------------------------------------------

// A browse ref names one list: "l:<list>", "g:<genre id>" or "c:<country>".
function queryOf(ref) {
  const [kind, key] = String(ref || "").split(":");
  if (kind === "l" && LISTS[key]) return LISTS[key].query;
  if (kind === "g" && GENRES.some(([id]) => id === key)) return `genre=${key}&sort=views_recent`;
  if (kind === "c" && COUNTRIES[key]) return `origin_country=${key}&sort=views_recent`;
  return null;
}

async function list(ref, page, perPage = PER_PAGE) {
  const query = queryOf(ref);
  if (!query) throw kino.error("not_found", "unknown list");
  const data = await api(`/containers.json?${query}&${FREE}&page=${page}&per_page=${perPage}`);
  const items = (data.response || []).filter(isFree).map(itemOf).filter(Boolean);
  return { items, more: data.more === true };
}

async function row(id, title, ref, genre) {
  try {
    const { items } = await list(ref, 1);
    return items.length ? { id, title, ref, items, genre } : null;
  } catch (e) {
    kino.log("row failed", id, String(e && e.message));
    return null;
  }
}

async function rows(specs) {
  const out = await Promise.all(specs.map((s) => row(...s)));
  return out.filter(Boolean);
}

// ---- Contract ---------------------------------------------------------------------------

export async function home() {
  return rows([
    ["viki_popular", LISTS.popular.title, "l:popular", "series"],
    ["viki_new", LISTS.new.title, "l:new", "series"],
    ["viki_films", LISTS.films.title, "l:films", "peliculas"],
    ["viki_kr", COUNTRIES.kr, "c:kr", "series"],
    ["viki_cn", COUNTRIES.cn, "c:cn", "series"],
    ["viki_romcom", "Comedia romántica", "g:18g", "series"],
  ]);
}

export async function section({ tab }) {
  const chosen = SECTION_TABS.some((t) => t.id === tab) ? tab : "inicio";
  let specs;
  if (chosen === "series") {
    specs = [
      ["s_series", LISTS.series.title, "l:series", "series"],
      ["s_top", LISTS.top.title, "l:top", "series"],
      ["s_period", "Dramas de época", "g:25g", "series"],
      ["s_fantasy", "Fantasía", "g:19g", "series"],
      ["s_thriller", "Thriller y suspenso", "g:26g", "series"],
      ["s_variety", "Programas de variedades", "g:1044g", "entretenimiento"],
    ];
  } else if (chosen === "peliculas") {
    specs = [["s_films", LISTS.films.title, "l:films", "peliculas"]];
  } else if (chosen === "paises") {
    specs = Object.entries(COUNTRIES).map(([code, title]) => [`s_${code}`, title, `c:${code}`, "series"]);
  } else {
    specs = [
      ["s_popular", LISTS.popular.title, "l:popular", "series"],
      ["s_new", LISTS.new.title, "l:new", "series"],
      ["s_romcom", "Comedia romántica", "g:18g", "series"],
      ["s_romance", "Romance", "g:1068g", "series"],
    ];
  }
  return {
    tabs: SECTION_TABS,
    tab: chosen,
    hero: { title: "Viki Gratis", text: "Dramas y películas asiáticas con subtítulos, sin iniciar sesión." },
    rows: await rows(specs),
  };
}

export async function categories() {
  return GENRES.map(([id, title]) => ({ id: `g_${id}`, title, ref: `g:${id}` }));
}

export async function browse(ref, cursor) {
  const page = Math.max(1, parseInt(cursor || "1", 10) || 1);
  const { items, more } = await list(ref, page);
  return more ? { items, next: String(page + 1) } : { items };
}

export async function search(query) {
  const q = String(query?.q || "").trim();
  if (!q) return [];
  const titles = [q, query.originalTitle, ...(query.altTitles || []).slice(0, 2)]
    .map((t) => kino.rank.shortQuery(String(t || "")))
    .filter((t, i, all) => t && all.indexOf(t) === i)
    .slice(0, 3);
  const pages = await Promise.all(
    titles.map((t) => api(`/search.json?c=${encodeURIComponent(t)}&per_page=50`).catch(() => [])),
  );
  const seen = new Set();
  const items = [];
  for (const hits of pages) {
    for (const h of Array.isArray(hits) ? hits : []) {
      const item = itemOfHit(h);
      if (item && !seen.has(item.id)) {
        seen.add(item.id);
        items.push(item);
      }
    }
  }
  const ranked = kino.rank.sortBySimilarity(items, titles);
  return kino.rank.filterRelevant(ranked, titles);
}

async function container(ref) {
  const id = String(ref || "");
  if (!ID_RE.test(id)) throw kino.error("not_found", "bad ref");
  return api(`/containers/${id}.json`);
}

function infoOf(c) {
  const item = itemOf(c) || {};
  const info = {};
  for (const k of ["title", "poster", "backdrop", "overview", "year", "rating", "genres", "runtimeMinutes"]) {
    if (item[k] !== undefined) info[k] = item[k];
  }
  return info;
}

export async function details(ref) {
  return infoOf(await container(ref));
}

export async function episodes(ref) {
  const c = await container(ref);
  const list = [];
  for (let page = 1; page <= MAX_EPISODE_PAGES; page++) {
    const data = await api(
      `/containers/${c.id}/episodes.json?page=${page}&per_page=${EPISODES_PER_PAGE}&direction=asc&sort=number`,
    );
    for (const e of data.response || []) {
      if (!ID_RE.test(String(e.id)) || !(e.number >= 1) || !isFree(e)) continue;
      const ep = { season: 1, number: e.number, ref: String(e.id) };
      const title = pick(e.titles);
      if (title) ep.title = title;
      const still = sized(e.images?.poster?.url, "640x360");
      if (still) ep.still = still;
      if (e.duration) ep.runtimeMinutes = Math.round(e.duration / 60);
      if (typeof e.created_at === "string") ep.airDate = e.created_at.slice(0, 10);
      list.push(ep);
    }
    if (!data.more) break;
  }
  return { series: infoOf(c), episodes: list };
}

// ---- Playback ---------------------------------------------------------------------------

// A movie's ref is its container ("37149c"); an episode's is its video ("1133753v").
async function videoIdOf(ref) {
  const id = String(ref || "");
  if (!ID_RE.test(id)) throw kino.error("not_found", "bad ref");
  if (id.endsWith("v")) return id;
  const c = await container(id);
  const v = c.watch_now?.id;
  if (!v || !ID_RE.test(String(v))) throw kino.error("not_found", "film without video");
  return String(v);
}

// The watch page (www.viki.com/videos/<id>) carries the player's data in __NEXT_DATA__:
// `queue` holds the DASH manifest of the video (after a short "bumper" intro clip we skip),
// `drm` a base64 JSON of signed license URLs (dt1 FairPlay, dt2 PlayReady, dt3 Widevine:
// checked against each server's answer to a Widevine certificate request) and `subtitles` the signed VTT files. A plain read of the public page: no session.
const SUB_LANGS = ["es", "en", "pt"];

function b64json(text) {
  try {
    return JSON.parse(atob(String(text)));
  } catch (e) {
    return null;
  }
}

async function playbackOf(vid) {
  const r = await kino.fetch(`${WEB}/videos/${vid}`, { timeoutMs: 20000 });
  if (r.status === 404) throw kino.error("not_found", "viki page 404");
  if (!r.ok) throw kino.error("unavailable", `viki page ${r.status}`);
  const m = r.text().match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw kino.error("unavailable", "viki page without data");
  const data = JSON.parse(m[1]);
  const pb = data?.props?.pageProps?.videoPlaybackStreamJson;
  if (!pb) throw kino.error("unavailable", "viki page without playback");
  if (pb.error) {
    const why = JSON.stringify(pb.error).slice(0, 150);
    kino.log("playback error", why);
    if (/geo|region|country/i.test(why)) throw kino.error("geo_blocked", why);
    if (/paywall|subscri|pass/i.test(why)) {
      throw kino.error("not_found", why, { userMessage: "Este video es solo para Viki Pass." });
    }
    throw kino.error("unavailable", why);
  }
  return pb;
}

export async function resolve(ref) {
  const vid = await videoIdOf(ref);
  const pb = await playbackOf(vid);
  const main = (pb.queue || []).find((q) => q && q.type === "video" && typeof q.url === "string");
  if (!main) throw kino.error("unavailable", "no video in queue");
  const isDash = main.format === "mpd" || /\.mpd(\?|$)/.test(main.url);
  const licenses = b64json(pb.drm) || {};
  const licenseUrl = isDash ? licenses.dt3 : null;
  if (isDash && !licenseUrl) throw kino.error("unavailable", "no widevine license");

  const subtitles = (pb.subtitles || [])
    .filter((s) => SUB_LANGS.includes(s.srclang) && typeof s.src === "string" && s.percentage >= 50)
    .sort((a, b) => SUB_LANGS.indexOf(a.srclang) - SUB_LANGS.indexOf(b.srclang))
    .map((s) => ({ lang: s.srclang, url: s.src, format: "vtt" }));

  const stream = {
    url: main.url,
    mime: isDash ? "application/dash+xml" : "application/x-mpegURL",
    subtitles,
    expiresInSeconds: 1800,
  };
  if (licenseUrl) stream.drm = { type: "widevine", licenseUrl };
  if (pb.video?.duration) stream.durationMs = pb.video.duration * 1000;
  return stream;
}
