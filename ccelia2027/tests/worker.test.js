import assert from "node:assert/strict";
import { describe, it } from "node:test";
import productionWorker, { createWorker, DailyBudget } from "../src/index.js";

const secret = "test-only-session-secret-longer-than-32-characters";
const worker = createWorker((binding) => binding.launch());
const goodPlan = JSON.stringify({
  analysis: "قراءة صفحة عامة ثم تلخيص النص المتاح.",
  steps: [
    {
      action: "NAVIGATE",
      target: "صفحة Example العامة",
      value: "https://example.com/",
      reason: "افتح صفحة Example واقرأ محتواها.",
    },
    {
      action: "OBSERVE",
      target: "نص الصفحة",
      value: "",
      reason: "استخرج النص الظاهر للقراءة.",
    },
  ],
});

function createState() {
  const values = new Map();
  return {
    values,
    storage: {
      get: async (key) => values.get(key),
      put: async (key, value) => values.set(key, structuredClone(value)),
    },
    blockConcurrencyWhile: async (callback) => callback(),
  };
}

function createEnvironment({
  plan = goodPlan,
  aiError,
  browserError,
  budgetAllowed = true,
  aiProvider,
  nvidiaApiKey,
  nvidiaModel,
  searchResults = [],
  hangNavigation = false,
} = {}) {
  const state = createState();
  const actor = new DailyBudget(state);
  const calls = {
    ai: 0,
    browser: 0,
    browserClosed: 0,
    contextClosed: 0,
    routeDecisions: [],
    navigations: [],
    modelInputs: [],
  };
  const env = {
    ...(aiProvider ? { AI_PROVIDER: aiProvider } : {}),
    ...(nvidiaApiKey !== undefined ? { NVIDIA_API_KEY: nvidiaApiKey } : {}),
    ...(nvidiaModel ? { NVIDIA_MODEL: nvidiaModel } : {}),
    APP_ACCESS_PASSWORD: "local-test-password",
    SESSION_SECRET: secret,
    AI: {
      async run(_model, input) {
        calls.ai += 1;
        calls.modelInputs.push(input);
        if (aiError) throw aiError;
        return {
          response: input.messages[0].content.includes("planning component")
            ? plan
            : "تم التحقق من نص الصفحة العامة.",
        };
      },
    },
    BROWSER: {
      async launch() {
        calls.browser += 1;
        return {
          async newContext(options) {
            calls.contextOptions = options;
            let routeHandler;
            return {
              async route(pattern, handler) {
                calls.routePattern = pattern;
                routeHandler = handler;
              },
              async newPage() {
                return {
                  setDefaultNavigationTimeout(value) {
                    calls.navigationTimeout = value;
                  },
                  setDefaultTimeout(value) {
                    calls.actionTimeout = value;
                  },
                  async goto(url, options) {
                    calls.navigation = { url, options };
                    calls.navigations.push({ url, options });
                    const requests = [
                      { url, method: "GET", type: "document" },
                      {
                        url: "https://example.com/private",
                        method: "POST",
                        type: "fetch",
                      },
                      {
                        url: "https://tracker.example/pixel",
                        method: "GET",
                        type: "image",
                      },
                      {
                        url: "https://example.com/image.png",
                        method: "GET",
                        type: "image",
                      },
                    ];
                    for (const item of requests) {
                      let decision = "pending";
                      await routeHandler(
                        {
                          continue: async () => {
                            decision = "continue";
                          },
                          abort: async () => {
                            decision = "abort";
                          },
                        },
                        {
                          url: () => item.url,
                          method: () => item.method,
                          resourceType: () => item.type,
                        },
                      );
                      calls.routeDecisions.push({ ...item, decision });
                    }
                    assert.equal(
                      calls.routeDecisions.at(-4).decision,
                      "continue",
                    );
                    if (hangNavigation) {
                      calls.navigationPending = true;
                      await new Promise(() => {});
                    }
                    if (browserError) throw browserError;
                  },
                  async title() {
                    return "Example Domain";
                  },
                  locator(selector) {
                    calls.locator = selector;
                    return {
                      innerText: async () =>
                        "Example Domain\n\nThis domain is for illustrative examples.",
                      evaluateAll: async () => searchResults,
                    };
                  },
                };
              },
              async close() {
                calls.contextClosed += 1;
              },
            };
          },
          async close() {
            calls.browserClosed += 1;
          },
        };
      },
    },
    LOGIN_LIMITER: { limit: async () => ({ success: true }) },
    DAILY_BUDGET: {
      idFromName: () => "global",
      get: () => ({
        fetch: async (input, init) => {
          if (!budgetAllowed) return new Response("blocked", { status: 429 });
          return actor.fetch(new Request(input, init));
        },
      }),
    },
    ASSETS: { fetch: async () => new Response("static app") },
  };
  return { env, calls, actor, state };
}

