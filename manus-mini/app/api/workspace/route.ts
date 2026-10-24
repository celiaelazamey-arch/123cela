import { NextResponse } from "next/server";
import { isAuthorized } from "@/lib/security";

export const runtime = "nodejs";

function config() {
  const base = process.env.SUPABASE_URL?.replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) return null;
  return { url: `${base}/rest/v1/manus_workspace_state`, key };
}

function headers(key: string, extra: Record<string, string> = {}) {
  return { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...extra };
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: "سجّل الدخول أولًا." }, { status: 401 });
  const current = config();
  if (!current) return NextResponse.json({ error: "التخزين السحابي غير مفعّل." }, { status: 503 });
  try {
    const response = await fetch(`${current.url}?id=eq.primary&select=data`, { headers: headers(current.key), cache: "no-store" });
    if (!response.ok) return NextResponse.json({ error: "تعذر قراءة مساحة العمل من Supabase." }, { status: 502 });
    const rows = await response.json();
    return NextResponse.json({ data: rows[0]?.data ?? null });
  } catch {
    return NextResponse.json({ error: "تعذر الاتصال بقاعدة البيانات." }, { status: 502 });
  }
}

export async function PUT(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: "سجّل الدخول أولًا." }, { status: 401 });
  const current = config();
  if (!current) return NextResponse.json({ error: "التخزين السحابي غير مفعّل." }, { status: 503 });
  const data = await request.json().catch(() => null);
  if (!data || !Array.isArray(data.projects) || data.projects.length > 100 || !Array.isArray(data.activity)) {
    return NextResponse.json({ error: "بيانات مساحة العمل غير صالحة." }, { status: 400 });
  }
  if (JSON.stringify(data).length > 2_000_000) return NextResponse.json({ error: "مساحة العمل أكبر من الحد المسموح." }, { status: 413 });
  try {
    const response = await fetch(`${current.url}?on_conflict=id`, {
      method: "POST",
      headers: headers(current.key, { Prefer: "resolution=merge-duplicates,return=minimal" }),
      body: JSON.stringify({ id: "primary", data, updated_at: new Date().toISOString() }),
    });
    if (!response.ok) return NextResponse.json({ error: "تعذر حفظ مساحة العمل. تحقق من إعداد جدول Supabase." }, { status: 502 });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "تعذر الاتصال بقاعدة البيانات." }, { status: 502 });
  }
}
