import { credentialStatus, pollCookieLogin, refreshDetectedClasses, startCookieLogin } from "./cookie-login.js";
import { readDocument, writeDocument } from "./documents.js";
import {
  accountFromSession,
  loginAccount,
  logoutAccount,
  recoverAccount,
  registerAccount,
  rotateRecoveryCodeForAdmin,
} from "./native-auth.js";
import { inspectClassTasks, recentObservations } from "./read-only.js";
import { executeAttendanceForAllClasses, recentAttendanceLogs, testPushplus } from "./attendance.js";
import { adminFeedback, feedbackImages, replyFeedback, submitFeedback, userFeedback } from "./feedback.js";
import {
  adminUserDetail, adminUsers, deleteAdminUser, revealRecoveryCode, setAdminUserStatus,
} from "./admin.js";
import {
  acceptVisionLicense, aiConversation, clearAiConversation, deployAiCalendar, discardAiCalendar,
  resetAiContext, saveAiContext, saveAiMemory, sendAiMessage, setAiDiagnosticOptIn, stopAiTurn,
} from "./ai-chat.js";
import { K8nGateway } from "./k8n-gateway.js";
import { processDueReads, reconcileSchedules } from "./scheduler.js";
import { normalizeCookie, saveSecret } from "./secure-data.js";

const JSON_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(self), payment=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

const SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(self), payment=()",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Content-Type-Options": "nosniff",
};

const MAP_TILE_PATTERN = /^\/api\/map\/tiles\/(\d{1,2})\/(\d+)\/(\d+)\.png$/;

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: JSON_HEADERS,
  });
}

function jsonWithHeaders(payload, status, headers) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...JSON_HEADERS, ...headers },
  });
}

function isSameOriginMutation(request, url) {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return true;
  const origin = request.headers.get("origin");
  return origin === url.origin;
}

function withSecurityHeaders(response) {
  const secured = new Response(response.body, response);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    secured.headers.set(name, value);
  }
  return secured;
}

async function handleMapTile(request, url, context) {
  const match = MAP_TILE_PATTERN.exec(url.pathname);
  if (!match) return null;
  const zoom = Number(match[1]);
  const x = Number(match[2]);
  const y = Number(match[3]);
  const tileCount = 2 ** zoom;
  if (zoom < 3 || zoom > 19 || x < 0 || y < 0 || x >= tileCount || y >= tileCount) {
    return new Response("Invalid map tile", { status: 400 });
  }

  const fetchSite = request.headers.get("sec-fetch-site");
  const referer = request.headers.get("referer");
  if (fetchSite && !["same-origin", "same-site"].includes(fetchSite)) {
    return new Response("Map tile hotlink rejected", { status: 403 });
  }
  if (referer) {
    try {
      if (new URL(referer).origin !== url.origin) {
        return new Response("Map tile hotlink rejected", { status: 403 });
      }
    } catch {
      return new Response("Invalid referrer", { status: 400 });
    }
  }

  const cacheKey = new Request(url.toString(), { method: "GET" });
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const upstream = await fetch(`https://tile.openstreetmap.org/${zoom}/${x}/${y}.png`, {
    headers: {
      Accept: "image/png,image/*;q=0.8",
      Referer: referer || `${url.origin}/app`,
      "User-Agent": "ClassCube-AutoCheck/1.0 (+https://davidsun.kdns.fr/)",
    },
    signal: AbortSignal.timeout(8_000),
  });
  if (!upstream.ok) return new Response("Map tile unavailable", { status: upstream.status });
  const response = new Response(upstream.body, {
    headers: {
      "Cache-Control": "public, max-age=604800, s-maxage=604800",
      "Content-Type": upstream.headers.get("content-type") ?? "image/png",
      "Cross-Origin-Resource-Policy": "same-origin",
      "X-Content-Type-Options": "nosniff",
    },
  });
  context.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

async function requestJson(request) {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) throw new Error("Expected JSON request body");
  return request.json();
}

async function authenticatedAccount(request, env) {
  const account = await accountFromSession(request, env);
  if (!account) return { response: json({ ok: false, error: "Login is required" }, 401) };
  return { account };
}

