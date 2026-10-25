import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpsRequest } from "node:https";

export type ResearchSource = {
  title: string;
  url: string;
  snippet: string;
  accessedAt: string;
  excerpt: string;
};

type SearchResult = Pick<ResearchSource, "title" | "url" | "snippet">;

function decodeEntities(value: string) {
  const named: Record<string, string> = {
    amp: "&",
    quot: '"',
    apos: "'",
    lt: "<",
    gt: ">",
    nbsp: " ",
    "#39": "'",
  };
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
    if (code[0] === "#") {
      const hex = code[1]?.toLowerCase() === "x";
      const point = Number.parseInt(code.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(point) && point > 0 && point <= 0x10ffff
        ? String.fromCodePoint(point)
        : entity;
    }
    return named[code.toLowerCase()] || entity;
  });
}

function plainText(html: string) {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style|noscript|svg|template|iframe)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
      .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/article|\/section)\b[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[\t\r\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function publicHttpsUrl(value: string): URL | null {
  if (value.length > 2_048) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      (url.port && url.port !== "443") ||
      !host.includes(".") ||
      host.length > 253 ||
      host === "localhost" ||
      /\.(localhost|local|internal|test|invalid|onion|home|lan|corp)$/i.test(host) ||
      /\.(nip\.io|sslip\.io|xip\.io|localtest\.me|lvh\.me|vcap\.me)$/i.test(host) ||
      isIP(host) !== 0 ||
      host.includes(":")
    ) return null;
    url.hash = "";
    return url;
  } catch {
    return null;
  }
}

function publicIpv4(value: string) {
  const parts = value.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return false;
  const [a, b, c] = parts.map(Number);
  return !(
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)
  );
}

function publicIpv6(value: string) {
  const halves = value.toLowerCase().split("::");
  if (halves.length > 2 || value.includes("%")) return false;
  const parse = (part: string) => {
    if (!part) return [] as number[];
    const groups = part.split(":");
    const result: number[] = [];
    for (let index = 0; index < groups.length; index += 1) {
      const group = groups[index];
      if (group.includes(".")) {
        if (index !== groups.length - 1 || !publicIpv4(group)) return null;
        const octets = group.split(".").map(Number);
        result.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
      } else if (/^[\da-f]{1,4}$/.test(group)) {
        result.push(Number.parseInt(group, 16));
      } else {
        return null;
      }
    }
    return result;
  };
  const left = parse(halves[0]);
  const right = halves.length === 2 ? parse(halves[1]) : [];
  if (!left || !right) return false;
  const groups = halves.length === 1
    ? left
    : [...left, ...Array(8 - left.length - right.length).fill(0), ...right];
  if (groups.length !== 8 || groups[0] < 0x2000 || groups[0] > 0x3fff) return false;
  if (groups[0] === 0x2001 && (groups[1] <= 0x01ff || groups[1] === 0x0db8)) return false;
  return groups[0] !== 0x2002 && groups[0] !== 0x3fff;
}

function publicAddress(address: string) {
  const family = isIP(address);
  return family === 4 ? publicIpv4(address) : family === 6 ? publicIpv6(address) : false;
}

async function limitedText(response: Response, limit: number, signal: AbortSignal) {
  if (!response.body) throw new Error("search_body_missing");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      if (signal.aborted) throw new Error("aborted");
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new Error("search_response_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const data = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(data);
}

export async function searchPublicWeb(query: string, signal: AbortSignal): Promise<SearchResult[]> {
  const response = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query.slice(0, 300))}`, {
    headers: { "User-Agent": "Mozilla/5.0 ManusMini/1.0", Accept: "text/html" },
    redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]),
  });
  if (!response.ok) throw new Error("search_unavailable");
  const html = await limitedText(response, 1_500_000, signal);
  return [...html.matchAll(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)]
    .slice(0, 8)
    .map((match) => {
      let target = match[1].replace(/&amp;/g, "&");
      try {
        const parsed = new URL(target, "https://duckduckgo.com");
        if (parsed.hostname === "duckduckgo.com" || parsed.hostname.endsWith(".duckduckgo.com")) {
          target = parsed.pathname === "/l/" ? parsed.searchParams.get("uddg") || "" : "";
        } else {
          target = parsed.href;
        }
      } catch {
        target = "";
      }
      const after = html.slice(match.index! + match[0].length, match.index! + match[0].length + 1_200);
      const snippet = after.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|td)>/)?.[1] || "";
      const safeUrl = publicHttpsUrl(target);
      return {
        title: plainText(match[2]).slice(0, 250),
        url: safeUrl?.href || "",
        snippet: plainText(snippet).slice(0, 700),
      };
    })
    .filter((result) => result.title && result.url);
}

function pinnedGet(url: URL, address: string, signal: AbortSignal) {
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let bytes = 0;
    const chunks: Buffer[] = [];
    const finish = (error?: Error, value?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(value || "");
    };
    const abort = () => request.destroy(new Error("aborted"));
    const deadline = setTimeout(() => request.destroy(new Error("page_timeout")), 10_000);
    const request = httpsRequest({
      hostname: address,
      family: isIP(address),
      port: 443,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      servername: url.hostname,
      rejectUnauthorized: true,
      agent: false,
      headers: {
        Host: url.host,
        Accept: "text/html,application/xhtml+xml;q=0.9",
        "Accept-Encoding": "identity",
        "User-Agent": "Mozilla/5.0 ManusMini/1.0",
        Connection: "close",
      },
    }, (response) => {
      const contentType = response.headers["content-type"] || "";
      const declaredSize = Number(response.headers["content-length"] || 0);
      if (response.statusCode !== 200 || !/^(text\/html|application\/xhtml\+xml)\b/i.test(contentType) || declaredSize > 1_000_000) {
        response.resume();
        finish(new Error("page_not_readable"));
        return;
      }
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 1_000_000) {
          request.destroy(new Error("page_too_large"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => finish(undefined, Buffer.concat(chunks).toString("utf8")));
      response.on("error", (error) => finish(error));
    });
    request.on("error", (error) => finish(error));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    request.end();
  });
}

export async function readPublicPage(rawUrl: string, signal: AbortSignal): Promise<ResearchSource> {
  const url = publicHttpsUrl(rawUrl);
  if (!url) throw new Error("unsafe_url");
  let dnsTimer: ReturnType<typeof setTimeout>;
  const addresses = await Promise.race([
    lookup(url.hostname, { all: true, verbatim: true }),
    new Promise<never>((_, reject) => {
      dnsTimer = setTimeout(() => reject(new Error("dns_timeout")), 5_000);
    }),
  ]).finally(() => clearTimeout(dnsTimer));
  if (!addresses.length || addresses.some((record) => !publicAddress(record.address))) {
    throw new Error("unsafe_address");
  }
  const html = await pinnedGet(url, addresses[0].address, signal);
  const title = plainText(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").slice(0, 250);
  const text = plainText(html.replace(/<head\b[^>]*>[\s\S]*?<\/head\s*>/i, " ")).slice(0, 6_000);
  if (!text) throw new Error("page_empty");
  return {
    title: title || url.hostname,
    url: url.href,
    snippet: "",
    accessedAt: new Date().toISOString(),
    excerpt: text,
  };
}
