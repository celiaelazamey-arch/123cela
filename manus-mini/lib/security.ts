import { createHmac, timingSafeEqual } from "node:crypto";

const COOKIE_NAME = "manus_mini_session";
const SESSION_AGE_SECONDS = 60 * 60 * 24 * 7;

function secret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  return process.env.NODE_ENV === "production" ? "" : process.env.APP_ACCESS_PASSWORD || "";
}

function signature(value: string) {
  return createHmac("sha256", secret()).update(value).digest("hex");
}

export function authRequired() {
  return Boolean(process.env.APP_ACCESS_PASSWORD) || process.env.NODE_ENV === "production";
}

export function isAuthorized(request: Request) {
  if (!authRequired()) return true;
  if (!process.env.APP_ACCESS_PASSWORD || !secret()) return false;

  const cookie = request.headers.get("cookie") || "";
  const value = cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE_NAME}=`))?.slice(COOKIE_NAME.length + 1);
  if (!value) return false;

  const [issued, supplied] = value.split(".");
  const timestamp = Number(issued);
  if (!timestamp || Date.now() - timestamp > SESSION_AGE_SECONDS * 1000 || timestamp > Date.now() + 60_000) return false;

  const expected = signature(`${issued}:manus-mini`);
  const a = Buffer.from(supplied || "");
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function makeSessionCookie() {
  const issued = String(Date.now());
  const value = `${issued}.${signature(`${issued}:manus-mini`)}`;
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${COOKIE_NAME}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_AGE_SECONDS}${secure}`;
}

export function expiredSessionCookie() {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`;
}

export function verifyPassword(candidate: unknown) {
  const expected = process.env.APP_ACCESS_PASSWORD || "";
  if (!expected || typeof candidate !== "string") return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