async function handleNativeAuth(request, env, action) {
  if (action === "session") {
    const account = await accountFromSession(request, env);
    return json({ ok: true, authenticated: Boolean(account), account });
  }
  if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
  try {
    if (action === "logout") {
      const cookie = await logoutAccount(request, env);
      return jsonWithHeaders({ ok: true }, 200, { "Set-Cookie": cookie });
    }
    const body = await requestJson(request);
    if (action === "register") {
      const result = await registerAccount(request, env, body);
      return jsonWithHeaders(
        { ok: true, account: result.account, recoveryCode: result.recoveryCode },
        201,
        { "Set-Cookie": result.cookie },
      );
    }
    if (action === "login") {
      const result = await loginAccount(request, env, body);
      return jsonWithHeaders({ ok: true, account: result.account }, 200, {
        "Set-Cookie": result.cookie,
      });
    }
    if (action === "recover") {
      const result = await recoverAccount(request, env, body);
      return jsonWithHeaders(
        { ok: true, recoveryCode: result.recoveryCode },
        200,
        { "Set-Cookie": result.cookie },
      );
    }
    return json({ ok: false, error: "Not found" }, 404);
  } catch (error) {
    return json({ ok: false, error: error instanceof Error ? error.message : "Authentication failed" }, 400);
  }
}

async function handleDocumentRequest(request, env, kind) {
  const auth = await authenticatedAccount(request, env);
  if (auth.response) return auth.response;
  if (request.method === "GET") {
    return json({ ok: true, ...(await readDocument(env, auth.account.id, kind)) });
  }
  if (request.method !== "PUT") return json({ ok: false, error: "Method not allowed" }, 405);

  try {
    const body = await requestJson(request);
    const expectedRevision = Number(body.revision);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
      return json({ ok: false, error: "A valid revision is required" }, 400);
    }
    const result = await writeDocument(env, auth.account.id, kind, body.document, expectedRevision);
    return json({ ok: !result.conflict, ...result }, result.conflict ? 409 : 200);
  } catch (error) {
    return json({ ok: false, error: error instanceof Error ? error.message : "Invalid document" }, 400);
  }
}

async function handleCredentialRequest(request, env) {
  const auth = await authenticatedAccount(request, env);
  if (auth.response) return auth.response;
  if (request.method === "GET") {
    return json({ ok: true, ...(await credentialStatus(env, auth.account.id)) });
  }
  if (request.method !== "PUT") return json({ ok: false, error: "Method not allowed" }, 405);

  try {
    const body = await requestJson(request);
    if (body.kind === "bjmf_cookie") {
      const cookie = normalizeCookie(String(body.value ?? ""));
      if (!cookie) return json({ ok: false, error: "Cookie format is invalid" }, 400);
      await saveSecret(env, auth.account.id, "bjmf_cookie", cookie);
    } else if (body.kind === "pushplus_token") {
      const token = String(body.value ?? "").trim();
      if (!/^[A-Za-z0-9._-]{8,200}$/.test(token)) {
        return json({ ok: false, error: "PushPlus token format is invalid" }, 400);
      }
      await saveSecret(env, auth.account.id, "pushplus_token", token);
    } else {
      return json({ ok: false, error: "Unknown credential kind" }, 400);
    }
    return json({ ok: true, ...(await credentialStatus(env, auth.account.id)) });
  } catch (error) {
    return json({ ok: false, error: error instanceof Error ? error.message : "Unable to store credential" }, 400);
  }
}

async function handleLoginStart(request, env) {
  const auth = await authenticatedAccount(request, env);
  if (auth.response) return auth.response;
  if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
  try {
    return json({ ok: true, ...(await startCookieLogin(env, auth.account.id)) }, 201);
  } catch (error) {
    console.error("cookie login start failed", error);
    return json({
      ok: false,
      error: "二维码暂时生成失败，请稍等几秒后重试",
      code: "qr_start_failed",
    }, 502);
  }
}

async function handleLoginPoll(request, env, url) {
  const auth = await authenticatedAccount(request, env);
  if (auth.response) return auth.response;
  if (request.method !== "GET") return json({ ok: false, error: "Method not allowed" }, 405);
  const attemptId = url.searchParams.get("id") ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(attemptId)) return json({ ok: false, error: "Invalid login attempt" }, 400);
  return json({ ok: true, ...(await pollCookieLogin(env, auth.account.id, attemptId)) });
}

async function handleReadOnlyCheck(request, env) {
  const auth = await authenticatedAccount(request, env);
  if (auth.response) return auth.response;
  if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
  try {
    const body = await requestJson(request);
    return json({ ok: true, ...(await inspectClassTasks(env, auth.account.id, String(body.classId ?? ""))) });
  } catch (error) {
    return json({ ok: false, error: error instanceof Error ? error.message : "Read-only check failed" }, 400);
  }
}

