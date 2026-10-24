import { NextResponse } from "next/server";
import { isRateLimited } from "@/lib/rate-limit";
import { isAuthorized } from "@/lib/security";

export const runtime = "nodejs";

function text(value: string) {
  return value.replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: "سجّل الدخول أولًا." }, { status: 401 });
  if (isRateLimited(request)) return NextResponse.json({ error: "طلبات كثيرة. انتظر قليلًا ثم حاول." }, { status: 429 });
  const body = await request.json().catch(() => null);
  const query = typeof body?.query === "string" ? body.query.trim().slice(0, 300) : "";
  if (!query) return NextResponse.json({ results: [] });

  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 ManusMini/1.0", Accept: "text/html" }, signal: AbortSignal.timeout(12000) });
    if (!response.ok) return NextResponse.json({ error: "تعذر الوصول إلى خدمة البحث الآن.", results: [] }, { status: 502 });
    const html = await response.text();
    const results = [...html.matchAll(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)].slice(0, 6).map((match) => {
      let target = match[1].replace(/&amp;/g, "&");
      try {
        const parsed = new URL(target, "https://duckduckgo.com");
        target = parsed.searchParams.get("uddg") || target;
      } catch {}
      const after = html.slice(match.index! + match[0].length, match.index! + match[0].length + 1200);
      const snippet = after.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/)?.[1] || after.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/td>/)?.[1] || "";
      return { title: text(match[2]), url: target, snippet: text(snippet) };
    }).filter((item) => item.title && /^https?:\/\//.test(item.url));
    return NextResponse.json({ results });
  } catch {
    return NextResponse.json({ error: "تعذر إكمال البحث. يمكنك المحاولة لاحقًا.", results: [] }, { status: 502 });
  }
}
