import { NextResponse } from "next/server";
import { authRequired, isAuthorized } from "@/lib/security";
import { providerConfig } from "@/lib/ai";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const config = providerConfig();
  return NextResponse.json({
    provider: config.provider,
    model: config.model,
    configured: config.ready,
    databaseEnabled: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY),
    authRequired: authRequired(),
    authorized: isAuthorized(request),
    setupRequired: process.env.NODE_ENV === "production" && (!process.env.APP_ACCESS_PASSWORD || !process.env.SESSION_SECRET),
  });
}