async function handleAttendanceRun(request, env) {
  const auth = await authenticatedAccount(request, env);
  if (auth.response) return auth.response;
  if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
  try {
    const body = await requestJson(request);
    if (body.confirm !== true) return json({ ok: false, error: "Explicit confirmation is required" }, 400);
    try { await refreshDetectedClasses(env, auth.account.id); }
    catch (error) { console.warn("manual class refresh failed", auth.account.id, error); }
    return json({ ok: true, ...(await executeAttendanceForAllClasses(env, auth.account.id, { source: "manual" })) });
  } catch (error) {
    return json({ ok: false, error: error instanceof Error ? error.message : "Attendance run failed" }, 400);
  }
}

async function handlePushplusTest(request, env) {
  const auth = await authenticatedAccount(request, env);
  if (auth.response) return auth.response;
  if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
  try {
    return json({ ok: true, ...(await testPushplus(env, auth.account.id)) });
  } catch (error) {
    return json({ ok: false, error: error instanceof Error ? error.message : "PushPlus 测试失败" }, 400);
  }
}

async function handleAdmin(request, env, url) {
  const auth = await authenticatedAccount(request, env);
  if (auth.response) return auth.response;
  if (auth.account.role !== "admin") return json({ ok: false, error: "Admin access is required" }, 403);
  if (url.pathname === "/api/admin/users" && request.method === "GET") {
    return json({ ok: true, users: await adminUsers(env) });
  }
  if (url.pathname === "/api/admin/feedback" && request.method === "GET") {
    return json({ ok: true, feedback: await adminFeedback(env) });
  }
  const feedbackReplyMatch = /^\/api\/admin\/feedback\/([0-9a-f-]{36})\/reply$/i.exec(url.pathname);
  if (feedbackReplyMatch) {
    if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
    try {
      await replyFeedback(env, feedbackReplyMatch[1], await requestJson(request));
      return json({ ok: true });
    } catch (error) {
      return json({ ok: false, error: error instanceof Error ? error.message : "无法发送回复" }, 400);
    }
  }
  const recoveryMatch = /^\/api\/admin\/users\/([0-9a-f-]{36})\/recovery$/i.exec(url.pathname);
  if (recoveryMatch) {
    if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
    try {
      return json({ ok: true, ...(await revealRecoveryCode(env, auth.account.id, recoveryMatch[1])) });
    } catch (error) {
      return json({ ok: false, error: error instanceof Error ? error.message : "Unable to reveal recovery code" }, 400);
    }
  }
  const recoveryRotateMatch = /^\/api\/admin\/users\/([0-9a-f-]{36})\/recovery\/rotate$/i.exec(url.pathname);
  if (recoveryRotateMatch) {
    if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
    try {
      const body = await requestJson(request);
      const target = await env.DB.prepare(
        "SELECT login_name FROM auth_credentials WHERE account_id=?",
      ).bind(recoveryRotateMatch[1]).first();
      if (!target || String(body.confirmation ?? "").trim().toLowerCase() !== target.login_name) {
        return json({ ok: false, error: "请输入完整用户名确认重新生成" }, 400);
      }
      return json({ ok: true, ...(await rotateRecoveryCodeForAdmin(env, auth.account.id, recoveryRotateMatch[1])) });
    } catch (error) {
      return json({ ok: false, error: error instanceof Error ? error.message : "Unable to rotate recovery code" }, 400);
    }
  }
  const match = /^\/api\/admin\/users\/([0-9a-f-]{36})$/i.exec(url.pathname);
  if (!match) return json({ ok: false, error: "Not found" }, 404);
  try {
    if (request.method === "GET") return json({ ok: true, ...(await adminUserDetail(env, match[1])) });
    const body = await requestJson(request);
    if (request.method === "PATCH") {
      return json({ ok: true, ...(await setAdminUserStatus(env, auth.account.id, match[1], String(body.status ?? ""))) });
    }
    if (request.method === "DELETE") {
      return json({ ok: true, ...(await deleteAdminUser(env, auth.account.id, match[1], body.confirmation)) });
    }
    return json({ ok: false, error: "Method not allowed" }, 405);
  } catch (error) {
    return json({ ok: false, error: error instanceof Error ? error.message : "Admin operation failed" }, 400);
  }
}

async function handleFeedback(request, env) {
  const auth = await authenticatedAccount(request, env);
  if (auth.response) return auth.response;
  if (request.method === "GET") return json({ ok: true, feedback: await userFeedback(env, auth.account.id) });
  if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
  try {
    return json({ ok: true, ...(await submitFeedback(env, auth.account.id, await requestJson(request))) }, 201);
  } catch (error) {
    return json({ ok: false, error: error instanceof Error ? error.message : "无法提交反馈" }, 400);
  }
}

