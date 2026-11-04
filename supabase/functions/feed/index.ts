// =====================================================================
// ARON Signage v2 – Edge Function "feed" (phiên bản 2)
// Đọc dữ liệu ngoài thay cho Tivi:
//   • Lịch Google/Outlook (ICS)  → chỉ trả giờ, tiêu đề, phòng
//   • Google Sheet / CSV / JSON   → KPI, danh sách sinh nhật
//   • RSS tin tức                 → tiêu đề, thời gian, ảnh
//   • Oracle BI Publisher / ORDS / API nội bộ: đăng nhập Basic lưu ở bảng bí mật sig_feed_secrets
// - Tivi chỉ gửi mã nguồn (id); link + tài khoản nằm ở server, Tivi không đọc được
// - Chỉ gọi được các tên miền Google/Microsoft + tên miền Admin cho phép (bảng sig_feed_hosts)
//
// Triển khai: Supabase Dashboard → Edge Functions → (function "feed") → Code → dán file này → Deploy
// (Details → "Verify JWT" phải TẮT)
// =====================================================================
import { createClient } from "npm:@supabase/supabase-js@2";

const BUILTIN = [
  /(^|\.)calendar\.google\.com$/,
  /(^|\.)outlook\.office365\.com$/,
  /(^|\.)outlook\.office\.com$/,
  /(^|\.)outlook\.live\.com$/,
  /^docs\.google\.com$/,
];
const KEEP = new Set(["UID", "DTSTART", "DTEND", "DURATION", "SUMMARY", "LOCATION", "RRULE", "EXDATE", "RECURRENCE-ID", "STATUS"]);
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
};
const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const cache = new Map<string, { t: number; body: string; type: string }>();
let hostCache: { t: number; hosts: string[] } = { t: 0, hosts: [] };

function txt(m: string, status: number) {
  return new Response(m, { status, headers: { ...cors, "content-type": "text/plain; charset=utf-8" } });
}
async function allowedHosts(): Promise<string[]> {
  if (Date.now() - hostCache.t < 5 * 60_000) return hostCache.hosts;
  const { data } = await sb.from("sig_feed_hosts").select("host");
  hostCache = { t: Date.now(), hosts: (data || []).map((r: { host: string }) => String(r.host).toLowerCase()) };
  return hostCache.hosts;
}
async function isAllowed(host: string): Promise<boolean> {
  host = host.toLowerCase();
  if (BUILTIN.some((r) => r.test(host))) return true;
  return (await allowedHosts()).some((h) => host === h || host.endsWith("." + h));
}
function isPrivateHost(host: string): boolean {
  return /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[?::1\]?$)/i.test(host);
}

function slimIcs(raw: string): string {
  const lines = raw.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
  const out: string[] = [], stack: string[] = [];
  for (const l of lines) {
    const up = l.toUpperCase();
    if (up.startsWith("BEGIN:")) { const b = up.slice(6).trim(); stack.push(b); if (b === "VEVENT" || b === "VCALENDAR") out.push(`BEGIN:${b}`); continue; }
    if (up.startsWith("END:")) { const b = stack.pop(); if (b === "VEVENT" || b === "VCALENDAR") out.push(`END:${b}`); continue; }
    if (stack[stack.length - 1] === "VEVENT") { const name = up.split(/[;:]/, 1)[0]; if (KEEP.has(name)) out.push(l); }
  }
  return out.join("\r\n");
}

// RSS/Atom → JSON gọn: [{t: tiêu đề, d: thời gian, img: ảnh}]
function decode(s: string) {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
}
function slimRss(raw: string): string {
  const items: { t: string; d: string; img: string }[] = [];
  const blocks = raw.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi) || [];
  for (const b of blocks.slice(0, 20)) {
    const tag = (n: string) => { const m = b.match(new RegExp(`<${n}[^>]*>([\\s\\S]*?)</${n}>`, "i")); return m ? decode(m[1]).trim() : ""; };
    const t = tag("title").replace(/<[^>]+>/g, "").trim();
    if (!t) continue;
    const d = tag("pubDate") || tag("updated") || tag("published");
    let img = "";
    const enc = b.match(/<(?:enclosure|media:content|media:thumbnail)[^>]+url="([^"]+)"/i);
    if (enc) img = enc[1];
    if (!img) { const m = decode(tag("description") || tag("content") || tag("summary")).match(/<img[^>]+src="([^"]+)"/i); if (m) img = m[1]; }
    if (!/^https:\/\//i.test(img)) img = "";
    items.push({ t: t.slice(0, 200), d, img });
  }
  return JSON.stringify(items);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "GET") return txt("Method not allowed", 405);

  const id = new URL(req.url).searchParams.get("id") || "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return txt("id không hợp lệ", 400);

  const hit = cache.get(id);
  if (hit && Date.now() - hit.t < 5 * 60_000) {
    return new Response(hit.body, { headers: { ...cors, "content-type": hit.type, "cache-control": "public, max-age=300" } });
  }

  const { data, error } = await sb.from("sig_feeds").select("kind,url").eq("id", id).maybeSingle();
  if (error || !data) return txt("Không tìm thấy nguồn dữ liệu", 404);

  let u: URL;
  try { u = new URL(String(data.url).trim().replace(/^webcal:/i, "https:")); } catch { return txt("URL không hợp lệ", 400); }
  if (u.protocol !== "https:" || isPrivateHost(u.hostname)) return txt("Chỉ hỗ trợ link https công khai", 403);
  if (!(await isAllowed(u.hostname))) return txt(`Tên miền ${u.hostname} chưa được Admin cho phép (Cài đặt chung → Nguồn dữ liệu được phép)`, 403);

  const headers: Record<string, string> = { "user-agent": "ARON-Signage-Feed/2", accept: "*/*" };
  const { data: sec } = await sb.from("sig_feed_secrets").select("auth_user,auth_pass").eq("feed_id", id).maybeSingle();
  if (sec && sec.auth_user) headers.authorization = "Basic " + btoa(unescape(encodeURIComponent(`${sec.auth_user}:${sec.auth_pass || ""}`)));

  let r: Response;
  try { r = await fetch(u, { redirect: "follow", headers, signal: AbortSignal.timeout(20_000) }); }
  catch { return txt("Không kết nối được nguồn", 502); }
  if (r.status === 401 || r.status === 403) return txt("Nguồn từ chối truy cập (kiểm tra tài khoản/quyền)", 502);
  if (!r.ok) return txt("Nguồn trả lỗi " + r.status, 502);

  let body = await r.text();
  if (body.length > 5_000_000) return txt("Dữ liệu quá lớn", 413);

  let type = "text/csv; charset=utf-8";
  const ct = (r.headers.get("content-type") || "").toLowerCase();
  if (data.kind === "ics") { body = slimIcs(body); type = "text/calendar; charset=utf-8"; }
  else if (data.kind === "rss") { body = slimRss(body); type = "application/json; charset=utf-8"; }
  else if (ct.includes("json") || /^\s*[\[{]/.test(body)) { type = "application/json; charset=utf-8"; }

  cache.set(id, { t: Date.now(), body, type });
  return new Response(body, { headers: { ...cors, "content-type": type, "cache-control": "public, max-age=300" } });
});
