"use client";

import { useEffect, useRef, useState } from "react";

type Message = { id: string; role: "user" | "assistant"; content: string; createdAt: number; sources?: Source[] };
type Source = { title: string; url: string; snippet: string };
type Project = { id: string; name: string; memory: string; messages: Message[]; updatedAt: number };
type Activity = { id: string; title: string; status: "running" | "done" | "stopped" | "error"; time: number };
type ServerStatus = { provider: string; model: string; configured: boolean; databaseEnabled: boolean; authRequired: boolean; authorized: boolean; setupRequired: boolean };

function isWorkspaceData(value: unknown): value is { projects: Project[]; activity: Activity[] } {
  if (!value || typeof value !== "object") return false;
  const data = value as Record<string, unknown>;
  if (!Array.isArray(data.projects) || !Array.isArray(data.activity)) return false;
  const projectsValid = data.projects.every((value: unknown) => {
    if (!value || typeof value !== "object") return false;
    const item = value as Record<string, unknown>;
    return typeof item.id === "string" && typeof item.name === "string" && typeof item.memory === "string" && typeof item.updatedAt === "number" && Array.isArray(item.messages) && item.messages.every((message: unknown) => {
      if (!message || typeof message !== "object") return false;
      const entry = message as Record<string, unknown>;
      return typeof entry.id === "string" && (entry.role === "user" || entry.role === "assistant") && typeof entry.content === "string" && typeof entry.createdAt === "number" && (entry.sources === undefined || Array.isArray(entry.sources));
    });
  });
  const activityValid = data.activity.every((value: unknown) => {
    if (!value || typeof value !== "object") return false;
    const item = value as Record<string, unknown>;
    return typeof item.id === "string" && typeof item.title === "string" && ["running", "done", "stopped", "error"].includes(String(item.status)) && typeof item.time === "number";
  });
  return projectsValid && activityValid;
}

const STORAGE = "manus-mini-projects-v1";
const ACTIVITY_STORAGE = "manus-mini-activity-v1";
const initialProject = (): Project => ({ id: crypto.randomUUID(), name: "مشروع جديد", memory: "", messages: [], updatedAt: Date.now() });
const sensitiveRequest = /(احذف|إرسال|ارسل|ابعث|شراء|اشتر|ادفع|انشر|حوّل|حوالة|transfer|delete|send|publish|purchase|pay)/i;