async function handleAi(request, env, url) {
  const auth = await authenticatedAccount(request, env);
  if (auth.response) return auth.response;
  try {
    if (url.pathname === "/api/ai/vision/agree" && request.method === "POST") {
      return json({ ok: true, ...(await acceptVisionLicense(env, auth.account)) });
    }
    if (url.pathname === "/api/ai/probe" && request.method === "POST") {
      if (auth.account.role !== "admin") return json({ ok: false, error: "Admin access is required" }, 403);
      const result = await env.AI.run("@cf/meta/llama-3.1-8b-instruct-fast", {
        messages: [{ role: "user", content: "这是 API 连通性测试。请只回复 OK。" }],
        max_tokens: 8,
        temperature: 0,
      });
      return json({ ok: true, response: String(result?.response ?? ""), userDataSent: false });
    }
    if (url.pathname === "/api/ai/conversation") {
      if (request.method === "GET") return json({ ok: true, ...(await aiConversation(env, auth.account)) });
      if (request.method === "DELETE") return json({ ok: true, ...(await clearAiConversation(env, auth.account.id)) });
    }
    if (url.pathname === "/api/ai/memory" && request.method === "PUT") {
      const body = await requestJson(request);
      return json({ ok: true, memory: await saveAiMemory(env, auth.account.id, body.content) });
    }
    if (url.pathname === "/api/ai/context" && request.method === "PUT") {
      const body = await requestJson(request);
      return json({ ok: true, ...(await saveAiContext(env, auth.account.id, body.context)) });
    }
    if (url.pathname === "/api/ai/context/reset" && request.method === "POST") {
      return json({ ok: true, ...(await resetAiContext(env, auth.account.id)) });
    }
    if (url.pathname === "/api/ai/diagnostic-consent" && request.method === "PUT") {
      const body = await requestJson(request);
      return json({ ok: true, ...(await setAiDiagnosticOptIn(env, auth.account.id, body.enabled === true)) });
    }
    if (url.pathname === "/api/ai/chat" && request.method === "POST") {
      const body = await requestJson(request);
      return json({ ok: true, ...(await sendAiMessage(env, auth.account, body.message, body.attachmentText, body.images)) });
    }
    if (url.pathname === "/api/ai/chat/stop" && request.method === "POST") {
      return json({ ok: true, ...(await stopAiTurn(env, auth.account)) });
    }
    if (url.pathname === "/api/ai/calendar/deploy" && request.method === "POST") {
      const body = await requestJson(request);
      return json({ ok: true, ...(await deployAiCalendar(env, auth.account, String(body.proposalId ?? ""))) });
    }
    if (url.pathname === "/api/ai/calendar/discard" && request.method === "POST") {
      const body = await requestJson(request);
      return json({ ok: true, ...(await discardAiCalendar(env, auth.account.id, String(body.proposalId ?? ""))) });
    }
    return json({ ok: false, error: "Method not allowed" }, 405);
  } catch (error) {
    console.error("AI request failed", error);
    return json({ ok: false, error: error instanceof Error ? error.message : "AI request failed" }, 400);
  }
}

