const requests = new Map<string, { count: number; resetAt: number }>();
const MAX_TRACKED_ADDRESSES = 2_048;

export function isRateLimited(request: Request, bucket = "api") {
  const address = request.headers.get("cf-connecting-ip")?.trim() || request.headers.get("x-real-ip")?.trim() || "shared";
  const now = Date.now();
  const configured = Number(process.env[bucket === "api" ? "CHAT_RATE_LIMIT" : `${bucket.toUpperCase()}_RATE_LIMIT`]);
  const max = Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : bucket === "login" ? 5 : 12;
  const key = `${bucket}:${address}`;
  const current = requests.get(key);
  if (!current || current.resetAt <= now) {
    if (requests.size >= MAX_TRACKED_ADDRESSES) {
      for (const [oldKey, entry] of requests) if (entry.resetAt <= now) requests.delete(oldKey);
      if (requests.size >= MAX_TRACKED_ADDRESSES) return true;
    }
    requests.set(key, { count: 1, resetAt: now + 60_000 });
    return false;
  }
  current.count += 1;
  return current.count > max;
}