export default function Home() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [syncState, setSyncState] = useState<"local" | "loading" | "saving" | "saved" | "error">("local");
  const [cloudLoaded, setCloudLoaded] = useState(0);
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<"chat" | "research">("chat");
  const [activity, setActivity] = useState<Activity[]>([]);
  const [fileText, setFileText] = useState("");
  const [fileName, setFileName] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [showInspector, setShowInspector] = useState(false);
  const [showSidebar, setShowSidebar] = useState(false);
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [authenticated, setAuthenticated] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const cloudReady = useRef(false);
  const cloudWrite = useRef<Promise<void>>(Promise.resolve());
  const bottom = useRef<HTMLDivElement>(null);
  const project = projects.find((item) => item.id === selectedId) || projects[0];

  async function loadCloudWorkspace(enabled: boolean) {
    cloudReady.current = false;
    if (!enabled) { setSyncState("local"); return; }
    setSyncState("loading");
    try {
      const response = await fetch("/api/workspace", { cache: "no-store" });
      if (!response.ok) throw new Error("workspace read failed");
      const result = await response.json() as { data?: unknown };
      if (result.data !== null && result.data !== undefined) {
        if (!isWorkspaceData(result.data)) throw new Error("invalid workspace data");
        const list = result.data.projects.length ? result.data.projects : [initialProject()];
        setProjects(list);
        setSelectedId(list[0].id);
        setActivity(result.data.activity.slice(0, 30));
      }
      cloudReady.current = true;
      setCloudLoaded((version) => version + 1);
      setSyncState("saved");
    } catch {
      setSyncState("error");
    }
  }

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE) || "[]") as Project[];
      const list = saved.length ? saved : [initialProject()];
      setProjects(list);
      setSelectedId(list[0].id);
    } catch {
      const item = initialProject();
      setProjects([item]);
      setSelectedId(item.id);
    }
    try { setActivity(JSON.parse(localStorage.getItem(ACTIVITY_STORAGE) || "[]") as Activity[]); } catch { setActivity([]); }
    setReady(true);
    let active = true;
    fetch("/api/status").then((response) => response.json()).then(async (data: ServerStatus) => {
      if (!active) return;
      setStatus(data);
      setAuthenticated(!data.authRequired || data.authorized);
      if (data.databaseEnabled && (!data.authRequired || data.authorized)) await loadCloudWorkspace(true);
      else setSyncState("local");
    }).catch(() => {
      if (active) setStatus({ provider: "gemini", model: "gemini-3.8-flash", configured: false, databaseEnabled: false, authRequired: false, authorized: true, setupRequired: false });
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (ready) localStorage.setItem(STORAGE, JSON.stringify(projects));
  }, [projects, ready]);

  useEffect(() => {
    if (ready) localStorage.setItem(ACTIVITY_STORAGE, JSON.stringify(activity.slice(0, 30)));
  }, [activity, ready]);

  useEffect(() => {
    if (!ready || !status?.databaseEnabled || !authenticated || !cloudReady.current) return;
    const timer = window.setTimeout(() => {
      const payload = JSON.stringify({ projects, activity: activity.slice(0, 30) });
      setSyncState("saving");
      cloudWrite.current = cloudWrite.current.catch(() => {}).then(async () => {
        const response = await fetch("/api/workspace", { method: "PUT", headers: { "Content-Type": "application/json" }, body: payload });
        if (!response.ok) throw new Error("workspace save failed");
        setSyncState("saved");
      }).catch(() => setSyncState("error"));
    }, 700);
    return () => window.clearTimeout(timer);
  }, [projects, activity, ready, status?.databaseEnabled, authenticated, cloudLoaded]);

  useEffect(() => { bottom.current?.scrollIntoView({ behavior: "smooth" }); }, [project?.messages.length]);

  function updateProject(id: string, change: (current: Project) => Project) {
    setProjects((list) => list.map((item) => item.id === id ? change(item) : item));
  }

  function appendMessage(projectId: string, message: Message) {
    updateProject(projectId, (current) => ({ ...current, messages: [...current.messages, message], updatedAt: Date.now() }));
  }

  function updateMessage(projectId: string, messageId: string, change: (message: Message) => Message) {
    updateProject(projectId, (current) => ({ ...current, messages: current.messages.map((message) => message.id === messageId ? change(message) : message), updatedAt: Date.now() }));
  }

  function newProject() {
    const item = initialProject();
    setProjects((list) => [item, ...list]);
    setSelectedId(item.id);
    setInput("");
  }

  function removeProject(id: string) {
    if (!window.confirm("حذف هذا المشروع ومحادثاته من هذا المتصفح؟")) return;
    const rest = projects.filter((item) => item.id !== id);
    if (!rest.length) rest.push(initialProject());
    setProjects(rest);
    if (selectedId === id) setSelectedId(rest[0].id);
  }

  async function addFile(file?: File) {
    if (!file) return;
    if (file.size > 15 * 1024 * 1024) { window.alert("حجم الملف الأقصى 15 ميغابايت."); return; }
    try {
      let content = "";
      if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
        const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
        const pages: string[] = [];
        for (let pageNumber = 1; pageNumber <= Math.min(pdf.numPages, 80); pageNumber += 1) {
          const page = await pdf.getPage(pageNumber);
          const text = await page.getTextContent();
          pages.push(text.items.map((item) => "str" in item ? item.str : "").join(" "));
          if (pages.join("\n").length > 40000) break;
        }
        content = pages.join("\n").slice(0, 40000);
      } else if (/\.(txt|md|csv)$/i.test(file.name) || file.type.startsWith("text/")) {
        content = (await file.text()).slice(0, 40000);
      } else {
        window.alert("ارفع PDF أو ملف نصي أو Markdown أو CSV.");
        return;
      }
      setFileName(file.name);
      setFileText(content);
    } catch {
      window.alert("تعذر قراءة الملف. جرّب ملفًا نصيًا أو PDF غير محمي بكلمة مرور.");
    }
  }

  async function sendMessage(value = input, approved = false) {
    const message = value.trim();
    if (!message || busy || !project) return;
    if (sensitiveRequest.test(message) && !approved) { setConfirmText(message); return; }

    const projectId = project.id;
    const userMessage: Message = { id: crypto.randomUUID(), role: "user", content: message, createdAt: Date.now() };
    const answer: Message = { id: crypto.randomUUID(), role: "assistant", content: "", createdAt: Date.now() };
    appendMessage(projectId, userMessage);
    appendMessage(projectId, answer);
    if (project.messages.length === 0) updateProject(projectId, (item) => ({ ...item, name: message.slice(0, 32) || "مشروع جديد" }));
    setInput("");
    const attachedText = fileText;
    const attachedName = fileName;
    setFileText("");
    setFileName("");
    const taskId = crypto.randomUUID();
    setActivity((list) => [{ id: taskId, title: mode === "research" ? `بحث: ${message.slice(0, 48)}` : message.slice(0, 56), status: "running" as const, time: Date.now() }, ...list].slice(0, 30));
    setBusy(true);
    const abort = new AbortController();
    controller.current = abort;

    try {
      let sources: Source[] = [];
      if (mode === "research") {
        const search = await fetch("/api/search", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: message }), signal: abort.signal });
        const result = await search.json();
        sources = result.results || [];
        if (!search.ok && !sources.length) throw new Error(result.error || "تعذر البحث عبر الإنترنت.");
      }
      updateMessage(projectId, answer.id, (item) => ({ ...item, sources }));
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, memory: project.memory, history: project.messages.slice(-16).map(({ role, content }) => ({ role, content })), fileText: attachedText ? `الملف ${attachedName}:\n${attachedText}` : "", sources }),
        signal: abort.signal,
      });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result.error || "تعذر بدء الرد.");
      }
      if (!response.body) throw new Error("المتصفح لم يستقبل تدفق الرد.");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let fullText = "";
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const frames = buffer.split(/\r?\n\r?\n/);
        buffer = frames.pop() || "";
        for (const frame of frames) {
          if (frame.startsWith("event: error")) {
            const data = frame.split(/\r?\n/).find((line) => line.startsWith("data:"))?.slice(5).trim();
            throw new Error(data ? JSON.parse(data).error : "انقطع الرد.");
          }
          const data = frame.split(/\r?\n/).find((line) => line.startsWith("data:"))?.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          const chunk = JSON.parse(data) as { text?: string };
          fullText += chunk.text || "";
          updateMessage(projectId, answer.id, (item) => ({ ...item, content: fullText }));
        }
        if (done) break;
      }
      setActivity((list) => list.map((item) => item.id === taskId ? { ...item, status: "done" } : item));
    } catch (error) {
      const stopped = abort.signal.aborted;
      const detail = stopped ? "\n\n[أوقفت المهمة]" : `\n\nتعذر إكمال المهمة: ${error instanceof Error ? error.message : "خطأ غير متوقع"}`;
      updateMessage(projectId, answer.id, (item) => ({ ...item, content: item.content ? item.content + detail : detail.trim() }));
      setActivity((list) => list.map((item) => item.id === taskId ? { ...item, status: stopped ? "stopped" : "error" } : item));
    } finally {
      setBusy(false);
      controller.current = null;
    }
  }

  async function login(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoginError("");
    const response = await fetch("/api/access", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
    if (!response.ok) { setLoginError("كلمة المرور غير صحيحة."); return; }
    if (status?.databaseEnabled) await loadCloudWorkspace(true);
    setAuthenticated(true);
    setPassword("");
  }

  function download(content: string, filename: string, type = "text/plain") {
    const url = URL.createObjectURL(new Blob([content], { type: `${type};charset=utf-8` }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function exportCsv() {
    if (!project) return;
    const quote = (value: string) => `"${value.replace(/"/g, '""')}"`;
    const rows = [["role", "message"], ...project.messages.map((message) => [message.role, message.content])];
    download(`\uFEFF${rows.map((row) => row.map(quote).join(",")).join("\r\n")}`, `${project.name || "conversation"}.csv`, "text/csv");
  }

  if (!ready) return <div className="boot">Manus Mini</div>;

  return <main className="app-shell">
    <aside className={`sidebar ${showSidebar ? "open" : ""}`}>
      <div className="brand"><span className="brand-mark">M</span><span>manus<span className="brand-light">mini</span></span><button className="mobile-only icon-button" onClick={() => setShowSidebar(false)} aria-label="إغلاق القائمة">×</button></div>
      <button className="new-project" onClick={newProject}><span>＋</span> مشروع جديد</button>
      <div className="side-label">مساحات العمل <button onClick={newProject} aria-label="إضافة مشروع">＋</button></div>
      <nav className="project-list">{projects.map((item) => <div className={`project-row ${item.id === project?.id ? "selected" : ""}`} key={item.id}>
        <button onClick={() => { setSelectedId(item.id); setShowSidebar(false); }}><span className="project-dot" />{item.name}</button>
        <button className="row-menu" aria-label={`حذف ${item.name}`} onClick={() => removeProject(item.id)}>⋯</button>
      </div>)}</nav>
      <div className="sidebar-bottom"><button onClick={() => setShowSettings(true)}><span>⚙</span> الإعدادات والاتصال</button><div className="account"><span className="avatar">م</span><span><b>مساحة خاصة</b><small>{syncState === "loading" ? "جارٍ تحميل مساحة العمل..." : syncState === "saving" ? "جارٍ حفظ التغييرات..." : syncState === "saved" ? "حفظ سحابي ومحلي" : syncState === "error" ? "تعذر الاتصال بالحفظ السحابي" : "حفظ داخل هذا المتصفح"}</small></span></div></div>
    </aside>

    <section className="main-column">
      <header className="topbar"><div><button className="mobile-only icon-button" onClick={() => setShowSidebar(true)} aria-label="فتح المشاريع">☰</button><span className="breadcrumb">مساحة العمل</span><span className="crumb-sep">/</span><b>{project?.name || "مشروع جديد"}</b></div><div className="top-actions"><span className={`provider-pill ${status?.configured ? "online" : "offline"}`}><i />{status?.provider || "Gemini"}</span><button className="mobile-only icon-button" onClick={() => setShowInspector((open) => !open)} aria-label="عرض النشاط">☷</button><button className="icon-button" onClick={() => setShowSettings(true)} aria-label="الإعدادات">⚙</button></div></header>
      <div className="chat-scroll">
        <div className="thread">
          {!project?.messages.length ? <div className="welcome"><div className="welcome-symbol">M</div><p className="welcome-kicker">مساعد عملك، بمسار واضح</p><h1>ماذا تريد أن<br /><span>تنجز اليوم؟</span></h1><p className="welcome-copy">اكتب هدفك. سأساعدك على تقسيمه إلى خطوات، البحث عند اختيار وضع البحث، وتحليل الملفات التي ترفقها.</p><div className="suggestions"><button onClick={() => setInput("لخّص ملف PDF وأخرج أهم النقاط في قائمة منظمة")}>لخّص ملفًا وارصد أهم النقاط <span>↗</span></button><button onClick={() => { setMode("research"); setInput("ابحث عن أحدث أدوات الذكاء الاصطناعي المفتوحة المصدر وقارنها") }}>ابحث وقارن بين خيارات <span>↗</span></button><button onClick={() => setInput("أنشئ خطة أسبوعية لمشروعي مع قائمة مهام قابلة للتنزيل")}>خطط لمشروع جديد <span>↗</span></button></div></div> : project.messages.map((message) => <article className={`message ${message.role}`} key={message.id}>
            {message.role === "assistant" && <span className="assistant-avatar">M</span>}
            <div className="message-body"><div className="message-label">{message.role === "user" ? "أنت" : "Manus Mini"}</div><div className="message-content">{message.content || <span className="typing"><i /><i /><i /></span>}</div>
              {!!message.sources?.length && <div className="source-list"><b>مصادر البحث</b>{message.sources.map((source) => <a key={source.url} href={source.url} target="_blank" rel="noreferrer">{source.title}<span>↗</span></a>)}</div>}
              {message.role === "assistant" && !!message.content && <div className="message-actions"><button onClick={() => download(message.content, "manus-reply.txt")}>تنزيل الرد</button><button onClick={() => navigator.clipboard.writeText(message.content)}>نسخ</button></div>}
            </div>
          </article>)}
          <div ref={bottom} />
        </div>
      </div>
      <div className="composer-wrap"><div className="composer">
        {fileName && <div className="file-chip"><span>▤</span>{fileName}<button onClick={() => { setFileName(""); setFileText(""); }} aria-label="إزالة الملف">×</button></div>}
        <textarea value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); sendMessage(); } }} placeholder="اكتب مهمة أو اسأل عن مشروعك..." maxLength={10000} aria-label="رسالتك" />
        <div className="composer-toolbar"><div className="tools-left"><label className="tool-button" title="إرفاق ملف">＋<input type="file" accept=".pdf,.txt,.md,.csv,text/*" onChange={(event) => addFile(event.target.files?.[0])} hidden /></label><button className={`tool-button ${mode === "research" ? "active" : ""}`} onClick={() => setMode(mode === "chat" ? "research" : "chat")}><span>⌕</span> بحث الويب</button><span className="private-note">لا تنفذ المنصة إرسالًا أو حذفًا تلقائيًا</span></div>{busy ? <button className="stop-button" onClick={() => controller.current?.abort()}>إيقاف</button> : <button className="send-button" onClick={() => sendMessage()} disabled={!input.trim()} aria-label="إرسال">↑</button>}</div>
      </div><div className="composer-hint">Enter للإرسال · Shift + Enter لسطر جديد · لا تضع معلومات سرية في الطلب</div></div>
    </section>

    <aside className={`inspector ${showInspector ? "open" : ""}`}>
      <div className="inspector-head"><div><span className="eyebrow-small">لوحة المشروع</span><h2>النشاط والذاكرة</h2></div><button className="icon-button mobile-only" onClick={() => setShowInspector(false)} aria-label="إغلاق">×</button></div>
      <div className="inspector-card"><div className="card-heading"><span className="status-ring">✓</span><div><b>حالة المساعد</b><small>{status?.configured ? `متصل · ${status.model}` : "أضف مفتاحًا من إعدادات الخادم"}</small></div></div><button className="text-link" onClick={() => setShowSettings(true)}>إعداد الاتصال <span>←</span></button></div>
      <div className="activity-title"><b>سجل المهام</b><span>{activity.length}</span></div>
      <div className="activity-list">{activity.length ? activity.map((item) => <div className="activity-item" key={item.id}><span className={`activity-mark ${item.status}`} /> <div><b>{item.title}</b><small>{item.status === "running" ? "قيد التنفيذ" : item.status === "done" ? "اكتملت" : item.status === "stopped" ? "أوقفتها" : "توقفت بخطأ"}</small></div></div>) : <p className="empty-note">سيظهر هنا سجل المحادثة والمهام.</p>}</div>
      <div className="memory-panel"><div className="activity-title"><b>ذاكرة المشروع</b><span>{syncState === "saved" || syncState === "saving" ? "سحابية" : "محلية"}</span></div><textarea value={project?.memory || ""} onChange={(event) => project && updateProject(project.id, (item) => ({ ...item, memory: event.target.value, updatedAt: Date.now() }))} placeholder="أضف سياقًا ثابتًا مثل هدف المشروع أو تفضيلاتك. سيُرسل هذا النص مع طلباتك إلى مزود النموذج." maxLength={6000} /><small>{syncState === "saved" || syncState === "saving" ? "تُحفظ في Supabase والمتصفح، وتُرسل للمزود عند المحادثة." : "تُحفظ في هذا المتصفح، وتُرسل للمزود عند المحادثة."}</small></div>
      <div className="inspector-footer"><button onClick={() => project && download(project.messages.map((message) => `${message.role === "user" ? "أنت" : "Manus Mini"}:\n${message.content}`).join("\n\n"), `${project.name || "conversation"}.txt`)}>تنزيل المحادثة TXT ↓</button><button onClick={exportCsv}>تصدير جدول CSV ↓</button></div>
    </aside>

    {showSettings && <div className="overlay" onClick={() => setShowSettings(false)}><section className="dialog settings-dialog" onClick={(event) => event.stopPropagation()}><button className="dialog-close" onClick={() => setShowSettings(false)}>×</button><span className="eyebrow-small">الإعدادات</span><h2>الاتصال والخصوصية</h2><p>المفاتيح لا تظهر في الواجهة. اضبط المزود على الخادم داخل <code>.env.local</code>.</p><div className="setting-row"><span>مزود الذكاء الاصطناعي</span><b>{status?.provider || "gemini"}</b></div><div className="setting-row"><span>النموذج</span><b>{status?.model || "gemini-3.8-flash"}</b></div><div className="setting-row"><span>حالة المفتاح</span><b className={status?.configured ? "green" : "amber"}>{status?.configured ? "مُعدّ على الخادم" : "لم يُضف بعد"}</b></div><div className="setting-row"><span>حفظ مساحة العمل</span><b>{syncState === "saved" || syncState === "saving" ? "Supabase + المتصفح" : syncState === "error" ? "تعذر الاتصال" : "المتصفح فقط"}</b></div><pre className="env-help">AI_PROVIDER=gemini{"\n"}GEMINI_API_KEY=مفتاحك_هنا{"\n"}GEMINI_MODEL=gemini-3.8-flash</pre><p className="privacy-warning">{syncState === "saved" || syncState === "saving" ? "المحادثات والذاكرة محفوظة في Supabase وهذا المتصفح." : "المحادثات والذاكرة محفوظة في هذا المتصفح."} أرسل فقط ما تسمح بمشاركته مع مزود النموذج. لا يوجد تنفيذ لأوامر الكمبيوتر أو إرسال خارجي.</p>{status?.authRequired && authenticated && <button className="logout-action" onClick={async () => { cloudReady.current = false; await fetch("/api/access", { method: "DELETE" }); setAuthenticated(false); setShowSettings(false); }}>قفل الجلسة</button>}<button className="primary-action" onClick={() => setShowSettings(false)}>تم</button></section></div>}
    {confirmText && <div className="overlay"><section className="dialog"><span className="confirm-icon">!</span><h2>طلب حساس</h2><p>هذا الطلب يتضمن إرسالًا أو حذفًا أو إجراءً مؤثرًا. التطبيق لا ينفذ هذه الإجراءات؛ هل تريد متابعة طلب <b>خطة أو شرح فقط</b> من النموذج؟</p><div className="dialog-actions"><button onClick={() => setConfirmText("")}>إلغاء</button><button className="primary-action" onClick={() => { const text = confirmText; setConfirmText(""); sendMessage(text, true); }}>تابع التخطيط فقط</button></div></section></div>}
    {status?.setupRequired && <div className="overlay"><section className="dialog"><span className="confirm-icon">!</span><h2>أمّن التطبيق قبل نشره</h2><p>النسخة المنشورة تحتاج <code>APP_ACCESS_PASSWORD</code> و<code>SESSION_SECRET</code> في إعدادات الخادم قبل تفعيل API.</p><button className="primary-action" onClick={() => setShowSettings(true)}>عرض الإعدادات</button></section></div>}
    {status?.authRequired && !authenticated && !status.setupRequired && <div className="overlay"><form className="dialog login-dialog" onSubmit={login}><span className="brand-mark">M</span><h2>مساحة خاصة</h2><p>أدخل كلمة مرور المنصة للمتابعة.</p><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required placeholder="كلمة المرور" />{loginError && <p className="login-error">{loginError}</p>}<button className="primary-action">دخول آمن</button></form></div>}
  </main>;
}