function post(
  path,
  payload,
  cookie = "",
  origin = "https://agent.test",
  signal,
) {
  const headers = { origin, "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  return new Request(`https://agent.test${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal,
  });
}

async function login(env) {
  const response = await worker.fetch(
    post("/api/login", { password: "local-test-password" }),
    env,
  );
  assert.equal(response.status, 200);
  return response.headers.get("set-cookie").split(";", 1)[0];
}

async function withDnsAnswers(
  addresses,
  callback,
  ipv6Addresses = [],
  hosts = ["example.com"],
) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.origin, "https://cloudflare-dns.com");
    assert.ok(hosts.includes(url.searchParams.get("name")));
    const type = url.searchParams.get("type");
    assert.ok(["A", "AAAA"].includes(type));
    assert.equal(init.redirect, "error");
    if (addresses === null) throw new Error("DNS lookup unavailable");
    const answers = type === "A" ? addresses : ipv6Addresses;
    return new Response(
      JSON.stringify({
        Status: 0,
        Answer: answers.map((data) => ({ type: type === "A" ? 1 : 28, data })),
      }),
      { headers: { "content-type": "application/dns-json" } },
    );
  };
  try {
    return await callback();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function withNvidiaFetch(callback, { content, status = 200 } = {}) {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin === "https://cloudflare-dns.com") {
      const type = url.searchParams.get("type");
      const answers =
        type === "A" ? ["93.184.216.34"] : ["2606:4700:4700::1111"];
      return new Response(
        JSON.stringify({
          Status: 0,
          Answer: answers.map((data) => ({
            type: type === "A" ? 1 : 28,
            data,
          })),
        }),
        { headers: { "content-type": "application/dns-json" } },
      );
    }

    assert.equal(
      url.href,
      "https://integrate.api.nvidia.com/v1/chat/completions",
    );
    calls.push({ url, init, payload: JSON.parse(init.body) });
    const body =
      status === 200
        ? {
            choices: [
              {
                message: { content: content ?? "تم التحقق من الصفحة العامة." },
              },
            ],
          }
        : { error: { message: "rate limit" } };
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    return await callback(calls);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

describe("Cela.sh read-only agent Worker", () => {
  it("keeps health independent of private credentials", async () => {
    const response = await productionWorker.fetch(
      new Request("https://agent.test/health"),
      {},
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      service: "ccelia2027",
      mode: "read-only-agent",
    });
  });

  it("fails closed until application secrets are available", async () => {
    const { env, calls } = createEnvironment();
    delete env.APP_ACCESS_PASSWORD;
    delete env.SESSION_SECRET;

    const loginResponse = await worker.fetch(
      post("/api/login", { password: "not-used" }),
      env,
    );
    const planResponse = await worker.fetch(
      post("/api/plan", { task: "open https://example.com" }),
      env,
    );
    const executeResponse = await worker.fetch(
      post("/api/execute", { planToken: "not-used" }),
      env,
    );

    assert.deepEqual(
      [loginResponse.status, planResponse.status, executeResponse.status],
      [503, 503, 503],
    );
    assert.equal(calls.ai, 0);
    assert.equal(calls.browser, 0);
  });

  it("serves the static UI through the configured assets binding", async () => {
    const { env } = createEnvironment();
    const response = await worker.fetch(
      new Request("https://agent.test/"),
      env,
    );
    assert.equal(await response.text(), "static app");
  });

  it("requires a session before calling the planner", async () => {
    const { env, calls } = createEnvironment();
    const response = await worker.fetch(
      post("/api/plan", { task: "open https://example.com" }),
      env,
    );
    assert.equal(response.status, 401);
    assert.equal(calls.ai, 0);
  });

  it("rejects cross-origin planning requests", async () => {
    const { env, calls } = createEnvironment();
    const cookie = await login(env);
    const response = await worker.fetch(
      post(
        "/api/plan",
        { task: "open https://example.com" },
        cookie,
        "https://attacker.test",
      ),
      env,
    );
    assert.equal(response.status, 403);
    assert.equal(calls.ai, 0);
  });

  it("builds a validated direct-URL read plan without calling Workers AI", async () => {
    const { env, calls, state } = createEnvironment();
    const cookie = await login(env);
    const response = await worker.fetch(
      post(
        "/api/plan",
        { task: "افتح https://example.com واقرأ عنوان الصفحة" },
        cookie,
      ),
      env,
    );
    const value = await response.json();

    assert.equal(response.status, 200);
    assert.equal(value.plan.action, "browse");
    assert.equal(value.plan.url, "https://example.com/");
    assert.equal(value.plan.requiresConfirmation, false);
    assert.deepEqual(
      value.plan.steps.map((step) => step.action),
      ["NAVIGATE", "OBSERVE"],
    );
    assert.equal(value.planner, "خطة رابط مباشرة (دون AI)");
    assert.equal(value.model, undefined);
    assert.ok(value.planToken);
    assert.equal(calls.ai, 0);
    assert.equal((await state.storage.get("daily_usage"))?.aiCalls || 0, 0);
  });

  it("keeps sensitive explicit-URL tasks on the model-backed planner", async () => {
    const { env, calls } = createEnvironment();
    const cookie = await login(env);
    const response = await worker.fetch(
      post(
        "/api/plan",
        { task: "افتح https://example.com ثم احذف البيانات" },
        cookie,
      ),
      env,
    );
    const value = await response.json();

    assert.equal(response.status, 200);
    assert.equal(calls.ai, 1);
    assert.equal(value.model, "@cf/meta/llama-3.2-3b-instruct");
    assert.equal(value.planner, undefined);
    assert.equal(value.plan.requiresConfirmation, true);
  });

  it("does not shortcut negated URL requests", async () => {
    const { env, calls } = createEnvironment();
    const cookie = await login(env);
    const response = await worker.fetch(
      post(
        "/api/plan",
        { task: "Please don’t open https://example.com" },
        cookie,
      ),
      env,
    );
    const value = await response.json();

    assert.equal(response.status, 200);
    assert.equal(calls.ai, 1);
    assert.equal(value.planner, undefined);
    assert.equal(value.model, "@cf/meta/llama-3.2-3b-instruct");
  });

  it("reads up to three explicit public URLs in one Browser Run session", async () => {
    const { env, calls } = createEnvironment();
    const cookie = await login(env);
    const planned = await worker.fetch(
      post(
        "/api/plan",
        {
          task: "اقرأ هذه الصفحات: https://example.com https://example.org https://www.iana.org",
        },
        cookie,
      ),
      env,
    );
    const plan = await planned.json();

    assert.equal(planned.status, 200);
    assert.deepEqual(plan.plan.urls, [
      "https://example.com/",
      "https://example.org/",
      "https://www.iana.org/",
    ]);
    const response = await withDnsAnswers(
      ["93.184.216.34"],
      () =>
        worker.fetch(
          post("/api/execute", { planToken: plan.planToken }, cookie),
          env,
        ),
      ["2606:4700:4700::1111"],
      ["example.com", "example.org", "www.iana.org"],
    );
    const result = await response.json();

    assert.equal(response.status, 200);
    assert.equal(calls.ai, 1);
    assert.equal(calls.browser, 1);
    assert.equal(calls.navigations.length, 3);
    assert.equal(result.sources.length, 3);
    assert.equal(result.sources[2].url, "https://www.iana.org/");
    for (const source of result.sources)
      assert.doesNotThrow(() => new Date(source.accessedAt).toISOString());
    const summaryPayload = JSON.parse(calls.modelInputs[0].messages[1].content);
    assert.deepEqual(
      summaryPayload.sources.map((source) => source.label),
      ["[1]", "[2]", "[3]"],
    );
    assert.ok(summaryPayload.sources.every((source) => source.accessedAt));
  });

  it("rejects requests with more than three explicit URLs", async () => {
    const { env, calls } = createEnvironment();
    const cookie = await login(env);
    const response = await worker.fetch(
      post(
        "/api/plan",
        {
          task: "اقرأ https://one.example https://two.example https://three.example https://four.example",
        },
        cookie,
      ),
      env,
    );

    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /حتى 3 روابط/);
    assert.equal(calls.ai, 0);
    assert.equal(calls.browser, 0);
  });

  it("searches and reads up to three DNS-validated public results in one session", async () => {
    const searchPlan = JSON.stringify({
      analysis: "البحث عن مصادر عامة موثوقة.",
      steps: [
        {
          action: "SEARCH_WEB",
          target: "نتائج البحث العامة",
          value: "public example pages",
          reason: "العثور على صفحات عامة للقراءة فقط.",
        },
        {
          action: "OBSERVE",
          target: "مصادر البحث",
          value: "",
          reason: "اختيار روابط عامة والتحقق منها.",
        },
      ],
    });
    const { env, calls } = createEnvironment({
      plan: searchPlan,
      searchResults: [
        "https://example.com/",
        "https://example.org/",
        "https://www.iana.org/",
        "https://fourth.example/",
      ],
    });
    const cookie = await login(env);
    const planned = await worker.fetch(
      post("/api/plan", { task: "ابحث عن صفحات عامة حول أمثلة الويب" }, cookie),
      env,
    );
    const plan = await planned.json();
    const response = await withDnsAnswers(
      ["93.184.216.34"],
      () =>
        worker.fetch(
          post("/api/execute", { planToken: plan.planToken }, cookie),
          env,
        ),
      ["2606:4700:4700::1111"],
      ["html.duckduckgo.com", "example.com", "example.org", "www.iana.org"],
    );
    const result = await response.json();

    assert.equal(planned.status, 200);
    assert.equal(plan.plan.action, "search");
    assert.equal(response.status, 200);
    assert.equal(calls.browser, 1);
    assert.equal(calls.navigations.length, 4);
    assert.equal(result.sources.length, 3);
    assert.deepEqual(
      result.sources.map((source) => source.url),
      ["https://example.com/", "https://example.org/", "https://www.iana.org/"],
    );
  });

  it("returns a validated plan from stubbed Workers AI using the CELA action contract", async () => {
    const { env, calls, state } = createEnvironment();
    const cookie = await login(env);
    const response = await worker.fetch(
      post("/api/plan", { task: "ابحث عن صفحة Example العامة" }, cookie),
      env,
    );
    const value = await response.json();
    assert.equal(response.status, 200);
    assert.equal(value.plan.action, "browse");
    assert.equal(value.plan.url, "https://example.com/");
    assert.equal(value.plan.mode, "read-only");
    assert.deepEqual(
      value.plan.steps.map((step) => step.action),
      ["NAVIGATE", "OBSERVE"],
    );
    assert.ok(value.planToken);
    assert.equal(value.model, "@cf/meta/llama-3.2-3b-instruct");
    assert.equal(value.provider, "cloudflare");
    assert.equal(calls.ai, 1);
    assert.equal((await state.storage.get("daily_usage")).aiCalls, 1);
  });

  it("uses the explicitly selected NVIDIA NIM model for planning", async () => {
    const model = "meta/llama-3.3-70b-instruct";
    const { env, calls, state } = createEnvironment({
      aiProvider: "nvidia",
      nvidiaApiKey: "test-nvidia-key",
      nvidiaModel: model,
    });
    const cookie = await login(env);
    const response = await withNvidiaFetch(
      async (nvidiaCalls) => {
        const result = await worker.fetch(
          post("/api/plan", { task: "ابحث عن صفحة Example العامة" }, cookie),
          env,
        );
        assert.equal(nvidiaCalls.length, 1);
        assert.equal(
          nvidiaCalls[0].init.headers.authorization,
          "Bearer test-nvidia-key",
        );
        assert.equal(nvidiaCalls[0].payload.model, model);
        assert.equal(nvidiaCalls[0].payload.stream, false);
        return result;
      },
      { content: goodPlan },
    );
    const value = await response.json();

    assert.equal(response.status, 200);
    assert.equal(value.provider, "nvidia");
    assert.equal(value.model, model);
    assert.equal(calls.ai, 0);
    assert.equal((await state.storage.get("daily_usage")).aiCalls, 1);
  });

  it("fails closed when NVIDIA NIM is selected without an API key", async () => {
    const { env, calls, state } = createEnvironment({
      aiProvider: "nvidia",
    });
    const status = await worker.fetch(
      new Request("https://agent.test/api/status"),
      env,
    );
    const plan = await worker.fetch(
      post("/api/plan", { task: "ابحث عن معلومات عامة" }),
      env,
    );

    assert.equal((await status.json()).configured, false);
    assert.equal(plan.status, 503);
    assert.equal(calls.ai, 0);
    assert.equal((await state.storage.get("daily_usage"))?.aiCalls || 0, 0);
  });

  it("does not fall back to Workers AI when NVIDIA NIM returns a quota error", async () => {
    const { env, calls } = createEnvironment({
      aiProvider: "nvidia",
      nvidiaApiKey: "test-nvidia-key",
    });
    const cookie = await login(env);
    const response = await withNvidiaFetch(
      (nvidiaCalls) =>
        worker
          .fetch(
            post("/api/plan", { task: "ابحث عن معلومات عامة" }, cookie),
            env,
          )
          .then((result) => {
            assert.equal(nvidiaCalls.length, 1);
            return result;
          }),
      { status: 429 },
    );
    const value = await response.json();

    assert.equal(response.status, 429);
    assert.match(value.error, /بلا ترقية أو مزود بديل/);
    assert.equal(calls.ai, 0);
  });

  it("uses NVIDIA NIM for page summaries when explicitly selected", async () => {
    const { env, calls } = createEnvironment({
      aiProvider: "nvidia",
      nvidiaApiKey: "test-nvidia-key",
    });
    const cookie = await login(env);
    const planned = await worker.fetch(
      post(
        "/api/plan",
        { task: "افتح https://example.com واقرأ الصفحة" },
        cookie,
      ),
      env,
    );
    const plan = await planned.json();
    const response = await withNvidiaFetch((nvidiaCalls) =>
      worker
        .fetch(post("/api/execute", { planToken: plan.planToken }, cookie), env)
        .then((result) => {
          assert.equal(nvidiaCalls.length, 1);
          assert.equal(
            nvidiaCalls[0].payload.model,
            "meta/llama-3.3-70b-instruct",
          );
          return result;
        }),
    );
    const result = await response.json();

    assert.equal(response.status, 200);
    assert.equal(result.provider, "nvidia");
    assert.equal(result.model, "meta/llama-3.3-70b-instruct");
    assert.match(result.answer, /تم التحقق/);
    assert.equal(calls.ai, 0);
  });

  it("rejects malformed or unsafe plans before execution", async () => {
    for (const plan of [
      "not json",
      goodPlan.replace("https://example.com/", "http://127.0.0.1/"),
    ]) {
      const { env } = createEnvironment({ plan });
      const cookie = await login(env);
      const response = await worker.fetch(
        post("/api/plan", { task: "افتح الصفحة" }, cookie),
        env,
      );
      assert.equal(response.status, 502);
      assert.equal((await response.json()).planToken, undefined);
    }
  });

  it("requires separate confirmation for sensitive requests", async () => {
    const searchPlan = JSON.stringify({
      analysis: "البحث عن معلومة عامة.",
      steps: [
        {
          action: "SEARCH_WEB",
          target: "محرك بحث عام",
          value: "إرسال بريد إلكتروني",
          reason: "قراءة نتائج عامة عن إرسال البريد.",
        },
        {
          action: "OBSERVE",
          target: "نتائج عامة",
          value: "",
          reason: "استخراج النص المقروء فقط.",
        },
      ],
    });
    const { env, state } = createEnvironment({ plan: searchPlan });
    const cookie = await login(env);
    const planned = await worker.fetch(
      post("/api/plan", { task: "ابحث عن طريقة إرسال بريد" }, cookie),
      env,
    );
    const value = await planned.json();
    assert.equal(value.plan.requiresConfirmation, true);
    const response = await worker.fetch(
      post("/api/execute", { planToken: value.planToken }, cookie),
      env,
    );
    assert.equal(response.status, 409);
    assert.equal((await state.storage.get("daily_usage")).browserRuns || 0, 0);
  });

  it("uses a short-lived Playwright session with same-origin read-only requests", async () => {
    const { env, calls } = createEnvironment();
    const cookie = await login(env);
    const planned = await worker.fetch(
      post(
        "/api/plan",
        { task: "افتح https://example.com واقرأ الصفحة" },
        cookie,
      ),
      env,
    );
    const plan = await planned.json();
    const response = await withDnsAnswers(
      ["93.184.216.34"],
      () =>
        worker.fetch(
          post("/api/execute", { planToken: plan.planToken }, cookie),
          env,
        ),
      ["2606:4700:4700::1111"],
    );
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(calls.browser, 1);
    assert.equal(calls.navigation.url, "https://example.com/");
    assert.equal(calls.navigation.options.waitUntil, "domcontentloaded");
    assert.equal(calls.navigation.options.timeout, 8_000);
    assert.equal(calls.contextOptions.javaScriptEnabled, false);
    assert.equal(calls.contextOptions.serviceWorkers, "block");
    assert.equal(calls.routePattern, "**/*");
    assert.deepEqual(
      calls.routeDecisions.map((item) => item.decision),
      ["continue", "abort", "abort", "abort"],
    );
    assert.equal(calls.locator, "body");
    assert.equal(calls.contextClosed, 1);
    assert.equal(calls.browserClosed, 1);
    assert.match(result.answer, /تم التحقق/);
    assert.equal(result.evidence.title, "Example Domain");
    assert.equal(result.evidence.reservedBrowserMs, 120_000);
    assert.ok(result.steps.some((step) => step.includes("Playwright")));
  });

  it("closes a failed browser session and keeps its full safety reservation", async () => {
    const { env, calls, state } = createEnvironment({
      browserError: new Error("navigation failed"),
    });
    const cookie = await login(env);
    const planned = await worker.fetch(
      post(
        "/api/plan",
        { task: "افتح https://example.com واقرأ الصفحة" },
        cookie,
      ),
      env,
    );
    const plan = await planned.json();
    const response = await withDnsAnswers(["93.184.216.34"], () =>
      worker.fetch(
        post("/api/execute", { planToken: plan.planToken }, cookie),
        env,
      ),
    );
    assert.equal(response.status, 502);
    assert.equal(calls.contextClosed, 1);
    assert.equal(calls.browserClosed, 1);
    const usage = await state.storage.get("daily_usage");
    assert.equal(usage.browserMs, 120_000);
    assert.deepEqual(usage.browserReservations, {});
  });

  it("cancels an active page read, closes the browser, and releases its slot", async () => {
    const { env, calls, state } = createEnvironment({ hangNavigation: true });
    const cookie = await login(env);
    const planned = await worker.fetch(
      post(
        "/api/plan",
        { task: "افتح https://example.com واقرأ الصفحة" },
        cookie,
      ),
      env,
    );
    const plan = await planned.json();
    const aborter = new AbortController();
    const response = await withDnsAnswers(["93.184.216.34"], async () => {
      const pending = worker.fetch(
        post(
          "/api/execute",
          { planToken: plan.planToken },
          cookie,
          "https://agent.test",
          aborter.signal,
        ),
        env,
      );
      while (!calls.navigationPending)
        await new Promise((resolve) => setTimeout(resolve, 0));
      aborter.abort();
      return pending;
    });
    const result = await response.json();

    assert.equal(response.status, 499);
    assert.match(result.error, /بناءً على طلبك/);
    assert.equal(calls.contextClosed, 1);
    assert.equal(calls.browserClosed, 1);
    assert.equal(calls.ai, 0);
    const usage = await state.storage.get("daily_usage");
    assert.deepEqual(usage.browserReservations, {});
    assert.equal(usage.browserMs, 120_000);
  });

  it("closes a browser that finishes launching after the request is cancelled", async () => {
    const { env, calls } = createEnvironment();
    const cookie = await login(env);
    const planned = await worker.fetch(
      post(
        "/api/plan",
        { task: "افتح https://example.com واقرأ الصفحة" },
        cookie,
      ),
      env,
    );
    const plan = await planned.json();
    const aborter = new AbortController();
    let finishLaunch;
    const delayedWorker = createWorker(
      async (binding) =>
        new Promise((resolve) => {
          finishLaunch = () => resolve(binding.launch());
        }),
    );
    const response = await withDnsAnswers(["93.184.216.34"], async () => {
      const pending = delayedWorker.fetch(
        post(
          "/api/execute",
          { planToken: plan.planToken },
          cookie,
          "https://agent.test",
          aborter.signal,
        ),
        env,
      );
      while (!finishLaunch)
        await new Promise((resolve) => setTimeout(resolve, 0));
      aborter.abort();
      const result = await pending;
      finishLaunch();
      return result;
    });

    assert.equal(response.status, 499);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(calls.browserClosed, 1);
  });

  it("fails closed on private, mixed, or unavailable DNS answers", async () => {
    for (const [addresses, ipv6Addresses] of [
      [["10.0.0.8"], []],
      [["93.184.216.34", "169.254.169.254"], []],
      [["93.184.216.34"], ["fd00::1"]],
      [["93.184.216.34"], ["2001:db8::1"]],
      [null, []],
    ]) {
      const { env, calls, state } = createEnvironment();
      const cookie = await login(env);
      const planned = await worker.fetch(
        post(
          "/api/plan",
          { task: "افتح https://example.com واقرأ الصفحة" },
          cookie,
        ),
        env,
      );
      const plan = await planned.json();
      const response = await withDnsAnswers(
        addresses,
        () =>
          worker.fetch(
            post("/api/execute", { planToken: plan.planToken }, cookie),
            env,
          ),
        ipv6Addresses,
      );
      assert.equal(response.status, 400);
      assert.equal(calls.browser, 0);
      assert.equal(
        (await state.storage.get("daily_usage"))?.browserRuns || 0,
        0,
      );
    }
  });

  it("stops at the daily internal budget before invoking AI", async () => {
    const { env, calls, actor } = createEnvironment();
    for (let index = 0; index < 28; index += 1) {
      const response = await actor.fetch(post("/reserve", { kind: "ai" }));
      assert.equal(response.status, 200);
    }
    const cookie = await login(env);
    const response = await worker.fetch(
      post("/api/plan", { task: "ابحث عن صفحة Example العامة" }, cookie),
      env,
    );
    assert.equal(response.status, 429);
    assert.equal(calls.ai, 0);
  });

  it("maps provider quota errors to a closed 429 without fallback", async () => {
    const { env } = createEnvironment({
      aiError: new Error("429 neuron quota exceeded"),
    });
    const cookie = await login(env);
    const response = await worker.fetch(
      post("/api/plan", { task: "ابحث عن معلومات عامة" }, cookie),
      env,
    );
    assert.equal(response.status, 429);
    assert.match((await response.json()).error, /بلا ترقية أو مزود بديل/);
  });

  it("enforces the 20-second Browser Run session interval", async () => {
    const actor = new DailyBudget(createState());
    assert.equal(
      (
        await actor.fetch(
          post("/reserve", { kind: "browser", reservationId: "run-1" }),
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await actor.fetch(
          post("/reserve", { kind: "browser", reservationId: "run-2" }),
        )
      ).status,
      429,
    );
  });

  it("reserves two minutes and releases the concurrency slot after a session", async () => {
    const state = createState();
    const actor = new DailyBudget(state);
    assert.equal(
      (
        await actor.fetch(
          post("/reserve", { kind: "browser", reservationId: "run-1" }),
        )
      ).status,
      200,
    );
    const response = await actor.fetch(
      post("/release", { reservationId: "run-1" }),
    );
    assert.equal(response.status, 200);
    const usage = await state.storage.get("daily_usage");
    assert.equal(usage.browserMs, 120_000);
    assert.deepEqual(usage.browserReservations, {});
  });

  it("does not reserve more than three concurrent Browser Run sessions", async () => {
    const state = createState();
    const actor = new DailyBudget(state);
    for (let index = 0; index < 3; index += 1) {
      if (index > 0) {
        const usage = await state.storage.get("daily_usage");
        usage.lastBrowserAt = Date.now() - 20_000;
        await state.storage.put("daily_usage", usage);
      }
      assert.equal(
        (
          await actor.fetch(
            post("/reserve", {
              kind: "browser",
              reservationId: `run-${index}`,
            }),
          )
        ).status,
        200,
      );
    }
    const usage = await state.storage.get("daily_usage");
    usage.lastBrowserAt = Date.now() - 20_000;
    await state.storage.put("daily_usage", usage);
    assert.equal(
      (
        await actor.fetch(
          post("/reserve", { kind: "browser", reservationId: "run-4" }),
        )
      ).status,
      429,
    );
  });

  it("enforces the browser daily cap at Cloudflare's published free limit", async () => {
    const state = createState();
    const actor = new DailyBudget(state);
    for (let index = 0; index < 5; index += 1) {
      if (index > 0) {
        const usage = await state.storage.get("daily_usage");
        usage.lastBrowserAt = Date.now() - 20_000;
        await state.storage.put("daily_usage", usage);
      }
      const reservationId = `run-${index}`;
      assert.equal(
        (
          await actor.fetch(
            post("/reserve", { kind: "browser", reservationId }),
          )
        ).status,
        200,
      );
      assert.equal(
        (await actor.fetch(post("/release", { reservationId }))).status,
        200,
      );
    }
    const beforeEleventh = await state.storage.get("daily_usage");
    beforeEleventh.lastBrowserAt = Date.now() - 20_000;
    await state.storage.put("daily_usage", beforeEleventh);
    assert.equal(
      (
        await actor.fetch(
          post("/reserve", { kind: "browser", reservationId: "run-6" }),
        )
      ).status,
      429,
    );
    const usage = await state.storage.get("daily_usage");
    assert.equal(usage.browserRuns, 5);
    assert.equal(usage.browserMs, 600_000);
  });
});
