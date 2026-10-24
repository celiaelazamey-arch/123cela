import { GoogleGenAI } from "@google/genai";

export type Provider = "gemini" | "huggingface" | "nvidia";

export class ProviderError extends Error {
  constructor(message: string, public status = 502) {
    super(message);
  }
}

export function providerConfig() {
  const provider = (process.env.AI_PROVIDER || "gemini").toLowerCase() as Provider;
  if (provider === "huggingface") return { provider, model: process.env.HF_MODEL || "", ready: Boolean(process.env.HF_TOKEN && process.env.HF_MODEL) };
  if (provider === "nvidia") return { provider, model: process.env.NVIDIA_MODEL || "meta/llama-3.3-70b-instruct", ready: Boolean(process.env.NVIDIA_API_KEY) };
  return { provider: "gemini" as const, model: process.env.GEMINI_MODEL || "gemini-3.8-flash", ready: Boolean(process.env.GEMINI_API_KEY) };
}

async function* openAiCompatibleStream(response: Response): AsyncGenerator<string> {
  if (!response.body) throw new ProviderError("لم يبدأ مزود الذكاء الاصطناعي بث الرد.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() || "";
      for (const frame of frames) {
        const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
        if (!data || data === "[DONE]") continue;
        try {
          const chunk = JSON.parse(data);
          const text = chunk.choices?.[0]?.delta?.content;
          if (typeof text === "string") yield text;
        } catch {
          // Ignore keep-alive and non-JSON provider frames.
        }
      }
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
}

export async function createTextStream(prompt: string, signal: AbortSignal): Promise<AsyncIterable<string>> {
  const config = providerConfig();
  if (!config.ready) throw new ProviderError("مفتاح أو إعداد مزود الذكاء الاصطناعي غير موجود في ملف البيئة.", 503);

  if (config.provider === "gemini") {
    const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
    const stream = await client.interactions.create({ model: config.model, input: prompt, stream: true }, { fetch_options: { signal } });
    return (async function* () {
      for await (const event of stream) {
        if (signal.aborted) return;
        if (event.event_type === "step.delta" && event.delta.type === "text") yield event.delta.text;
      }
    })();
  }

  const isHuggingFace = config.provider === "huggingface";
  const endpoint = isHuggingFace
    ? process.env.HF_BASE_URL || "https://router.huggingface.co/v1/chat/completions"
    : process.env.NVIDIA_BASE_URL || "https://integrate.api.nvidia.com/v1/chat/completions";
  const token = isHuggingFace ? process.env.HF_TOKEN! : process.env.NVIDIA_API_KEY!;
  const response = await fetch(endpoint, {
    method: "POST",
    signal,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: config.model, stream: true, messages: [{ role: "user", content: prompt }] }),
  });

  if (!response.ok) {
    const status = response.status === 429 ? 429 : 502;
    throw new ProviderError(status === 429 ? "انتهت الحصة أو وصلت إلى حد الطلبات لهذا المزود." : `تعذر الاتصال بمزود الذكاء الاصطناعي (${response.status}).`, status);
  }
  return openAiCompatibleStream(response);
}
