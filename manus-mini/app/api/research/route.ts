import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { readPublicPage, searchPublicWeb, type ResearchSource } from "@/lib/research";
import { isRateLimited } from "@/lib/rate-limit";
import { isAuthorized } from "@/lib/security";

export const runtime = "nodejs";
export const maxDuration = 60;

const PLAN_TTL = 10 * 60 * 1000;
const encoder = new TextEncoder();

type Candidate = { title: string; url: string; snippet: string };
type SignedPlan = { queryHash: string; candidates: Candidate[]; expiresAt: number };

function signingSecret() {
  return process.env.SESSION_SECRET || process.env.APP_ACCESS_PASSWORD || "manus-mini-local-research-plan";
}

function sign(value: string) {
  return createHmac("sha256", signingSecret()).update(value).digest("base64url");
}

function makeToken(plan: SignedPlan) {
  const payload = Buffer.from(JSON.stringify(plan)).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

function readToken(token: unknown): SignedPlan | null {
  if (typeof token !== "string" || token.length > 16_000) return null;
  const [payload, supplied, ...rest] = token.split(".");
  if (!payload || !supplied || rest.length) return null;
  const expected = Buffer.from(sign(payload));
  const actual = Buffer.from(supplied);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const plan = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as SignedPlan;
    if (typeof plan.queryHash !== "string" || !/^[\da-f]{64}$/.test(plan.queryHash) || typeof plan.expiresAt !== "number" || plan.expiresAt < Date.now() || plan.expiresAt > Date.now() + PLAN_TTL + 5_000 || !Array.isArray(plan.candidates) || plan.candidates.length > 3) return null;
    const candidates = plan.candidates.filter((item) => item && typeof item.title === "string" && typeof item.url === "string" && typeof item.snippet === "string");
    return { ...plan, candidates };
  } catch {
    return null;
  }
}

function event(controller: ReadableStreamDefaultController<Uint8Array>, name: string, data: unknown) {
  try {
    controller.enqueue(encoder.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`));
    return true;
  } catch {
    return false;
  }
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: "سجّل الدخول أولًا." }, { status: 401 });
  if (isRateLimited(request)) return NextResponse.json({ error: "طلبات كثيرة خلال دقيقة واحدة. انتظر قليلًا ثم حاول." }, { status: 429 });

  const body = await request.json().catch(() => null);
  if (body?.action === "plan") {
    const query = typeof body.query === "string" ? body.query.trim() : "";
    if (!query || query.length > 10_000) return NextResponse.json({ error: "اكتب طلب بحث لا يتجاوز 10000 حرف." }, { status: 400 });
    try {
      const candidates = await searchPublicWeb(query, request.signal);
      const plan: SignedPlan = { queryHash: createHash("sha256").update(query).digest("hex"), candidates: candidates.slice(0, 3), expiresAt: Date.now() + PLAN_TTL };
      return NextResponse.json({
        token: makeToken(plan),
        query,
        steps: [
          "البحث في الويب العام عن صفحات مرتبطة بطلبك.",
          "قراءة ما يصل إلى 3 صفحات آمنة من النتائج المتاحة.",
          "تلخيص ما تدعمه الصفحات وإرفاق روابطها، مع تمييز ما لم يتأكد.",
        ],
        candidates: plan.candidates.slice(0, 3),
      });
    } catch {
      return NextResponse.json({ error: "تعذر إعداد خطة البحث الآن. حاول مرة أخرى." }, { status: 502 });
    }
  }

  if (body?.action !== "execute") return NextResponse.json({ error: "نوع طلب غير معروف." }, { status: 400 });
  const plan = readToken(body.token);
  const query = typeof body.query === "string" ? body.query.trim() : "";
  const suppliedHash = createHash("sha256").update(query).digest("hex");
  if (!plan || !query || query.length > 10_000 || !timingSafeEqual(Buffer.from(suppliedHash), Buffer.from(plan.queryHash))) {
    return NextResponse.json({ error: "انتهت صلاحية خطة البحث أو لم تعد صالحة. أعد إعداد الخطة." }, { status: 400 });
  }

  const abort = new AbortController();
  if (request.signal.aborted) abort.abort();
  else request.signal.addEventListener("abort", () => abort.abort(), { once: true });
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const sources: ResearchSource[] = [];
      try {
        const candidates = plan.candidates;
        for (let index = 0; index < candidates.length; index += 1) {
          if (abort.signal.aborted) break;
          const candidate = candidates[index];
          event(controller, "progress", { message: `قراءة المصدر ${index + 1} من ${candidates.length}: ${candidate.title}` });
          try {
            const source = await readPublicPage(candidate.url, abort.signal);
            sources.push({ ...source, snippet: candidate.snippet });
            event(controller, "progress", { message: `تمت قراءة ${sources.length} مصدر${sources.length === 1 ? "" : "ين"}.` });
          } catch {
            event(controller, "progress", { message: `تعذرت قراءة المصدر ${index + 1}؛ سأتابع إلى النتيجة التالية.` });
          }
        }
        if (abort.signal.aborted) return;
        if (!sources.length) event(controller, "error", { error: "لم أتمكن من قراءة صفحات عامة من هذه النتائج. يمكنك مراجعة الروابط أو إعداد بحث جديد." });
        else event(controller, "sources", { sources });
      } catch {
        if (!abort.signal.aborted) event(controller, "error", { error: "تعذر إكمال قراءة المصادر." });
      } finally {
        if (!abort.signal.aborted) {
          event(controller, "done", {});
          try { controller.close(); } catch {}
        }
      }
    },
    cancel() { abort.abort(); },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" },
  });
}
