import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { researchSessionsApi, generatedDocumentsApi } from '@/lib/api/research-sessions'
import { QUERY_KEYS } from '@/lib/api/query-client'
import { useToast } from '@/lib/hooks/use-toast'
import { useTranslation } from '@/lib/hooks/use-translation'
import { getApiErrorKey } from '@/lib/utils/error-handler'
import {
  CreateResearchSessionRequest,
  UpdateResearchSessionRequest,
} from '@/lib/types/api'

export function useResearchSessions() {
  return useQuery({
    queryKey: QUERY_KEYS.researchSessions,
    queryFn: () => researchSessionsApi.list(),
  })
}

export function useResearchSession(id: string) {
  return useQuery({
    queryKey: QUERY_KEYS.researchSession(id),
    queryFn: () => researchSessionsApi.get(id),
    enabled: !!id,
  })
}

export function useResearchSessionDocuments(id: string) {
  return useQuery({
    queryKey: QUERY_KEYS.researchSessionDocuments(id),
    queryFn: () => researchSessionsApi.listDocuments(id),
    enabled: !!id,
  })
}

export function useGeneratedDocument(id?: string | null) {
  return useQuery({
    queryKey: QUERY_KEYS.generatedDocument(id ?? ''),
    queryFn: () => generatedDocumentsApi.get(id as string),
    enabled: !!id,
  })
}

export function useCreateResearchSession() {
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const { t } = useTranslation()

  return useMutation({
    mutationFn: (data: CreateResearchSessionRequest) => researchSessionsApi.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.researchSessions })
    },
    onError: (error: unknown) => {
      toast({
        title: t('common.error'),
        description: t(getApiErrorKey(error, t('common.error'))),
        variant: 'destructive',
      })
    },
  })
}

export function useUpdateResearchSession() {
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const { t } = useTranslation()

  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateResearchSessionRequest }) =>
      researchSessionsApi.update(id, data),
    onSuccess: (_, { id }) => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.researchSessions })
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.researchSession(id) })
    },
    onError: (error: unknown) => {
      toast({
        title: t('common.error'),
        description: t(getApiErrorKey(error, t('common.error'))),
        variant: 'destructive',
      })
    },
  })
}

export function useDeleteResearchSession() {
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const { t } = useTranslation()

  return useMutation({
    mutationFn: (id: string) => researchSessionsApi.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.researchSessions })
    },
    onError: (error: unknown) => {
      toast({
        title: t('common.error'),
        description: t(getApiErrorKey(error, t('common.error'))),
        variant: 'destructive',
      })
    },
  })
}
