const requests = new Map<string, { count: number; resetAt: number }>();

export function isRateLimited(request: Request) {
  const address = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  const now = Date.now();
  const max = Math.max(1, Number(process.env.CHAT_RATE_LIMIT) || 12);
  const current = requests.get(address);
  if (!current || current.resetAt <= now) {
    requests.set(address, { count: 1, resetAt: now + 60_000 });
    return false;
  }
  current.count += 1;
  return current.count > max;
}
