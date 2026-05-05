import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { SUPABASE_BASE_URL, SUPABASE_ANON_KEY } from "@/lib/apiBase";

export interface CatalogOption {
  value: string;
  label: string;
}

interface CatalogsResponse {
  sources: CatalogOption[];
  directions: CatalogOption[];
  roles: CatalogOption[];
  projects: CatalogOption[];
  checklists: CatalogOption[];
}

// Запрос к edge function для получения всех каталогов
async function fetchAllCatalogs(): Promise<CatalogsResponse> {
  const workerUrl = "https://bpium.aleksamois.ru";

  const response = await fetch(`${workerUrl}/api/catalogs`, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to fetch catalogs: ${errorText}`);
  }

  return await response.json();
}

export function useAllCatalogs() {
  const query = useQuery({
    queryKey: ["bpium-catalogs"],
    queryFn: fetchAllCatalogs,
    staleTime: 5 * 60 * 1000, // Кэшируем на 5 минут
    gcTime: 10 * 60 * 1000,
  });

  return {
    sources: { data: query.data?.sources, isLoading: query.isLoading },
    directions: { data: query.data?.directions, isLoading: query.isLoading },
    roles: { data: query.data?.roles, isLoading: query.isLoading },
    projects: { data: query.data?.projects, isLoading: query.isLoading },
    checklists: { data: query.data?.checklists, isLoading: query.isLoading },
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
  };
}

// Проверка дубликатов документа
export interface DuplicateRecord {
  id: string;
  title: string;
  responsiblePerson: string;
  submissionDate: string;
  status?: string;
}

export interface DuplicateResult {
  exactMatches: DuplicateRecord[];
  similarMatches: DuplicateRecord[];
}

export async function checkDocumentDuplicate(documentName: string): Promise<DuplicateResult> {
  const supabaseUrl = SUPABASE_BASE_URL;
  const supabaseKey = SUPABASE_ANON_KEY;

  const response = await fetch(`${supabaseUrl}/functions/v1/bpium-api?action=check-duplicate`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${supabaseKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ documentName }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to check duplicates: ${errorText}`);
  }

  return await response.json();
}

// Отправка документа в Bpium
export async function submitDocumentToBpium(data: {
  documentName: string;
  responsiblePerson: string;
  fileUrl: string;
  fileName: string;
  sourceIds: string[];
  directionIds: string[];
  roleIds: string[];
  projectIds: string[];
  checklistIds: string[];
  tags: string[]; // AI-generated tag names (strings)
  websiteUrl: string | null;
  submissionDate: string;
}): Promise<{ success: boolean; recordId: string }> {
  const supabaseUrl = SUPABASE_BASE_URL;
  const supabaseKey = SUPABASE_ANON_KEY;

  const response = await fetch(`${supabaseUrl}/functions/v1/bpium-api?action=submit-document`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${supabaseKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(data),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to submit document: ${errorText}`);
  }

  return await response.json();
}
