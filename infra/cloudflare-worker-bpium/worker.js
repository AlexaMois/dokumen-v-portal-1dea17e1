/**
 * Cloudflare Worker: bpium-api-proxy
 *
 * Прозрачный прокси к Bpium API (ats.bpium.ru) с инжектом Basic Auth
 * из Worker Secrets. Нужен, чтобы:
 *  1) обходить блокировки/нестабильность прямых запросов из РФ-браузеров,
 *  2) не светить логин/пароль Bpium на клиенте,
 *  3) централизованно управлять CORS.
 *
 * Маршруты:
 *   GET/POST/PUT/PATCH/DELETE  https://bpium.aleksamois.ru/api/*
 *     -> https://ats.bpium.ru/api/*
 *
 * Всё, что не /api/*, отдаёт 404. /auth/*, корень и любые другие пути
 * проксироваться не должны — это намеренно.
 *
 * Secrets (задаются через `wrangler secret put` или Dashboard):
 *   BPIUM_LOGIN     — логин пользователя Bpium
 *   BPIUM_PASSWORD  — пароль пользователя Bpium
 *
 * Опциональные vars (можно переопределить в wrangler.toml [vars]):
 *   BPIUM_HOST       — апстрим-хост, по умолчанию "ats.bpium.ru"
 *   ALLOWED_ORIGIN   — если задан, отражается только этот Origin
 */

const DEFAULT_BPIUM_HOST = "ats.bpium.ru";

const ALLOWED_HEADERS = [
  "authorization",
  "content-type",
  "content-length",
  "accept",
  "cache-control",
  "x-requested-with",
].join(", ");

const EXPOSED_HEADERS = [
  "content-type",
  "content-length",
  "content-range",
  "etag",
  "location",
].join(", ");

function corsHeaders(origin, allowedOrigin) {
  const allow = allowedOrigin && allowedOrigin !== "*"
    ? (origin === allowedOrigin ? origin : allowedOrigin)
    : (origin || "*");
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods":
      "GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": ALLOWED_HEADERS,
    "Access-Control-Expose-Headers": EXPOSED_HEADERS,
    "Access-Control-Max-Age": "86400",
    Vary: "Origin, Access-Control-Request-Headers",
  };
}

function jsonResponse(body, status, origin, allowedOrigin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(origin, allowedOrigin),
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function buildBasicAuth(login, password) {
  // btoa доступен в Workers runtime
  return "Basic " + btoa(`${login}:${password}`);
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowedOrigin = env.ALLOWED_ORIGIN || "";

    // CORS preflight — отвечаем сами, без обращения к Bpium
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(origin, allowedOrigin),
      });
    }

    const url = new URL(request.url);

    // Проксируем только /api/*
    if (!url.pathname.startsWith("/api/")) {
      return jsonResponse(
        { error: "Not found", detail: "Only /api/* is proxied" },
        404,
        origin,
        allowedOrigin,
      );
    }

    if (!env.BPIUM_LOGIN || !env.BPIUM_PASSWORD) {
      return jsonResponse(
        {
          error: "Worker misconfigured",
          detail: "BPIUM_LOGIN / BPIUM_PASSWORD secrets are not set",
        },
        500,
        origin,
        allowedOrigin,
      );
    }

    const bpiumHost = env.BPIUM_HOST || DEFAULT_BPIUM_HOST;

    // Собираем апстрим-URL: тот же путь и query, но другой хост
    const upstreamUrl = new URL(url.toString());
    upstreamUrl.hostname = bpiumHost;
    upstreamUrl.protocol = "https:";
    upstreamUrl.port = "";

    // Чистим клиентские заголовки, инжектим Basic Auth
    const upstreamHeaders = new Headers(request.headers);
    upstreamHeaders.delete("origin");
    upstreamHeaders.delete("referer");
    upstreamHeaders.delete("host");
    upstreamHeaders.delete("cookie");
    // Authorization из клиента игнорируем — всегда выставляем свой Basic
    upstreamHeaders.set(
      "Authorization",
      buildBasicAuth(env.BPIUM_LOGIN, env.BPIUM_PASSWORD),
    );
    upstreamHeaders.set("Host", bpiumHost);
    if (!upstreamHeaders.has("accept")) {
      upstreamHeaders.set("Accept", "application/json");
    }

    const hasBody = request.method !== "GET" && request.method !== "HEAD";

    const proxied = new Request(upstreamUrl.toString(), {
      method: request.method,
      headers: upstreamHeaders,
      body: hasBody ? request.body : undefined,
      redirect: "manual",
      ...(hasBody ? { duplex: "half" } : {}),
    });

    let response;
    try {
      response = await fetch(proxied);
    } catch (err) {
      return jsonResponse(
        { error: "Upstream fetch failed", detail: String(err) },
        502,
        origin,
        allowedOrigin,
      );
    }

    const headers = new Headers(response.headers);
    // Убираем Set-Cookie от Bpium (мы работаем по Basic, cookie не нужны клиенту)
    headers.delete("set-cookie");
    for (const [k, v] of Object.entries(corsHeaders(origin, allowedOrigin))) {
      headers.set(k, v);
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};
