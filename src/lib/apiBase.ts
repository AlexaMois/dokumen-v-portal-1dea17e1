/**
 * Базовый URL для всех обращений к Supabase (REST, Edge Functions, Storage, TUS).
 *
 * Прямой домен *.supabase.co периодически блокируется в РФ, поэтому
 * всё проксируется через Cloudflare Worker на нашем домене.
 *
 * Откат: поставить PROXY_URL = "" — тогда будет использоваться оригинальный
 * VITE_SUPABASE_URL и приложение пойдёт напрямую в Supabase.
 */
const PROXY_URL = "";

export const SUPABASE_BASE_URL: string =
  PROXY_URL || (import.meta.env.VITE_SUPABASE_URL as string);

export const SUPABASE_ANON_KEY: string = import.meta.env
  .VITE_SUPABASE_PUBLISHABLE_KEY as string;

/**
 * Прямой URL Supabase, без прокси.
 *
 * Используется для генерации публичных ссылок на файлы в Storage,
 * которые отправляются во внешние системы (Bpium). Внешним сервисам
 * нет смысла качать файлы через наш Cloudflare-прокси — пусть берут
 * напрямую с *.supabase.co. Дополнительно: Edge Function bpium-api
 * валидирует префикс URL по env SUPABASE_URL и не пропустит ссылку
 * через прокси-домен.
 */
export const SUPABASE_DIRECT_URL: string = import.meta.env
  .VITE_SUPABASE_URL as string;
