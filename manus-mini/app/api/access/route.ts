import { NextResponse } from "next/server";
import { expiredSessionCookie, makeSessionCookie, verifyPassword } from "@/lib/security";

export const runtime = "nodejs";

export async function POST(request: Request) {
  if (process.env.NODE_ENV === "production" && (!process.env.APP_ACCESS_PASSWORD || !process.env.SESSION_SECRET)) {
    return NextResponse.json({ error: "إعدادات حماية النشر ناقصة." }, { status: 503 });
  }
  const body = await request.json().catch(() => null);
  if (!verifyPassword(body?.password)) return NextResponse.json({ error: "كلمة المرور غير صحيحة." }, { status: 401 });
  const response = NextResponse.json({ ok: true });
  response.headers.set("Set-Cookie", makeSessionCookie());
  return response;
}

export async function DELETE() {
  const response = NextResponse.json({ ok: true });
  response.headers.set("Set-Cookie", expiredSessionCookie());
  return response;
}
