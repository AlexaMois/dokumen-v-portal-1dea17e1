// Bpium API Integration - v4 with file upload via Bpium Files API

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ID каталогов в Bpium (справочники)
const CATALOG_IDS = {
  documents: '56',      // Документы (загрузка) АТС
  directions: '55',     // Направления АТС
  roles: '57',          // Роли АТС
  projects: '54',       // Проекты АТС
  sources: '59',        // Источники АТС
};

// Правильный маппинг полей для каталога документов (ID=56)
const DOCUMENT_FIELDS = {
  title: '2',             // Название (text)
  file: '3',              // Файл (file, single)
  directions: '4',        // Направление (object, связь с 55, multiselect)
  roles: '5',             // Роли (object, связь с 57, multiselect)
  projects: '6',          // Проекты (object, связь с 54, multiselect)
  artifacts: '10',        // Артефакты (file, multiselect)
  websiteUrl: '11',       // Сайт/ссылка (contact/site)
  status: '12',           // Статус (dropdown: 1=Черновик, 2=На проверке, 3=Утверждён, 4=Отклонён)
  sources: '13',          // Источник (object, связь с 59, single)
  // Поле 14 (checkboxes) больше не используется для тегов
  responsiblePerson: '15', // ФИО ответственного (text)
  submissionDate: '16',   // Дата внесения (date)
  tags: '17',             // AI-теги (text) - УКАЖИТЕ ПРАВИЛЬНЫЙ ID ПОСЛЕ СОЗДАНИЯ ПОЛЯ В BPIUM
};

interface BpiumRecord {
  id: string;
  values: Record<string, unknown>;
}

function getBpiumDomain(): string {
  let domain = Deno.env.get('BPIUM_DOMAIN');
  if (!domain) throw new Error('BPIUM_DOMAIN not configured');
  domain = domain.replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(domain)) {
    domain = `https://${domain}`;
  }
  return domain;
}

function getBpiumAuthHeaders(): { Authorization: string; 'Content-Type': string } {
  const login = Deno.env.get('BPIUM_LOGIN');
  const password = Deno.env.get('BPIUM_PASSWORD');

  if (!login || !password) {
    throw new Error('Bpium credentials not configured');
  }

  const credentials = btoa(`${login}:${password}`);
  
  return {
    'Authorization': `Basic ${credentials}`,
    'Content-Type': 'application/json',
  };
}

// Кешированная сессионная cookie connect.sid
let cachedSessionSid: string | null = null;
let cachedSessionExpiresAt = 0;
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 минут

function extractConnectSid(setCookieHeaders: string[]): string | null {
  for (const header of setCookieHeaders) {
    const parts = header.split(/,(?=\s*\w+=)/); // split multiple cookies
    for (const part of parts) {
      const m = part.match(/connect\.sid=([^;]+)/);
      if (m) return m[1];
    }
  }
  return null;
}