export default {
  async fetch(request, env, context) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/") && !isSameOriginMutation(request, url)) {
      return json({ ok: false, error: "Cross-site request rejected" }, 403);
    }

    const mapTile = await handleMapTile(request, url, context);
    if (mapTile) return mapTile;

    if (url.pathname === "/api/health") {
      let database = { ok: false, schemaVersion: null };
      try {
        const row = await env.DB.prepare(
          "SELECT value FROM system_meta WHERE key = 'schema_version'",
        ).first();
        database = { ok: true, schemaVersion: row?.value ?? "unknown" };
      } catch {
        database = { ok: false, schemaVersion: null };
      }
      return json({
        ok: true,
        stage: 5,
        environment: "preview",
        timestamp: new Date().toISOString(),
        colo: request.cf?.colo ?? null,
        database,
      });
    }

    if (url.pathname === "/api/progress") {
      return json({
        stage: 5,
        release: "stage-5-attendance-admin",
        milestones: [
          { id: "public-shell", label: "公开网站", status: "complete" },
          { id: "database", label: "D1 数据基础", status: "complete" },
          { id: "tenant-isolation", label: "多租户隔离", status: "complete" },
          { id: "registration", label: "原生账户登录", status: "in_progress" },
          { id: "cookie-login", label: "扫码 Cookie", status: "ready_for_test" },
          { id: "executor", label: "签到执行器", status: "ready_for_test" },
          { id: "admin", label: "脱敏 Admin", status: "complete" },
          { id: "ai", label: "AI 助手", status: "design_ready" },
        ],
      });
    }

    if (url.pathname === "/api/capabilities") {
      return json({
        publicWebsite: true,
        registration: true,
        cookieLogin: true,
        scheduler: true,
        readOnlyChecks: true,
        attendanceRequests: true,
        aiChat: true,
        databaseFoundation: true,
        tenantIsolation: "native_session",
        authentication: "native-password-session",
        accessRequired: false,
        note: "Attendance writes require each account to explicitly enable its independent safety switch.",
      });
    }

    if (url.pathname === "/api/auth/status") {
      return json({
        ok: true,
        configured: true,
        provider: "native-session",
      });
    }

    if (url.pathname === "/api/auth/session") return handleNativeAuth(request, env, "session");
    if (url.pathname === "/api/auth/register") return handleNativeAuth(request, env, "register");
    if (url.pathname === "/api/auth/login") return handleNativeAuth(request, env, "login");
    if (url.pathname === "/api/auth/logout") return handleNativeAuth(request, env, "logout");
    if (url.pathname === "/api/auth/recover") return handleNativeAuth(request, env, "recover");

    if (url.pathname === "/api/account/me") {
      const auth = await authenticatedAccount(request, env);
      if (auth.response) return auth.response;
      return json({ ok: true, authenticated: true, registered: true, account: auth.account });
    }

    if (url.pathname === "/api/documents/settings") {
      return handleDocumentRequest(request, env, "settings");
    }

    if (url.pathname === "/api/documents/calendar") {
      return handleDocumentRequest(request, env, "calendar");
    }

    if (url.pathname === "/api/credentials") {
      return handleCredentialRequest(request, env);
    }

    if (url.pathname === "/api/pushplus/test") return handlePushplusTest(request, env);

    if (url.pathname === "/api/login/start") {
      return handleLoginStart(request, env);
    }

    if (url.pathname === "/api/login/poll") {
      return handleLoginPoll(request, env, url);
    }

    if (url.pathname === "/api/read-only/check") {
      return handleReadOnlyCheck(request, env);
    }

    if (url.pathname === "/api/read-only/observations") {
      const auth = await authenticatedAccount(request, env);
      if (auth.response) return auth.response;
      if (request.method !== "GET") return json({ ok: false, error: "Method not allowed" }, 405);
      return json({ ok: true, observations: await recentObservations(env, auth.account.id) });
    }

    if (url.pathname === "/api/attendance/run") return handleAttendanceRun(request, env);

    if (url.pathname === "/api/attendance/logs") {
      const auth = await authenticatedAccount(request, env);
      if (auth.response) return auth.response;
      if (request.method !== "GET") return json({ ok: false, error: "Method not allowed" }, 405);
      return json({ ok: true, logs: await recentAttendanceLogs(env, auth.account.id) });
    }

    const feedbackImageMatch = /^\/api\/feedback\/([0-9a-f-]{36})\/images$/i.exec(url.pathname);
    if (feedbackImageMatch) {
      const auth = await authenticatedAccount(request, env);
      if (auth.response) return auth.response;
      if (request.method !== "GET") return json({ ok: false }, 405);
      const images = await feedbackImages(env, auth.account, feedbackImageMatch[1]);
      return new Response(JSON.stringify(images ? { ok: true, images } : { ok: false, error: "反馈不存在" }), {
        status: images ? 200 : 404, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    }
    if (url.pathname === "/api/feedback") return handleFeedback(request, env);

    if (url.pathname.startsWith("/api/admin/")) return handleAdmin(request, env, url);

    if (url.pathname.startsWith("/api/ai/")) return handleAi(request, env, url);

    if (url.pathname.startsWith("/api/")) {
      return json({ error: "Not found" }, 404);
    }

    const response = await env.ASSETS.fetch(request);
    return withSecurityHeaders(response);
  },

  async scheduled(_controller, env) {
    await env.SCHEDULER.getByName("global").fetch("https://scheduler.internal/reconcile", {
      method: "POST",
    });
  },
};

export class ReadOnlyScheduler {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/reconcile") {
      const nextAlarm = await reconcileSchedules(this.env);
      if (nextAlarm) await this.state.storage.setAlarm(new Date(nextAlarm));
      return json({ ok: true, nextAlarm });
    }
    return json({ ok: false, error: "Not found" }, 404);
  }

  async alarm() {
    const nextAlarm = await processDueReads(this.env);
    if (nextAlarm) await this.state.storage.setAlarm(new Date(nextAlarm));
  }
}

export { K8nGateway };
