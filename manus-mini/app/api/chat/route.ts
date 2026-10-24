import { NextResponse } from "next/server";
import { createTextStream, ProviderError } from "@/lib/ai";
import { isRateLimited } from "@/lib/rate-limit";
import { isAuthorized } from "@/lib/security";

export const runtime = "nodejs";
export const maxDuration = 60;

const SYSTEM = `أنت Manus Mini، مساعد عربي يشرح خطوات العمل بدقة. لا تدّع أنك نفذت بحثًا أو فتحت موقعًا أو أنشأت ملفًا ما لم يحدث ذلك فعلًا عبر أدوات موصولة. لا تنفذ أوامر النظام أو الحذف أو الإرسال أو الشراء أو النشر. اقترح خطة، واطلب موافقة صريحة قبل أي أثر خارجي. عند توفر نتائج بحث مرفقة، استشهد بروابطها ولا تختلق مصادر.`;

export async function POST(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: "سجّل الدخول أولًا." }, { status: 401 });
  if (isRateLimited(request)) return NextResponse.json({ error: "طلبات كثيرة خلال دقيقة واحدة. انتظر قليلًا ثم حاول." }, { status: 429 });

  const body = await request.json().catch(() => null);
  const message = typeof body?.message === "string" ? body.message.trim() : "";
  if (!message || message.length > 10000) return NextResponse.json({ error: "اكتب رسالة لا تتجاوز 10000 حرف." }, { status: 400 });

  const memory = typeof body?.memory === "string" ? body.memory.slice(0, 6000) : "";
  const history = Array.isArray(body?.history) ? body.history.slice(-16).map((item: { role?: unknown; content?: unknown }) => {
    if ((item?.role !== "user" && item?.role !== "assistant") || typeof item.content !== "string") return "";
    return `${item.role === "user" ? "المستخدم" : "المساعد"}: ${item.content.slice(-4000)}`;
  }).filter(Boolean).join("\n").slice(-30000) : "";
  const sourceItems = Array.isArray(body?.sources) ? body.sources.slice(0, 6) : [];
  const sources = sourceItems.map((item: { title?: unknown; url?: unknown; snippet?: unknown }) => {
    const title = typeof item?.title === "string" ? item.title.slice(0, 250) : "";
    const url = typeof item?.url === "string" && /^https?:\/\//.test(item.url) ? item.url.slice(0, 1000) : "";
    const snippet = typeof item?.snippet === "string" ? item.snippet.slice(0, 700) : "";
    return title && url ? `- ${title}\n  ${url}\n  ${snippet}` : "";
  }).filter(Boolean).join("\n");
  const fileText = typeof body?.fileText === "string" ? body.fileText.slice(0, 40000) : "";
  const prompt = [SYSTEM, memory ? `ذاكرة المشروع:\n${memory}` : "", history ? `سياق المحادثة السابقة:\n${history}` : "", sources ? `نتائج بحث مرفقة (تحقق من الصفحات قبل الجزم):\n${sources}` : "", fileText ? `نص ملف أرفقه المستخدم:\n${fileText}` : "", `طلب المستخدم:\n${message}`].filter(Boolean).join("\n\n");
  const abort = new AbortController();
  request.signal.addEventListener("abort", () => abort.abort(), { once: true });

  let stream: AsyncIterable<string>;
  try {
    stream = await createTextStream(prompt, abort.signal);
  } catch (error) {
    const status = error instanceof ProviderError ? error.status : 502;
    const message = error instanceof ProviderError ? error.message : "تعذر الاتصال بمزود الذكاء الاصطناعي.";
    return NextResponse.json({ error: message }, { status });
  }

  const encoder = new TextEncoder();
  const responseStream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const text of stream) {
          if (abort.signal.aborted) break;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text })}\n\n`));
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      } catch {
        controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ error: "انقطع الاتصال قبل اكتمال الرد." })}\n\n`));
      } finally {
        controller.close();
      }
    },
    cancel() { abort.abort(); },
  });

  return new Response(responseStream, {
    headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" },
  });
}
