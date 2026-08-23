const ALLOWED_REQUEST_HEADERS = new Set([
  "accept",
  "cache-control",
  "content-type",
  "cookie",
  "referer",
  "user-agent",
  "x-requested-with",
]);

function responseCookies(headers) {
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
  const value = headers.get("set-cookie");
  return value ? [value] : [];
}

function checkedUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "k8n.cn") {
    throw new Error("K8n gateway rejected the destination");
  }
  return url;
}

export async function fetchK8n(env, url, init = {}) {
  const destination = checkedUrl(url);
  const headers = Object.fromEntries(new Headers(init.headers ?? {}).entries());
  const stub = env.K8N_GATEWAY.getByName("k8n-us-egress-v1", {
    locationHint: "wnam",
  });
  const gatewayResponse = await stub.fetch("https://k8n-gateway.internal/fetch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: destination.toString(),
      method: init.method ?? "GET",
      headers,
      redirect: init.redirect ?? "manual",
      timeoutMs: init.timeoutMs ?? 10_000,
      body: init.body ?? null,
    }),
  });
  if (!gatewayResponse.ok) {
    const detail = await gatewayResponse.json().catch(() => ({}));
    throw new Error(detail.error ?? `K8n gateway returned HTTP ${gatewayResponse.status}`);
  }
  const result = await gatewayResponse.json();
  const responseHeaders = new Headers(result.headers ?? {});
  for (const cookie of result.setCookies ?? []) responseHeaders.append("Set-Cookie", cookie);
  return new Response(result.body ?? "", {
    status: result.status,
    statusText: result.statusText,
    headers: responseHeaders,
  });
}

export class K8nGateway {
  async fetch(request) {
    const requestUrl = new URL(request.url);
    if (request.method !== "POST" || requestUrl.pathname !== "/fetch") {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    try {
      const payload = await request.json();
      const destination = checkedUrl(payload.url);
      const method = String(payload.method ?? "GET").toUpperCase();
      const attendancePath = /^\/student\/punchs\/course\/\d{1,20}\/\d{1,30}$/.test(destination.pathname);
      if (method !== "GET" && !(method === "POST" && attendancePath)) {
        return Response.json({ error: "K8n gateway rejected the method or path" }, { status: 405 });
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(payload.headers ?? {})) {
        if (ALLOWED_REQUEST_HEADERS.has(name.toLowerCase())) headers.set(name, String(value));
      }
      const timeoutMs = Math.min(15_000, Math.max(1_000, Number(payload.timeoutMs) || 10_000));
      const body = method === "POST" ? String(payload.body ?? "") : undefined;
      if (body && body.length > 2048) {
        return Response.json({ error: "Attendance request body is too large" }, { status: 413 });
      }
      const upstream = await fetch(destination, {
        method,
        headers,
        body,
        redirect: payload.redirect === "follow" ? "follow" : "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
      return Response.json({
        status: upstream.status,
        statusText: upstream.statusText,
        headers: {
          "content-type": upstream.headers.get("content-type") ?? "text/plain; charset=utf-8",
          location: upstream.headers.get("location") ?? "",
        },
        setCookies: responseCookies(upstream.headers),
        body: await upstream.text(),
      }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      return Response.json({
        error: error instanceof Error ? error.message : "K8n gateway request failed",
      }, { status: 502, headers: { "Cache-Control": "no-store" } });
    }
  }
}
