# Cloudflare Worker — `bpium-api-proxy`

Прокси к Bpium API (`ats.bpium.ru`) с инжектом Basic Auth из секретов Worker'а.
Кастомный домен: `bpium.aleksamois.ru`.

## Что делает

- Принимает `https://bpium.aleksamois.ru/api/*`
- Подставляет `Authorization: Basic base64(BPIUM_LOGIN:BPIUM_PASSWORD)`
- Проксирует на `https://ats.bpium.ru/api/*` 1:1 (метод, путь, query, тело)
- Отдаёт ответ обратно клиенту с корректными CORS-заголовками
- Любой путь, кроме `/api/*`, → `404`

Логин/пароль Bpium **никогда** не попадают в браузер.

## Деплой

Конфиг — `wrangler.toml` в корне проекта.

```bash
npm i -g wrangler
wrangler login

# секреты (вводятся интерактивно, в репо не коммитятся)
wrangler secret put BPIUM_LOGIN
wrangler secret put BPIUM_PASSWORD

wrangler deploy
```

После первого деплоя в Cloudflare Dashboard:
**Workers & Pages → `bpium-api-proxy` → Settings → Domains & Routes → Add Custom Domain → `bpium.aleksamois.ru`**.

## Проверка

```bash
curl -i https://bpium.aleksamois.ru/api/catalogs/56
# должен вернуть JSON каталога 56 со статусом 200
```

Если `403` / `401` — проверь секреты (`wrangler secret list`).
Если `502 Upstream fetch failed` — Bpium не ответил, повтори запрос.

## Обновление

Поправил `worker.js` → `wrangler deploy`. Всё.

## Связь с supabase-proxy

Это **отдельный** Worker. `supabase-proxy` (`api.aleksamois.ru`,
`infra/cloudflare-worker/worker.js`) деплоится самостоятельно и не пересекается
с этим конфигом.