async function loginToBpium(): Promise<string> {
  const login = Deno.env.get('BPIUM_LOGIN');
  const password = Deno.env.get('BPIUM_PASSWORD');
  if (!login || !password) {
    throw new Error('Bpium credentials not configured');
  }

  const domain = getBpiumDomain();
  const url = `${domain}/auth/login`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15_000);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login, password }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new BpiumHttpError(`Bpium login failed: ${response.status} ${text}`, response.status);
    }

    // Deno: getSetCookie() возвращает все Set-Cookie заголовки массивом
    const setCookies =
      typeof (response.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie === 'function'
        ? (response.headers as unknown as { getSetCookie: () => string[] }).getSetCookie()
        : (() => {
            const single = response.headers.get('set-cookie');
            return single ? [single] : [];
          })();

    const sid = extractConnectSid(setCookies);
    if (!sid) {
      throw new BpiumHttpError('Bpium login: connect.sid cookie not found in response', 502);
    }

    // Освобождаем тело
    try { await response.body?.cancel(); } catch (_) { /* noop */ }

    console.log('[bpium-api] Logged in to Bpium, session acquired');
    return sid;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function getBpiumSessionSid(forceRefresh = false): Promise<string> {
  const now = Date.now();
  if (!forceRefresh && cachedSessionSid && cachedSessionExpiresAt > now) {
    return cachedSessionSid;
  }
  cachedSessionSid = await loginToBpium();
  cachedSessionExpiresAt = now + SESSION_TTL_MS;
  return cachedSessionSid;
}

async function getBpiumCookieHeaders(): Promise<{ Cookie: string; 'Content-Type': string }> {
  const sid = await getBpiumSessionSid();
  return {
    Cookie: `connect.sid=${sid}`,
    'Content-Type': 'application/json',
  };
}

// Таймаут по умолчанию для всех запросов к Bpium API (60 сек)
const BPIUM_FETCH_TIMEOUT_MS = 30_000;
// Retry-настройки: до 2 попыток, базовая задержка 500мс с экспоненциальным ростом
const BPIUM_MAX_RETRIES = 2;
const BPIUM_RETRY_BASE_DELAY_MS = 500;

class BpiumHttpError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'BpiumHttpError';
    this.status = status;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Стоит ли повторять попытку при данной ошибке/статусе.
// Повторяем только сетевые ошибки, таймауты и 5xx — не повторяем 4xx (это ошибка клиента).
function shouldRetry(status: number, method: string): boolean {
  if (status === 504 || status === 502 || status === 503 || status === 408 || status === 429) return true;
  if (status >= 500 && status < 600) {
    // Повторяем 5xx только для идемпотентных методов, чтобы не создать дубликаты записей.
    return method === 'GET' || method === 'HEAD';
  }
  return false;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = BPIUM_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const method = (init.method || 'GET').toUpperCase();
  let lastError: BpiumHttpError | null = null;

  for (let attempt = 1; attempt <= BPIUM_MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      const elapsed = Date.now() - startedAt;

      if (!response.ok && shouldRetry(response.status, method) && attempt < BPIUM_MAX_RETRIES) {
        const delay = BPIUM_RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
        console.warn(
          `[bpium-api] ${method} ${url} -> ${response.status} (attempt ${attempt}/${BPIUM_MAX_RETRIES}, ${elapsed}ms). Retrying in ${delay}ms...`,
        );
        // Освобождаем тело перед повтором
        try { await response.body?.cancel(); } catch (_) { /* noop */ }
        await sleep(delay);
        continue;
      }

      if (attempt > 1) {
        console.log(`[bpium-api] ${method} ${url} -> ${response.status} succeeded on attempt ${attempt} (${elapsed}ms)`);
      }
      return response;
    } catch (err) {
      const elapsed = Date.now() - startedAt;
      const isAbort = err instanceof Error && err.name === 'AbortError';
      const status = isAbort ? 504 : 502;
      const message = isAbort
        ? `Bpium request timed out after ${timeoutMs}ms: ${method} ${url}`
        : `Network error calling Bpium (${method} ${url}): ${err instanceof Error ? err.message : 'Unknown fetch error'}`;
      lastError = new BpiumHttpError(message, status);

      const canRetry = (isAbort || method === 'GET' || method === 'HEAD') && attempt < BPIUM_MAX_RETRIES;
      if (canRetry) {
        const delay = BPIUM_RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
        console.warn(
          `[bpium-api] ${method} ${url} failed: ${message} (attempt ${attempt}/${BPIUM_MAX_RETRIES}, ${elapsed}ms). Retrying in ${delay}ms...`,
        );
        await sleep(delay);
        continue;
      }
      console.error(`[bpium-api] ${method} ${url} failed permanently after ${attempt} attempt(s): ${message}`);
      throw lastError;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // Если все попытки исчерпаны на ретраях по статусу — формируем итоговую ошибку
  throw lastError ?? new BpiumHttpError(`Bpium request failed after ${BPIUM_MAX_RETRIES} attempts: ${method} ${url}`, 502);
}

async function fetchCatalog(headers: Record<string, string>, catalogId: string): Promise<BpiumRecord[]> {
  const domain = getBpiumDomain();

  const response = await fetchWithTimeout(`${domain}/api/v1/catalogs/${catalogId}/records`, {
    method: 'GET',
    headers,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new BpiumHttpError(`Failed to fetch catalog ${catalogId}: ${error}`, response.status);
  }

  return await response.json();
}

async function fetchCatalogInfo(headers: Record<string, string>, catalogId: string): Promise<unknown> {
  const domain = getBpiumDomain();

  const response = await fetchWithTimeout(`${domain}/api/v1/catalogs/${catalogId}`, {
    method: 'GET',
    headers,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new BpiumHttpError(`Failed to fetch catalog info ${catalogId}: ${error}`, response.status);
  }

  return await response.json();
}

// Примечание: Bpium Files API возвращает "Not implement yet"
// Используем data URL напрямую для небольших файлов (до 5MB)

async function createRecord(
  headers: { Authorization: string; 'Content-Type': string },
  catalogId: string,
  values: Record<string, unknown>
): Promise<BpiumRecord> {
  const domain = getBpiumDomain();

  const response = await fetchWithTimeout(`${domain}/api/v1/catalogs/${catalogId}/records`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ values }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new BpiumHttpError(`Failed to create record: ${error}`, response.status);
  }

  return await response.json();
}

function transformRecords(records: BpiumRecord[]): { value: string; label: string }[] {
  return records.map(record => ({
    value: record.id,
    label: String(record.values['2'] || record.id),
  }));
}

function levenshteinDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

// In-memory rate limiter per IP (resets on cold start)
const rateBuckets = new Map<string, { count: number; resetAt: number }>();
function checkRateLimit(ip: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const bucket = rateBuckets.get(ip);
  if (!bucket || bucket.resetAt < now) {
    rateBuckets.set(ip, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (bucket.count >= limit) return false;
  bucket.count++;
  return true;
}

function getClientIp(req: Request): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0].trim() ||
    req.headers.get('cf-connecting-ip') ||
    'unknown'
  );
}

// Разрешённые префиксы для публичных ссылок на файлы:
// 1) прямой Supabase Storage домен
// 2) Cloudflare-прокси api.aleksamois.ru, через который проходит весь трафик из РФ
const PROXY_STORAGE_PREFIX = 'https://api.aleksamois.ru/storage/v1/object/public/documents/';

function isValidStorageUrl(url: string): boolean {
  if (typeof url !== 'string') return false;
  if (url.startsWith(PROXY_STORAGE_PREFIX)) return true;

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  if (!supabaseUrl) return false;
  const directPrefix = `${supabaseUrl.replace(/\/+$/, '')}/storage/v1/object/public/documents/`;
  return url.startsWith(directPrefix);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  // Rate limit: 60 requests/minute per IP
  const ip = getClientIp(req);
  if (!checkRateLimit(ip, 60, 60_000)) {
    return new Response(
      JSON.stringify({ error: 'Too many requests, please slow down' }),
      { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  try {
    const url = new URL(req.url);
    const action = url.searchParams.get('action');
    const authHeaders = getBpiumAuthHeaders();

    switch (action) {
      case 'get-catalog-structure': {
        const catalogId = url.searchParams.get('catalogId') || CATALOG_IDS.documents;
        const catalogInfo = await fetchCatalogInfo(authHeaders, catalogId);
        return new Response(JSON.stringify(catalogInfo), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      case 'get-catalogs': {
        // Последовательные запросы с задержкой 300мс между ними, чтобы избежать rate limiting от Bpium
        const directionsRecords = await fetchCatalog(authHeaders, CATALOG_IDS.directions);
        await sleep(300);
        const rolesRecords = await fetchCatalog(authHeaders, CATALOG_IDS.roles);
        await sleep(300);
        const projectsRecords = await fetchCatalog(authHeaders, CATALOG_IDS.projects);
        await sleep(300);
        const sourcesRecords = await fetchCatalog(authHeaders, CATALOG_IDS.sources);

        // Теги теперь генерируются AI и не загружаются из справочника

        const result = {
          directions: transformRecords(directionsRecords),
          roles: transformRecords(rolesRecords),
          projects: transformRecords(projectsRecords),
          sources: transformRecords(sourcesRecords),
          checklists: [], // Нет отдельного каталога чек-листов
        };

        return new Response(JSON.stringify(result), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      case 'check-duplicate': {
        const { documentName } = await req.json();
        if (!documentName || typeof documentName !== 'string') {
          return new Response(
            JSON.stringify({ error: 'documentName is required' }),
            { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }
        const allRecords = await fetchCatalog(authHeaders, CATALOG_IDS.documents);
        const normalizedInput = documentName.trim().toLowerCase();

        const STATUS_MAP: Record<string, string> = {
          '1': 'Черновик',
          '2': 'На проверке',
          '3': 'Утверждён',
          '4': 'Отклонён',
        };

        const toMatch = (r: BpiumRecord) => {
          const statusRaw = r.values['12'];
          const statusId = Array.isArray(statusRaw) ? String(statusRaw[0]) : String(statusRaw || '');
          return {
            id: r.id,
            title: String(r.values['2'] || ''),
            responsiblePerson: String(r.values['15'] || ''),
            submissionDate: String(r.values['16'] || ''),
            status: STATUS_MAP[statusId] || '',
          };
        };

        const exactMatches: ReturnType<typeof toMatch>[] = [];
        const similarMatches: ReturnType<typeof toMatch>[] = [];

        for (const r of allRecords) {
          const title = String(r.values['2'] || '').trim().toLowerCase();
          if (!title) continue;

          if (title === normalizedInput) {
            exactMatches.push(toMatch(r));
            continue;
          }

          // Substring check
          if (normalizedInput.length >= 5 && (title.includes(normalizedInput) || normalizedInput.includes(title))) {
            similarMatches.push(toMatch(r));
            continue;
          }

          // Levenshtein distance check (threshold: 30% of max length)
          const maxLen = Math.max(title.length, normalizedInput.length);
          if (maxLen > 0 && normalizedInput.length >= 5) {
            const dist = levenshteinDistance(title, normalizedInput);
            if (dist <= Math.floor(maxLen * 0.3)) {
              similarMatches.push(toMatch(r));
            }
          }
        }

        return new Response(
          JSON.stringify({ exactMatches, similarMatches }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      case 'submit-document': {
        const body = await req.json();

        // Для полей типа "связанный объект" (object) формат ВСЕГДА массив:
        // [{ catalogId, recordId }, ...]
        // Даже для single-select Bpium ожидает массив с одним элементом
        const toLinkedRecords = (ids: string[] | undefined, catalogId: string) => {
          if (!ids || !Array.isArray(ids) || ids.length === 0) {
            return [];
          }
          return ids.map(id => ({ catalogId, recordId: id }));
        };

        // Формируем значения для записи
        const values: Record<string, unknown> = {};

        // Текстовые поля
        if (body.documentName) values[DOCUMENT_FIELDS.title] = body.documentName;
        if (body.responsiblePerson) values[DOCUMENT_FIELDS.responsiblePerson] = body.responsiblePerson;

        // Связанные объекты (object type) - ВСЕ передаются как массивы
        // Источник — single-select, передаём только первый элемент
        const sources = toLinkedRecords(body.sourceIds, CATALOG_IDS.sources);
        if (sources.length > 0) values[DOCUMENT_FIELDS.sources] = [sources[0]];
        
        const directions = toLinkedRecords(body.directionIds, CATALOG_IDS.directions);
        if (directions.length > 0) values[DOCUMENT_FIELDS.directions] = directions;
        
        const roles = toLinkedRecords(body.roleIds, CATALOG_IDS.roles);
        if (roles.length > 0) values[DOCUMENT_FIELDS.roles] = roles;
        
        const projects = toLinkedRecords(body.projectIds, CATALOG_IDS.projects);
        if (projects.length > 0) values[DOCUMENT_FIELDS.projects] = projects;

        // AI-теги (text) - отправляем как строку через запятую
        if (body.tags && body.tags.length > 0) {
          values[DOCUMENT_FIELDS.tags] = body.tags.join(', ');
        }

        // Сайт/ссылка (contact type) - формат: [{contact: url, comment: ""}]
        if (body.websiteUrl) {
          values[DOCUMENT_FIELDS.websiteUrl] = [{
            contact: body.websiteUrl,
            comment: ""
          }];
        }

        // Дата внесения
        if (body.submissionDate) {
          values[DOCUMENT_FIELDS.submissionDate] = body.submissionDate;
        }

        // Статус - устанавливаем "Черновик" (1) по умолчанию
        values[DOCUMENT_FIELDS.status] = ['1'];

        // Файл - используем URL из Supabase Storage (валидируем префикс, чтобы избежать инъекции произвольных URL)
        if (body.fileUrl) {
          if (typeof body.fileUrl !== 'string' || !isValidStorageUrl(body.fileUrl)) {
            return new Response(
              JSON.stringify({ error: 'Invalid file URL: must be a Supabase Storage public URL for the documents bucket' }),
              { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
            );
          }
          const safeFileName = typeof body.fileName === 'string' ? body.fileName.slice(0, 255) : 'document';
          values[DOCUMENT_FIELDS.file] = [{
            src: body.fileUrl,
            title: safeFileName,
          }];
          console.log(`File attached: ${safeFileName} -> ${body.fileUrl}`);
        }

        console.log('Submitting to Bpium catalog 56:', JSON.stringify({ ...values, [DOCUMENT_FIELDS.file]: '[FILE]' }, null, 2));

        const record = await createRecord(authHeaders, CATALOG_IDS.documents, values);

        return new Response(JSON.stringify({ success: true, recordId: record.id }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      default:
        return new Response(
          JSON.stringify({ error: 'Invalid action. Use: get-catalogs, get-catalog-structure, check-duplicate, submit-document' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
    }
  } catch (error: unknown) {
    console.error('Bpium API error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const status = error instanceof BpiumHttpError ? error.status : 500;
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
