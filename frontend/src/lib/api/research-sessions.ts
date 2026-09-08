import apiClient from './client'
import { getAuthToken } from '@/lib/auth-token'
import {
  ResearchSession,
  ResearchSessionWithMessages,
  CreateResearchSessionRequest,
  UpdateResearchSessionRequest,
  ExecuteResearchSessionRequest,
  ExecuteResearchSessionResponse,
  StreamResearchSessionRequest,
  GeneratedDocument,
} from '@/lib/types/api'

export const researchSessionsApi = {
  list: async () => {
    const response = await apiClient.get<ResearchSession[]>('/research-sessions')
    return response.data
  },

  create: async (data: CreateResearchSessionRequest) => {
    const response = await apiClient.post<ResearchSession>('/research-sessions', data)
    return response.data
  },

  get: async (sessionId: string) => {
    const response = await apiClient.get<ResearchSessionWithMessages>(
      `/research-sessions/${sessionId}`
    )
    return response.data
  },

  update: async (sessionId: string, data: UpdateResearchSessionRequest) => {
    const response = await apiClient.put<ResearchSession>(
      `/research-sessions/${sessionId}`,
      data
    )
    return response.data
  },

  delete: async (sessionId: string) => {
    await apiClient.delete(`/research-sessions/${sessionId}`)
  },

  execute: async (data: ExecuteResearchSessionRequest) => {
    const response = await apiClient.post<ExecuteResearchSessionResponse>(
      '/research-sessions/execute',
      data
    )
    return response.data
  },

  // Status + token-level streaming. Raw fetch (not apiClient) so we get the
  // raw ReadableStream body - mirrors chatApi.streamMessage.
  streamExecute: async (
    sessionId: string,
    data: StreamResearchSessionRequest,
    signal?: AbortSignal
  ): Promise<ReadableStream<Uint8Array>> => {
    const token = getAuthToken()
    const url = `/api/research-sessions/${sessionId}/stream`

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token && { Authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify(data),
      signal,
    })

    if (!response.ok) {
      let errorMessage = `HTTP error! status: ${response.status}`
      try {
        const errorData = await response.json()
        errorMessage = errorData.detail || errorData.message || errorMessage
      } catch {
        errorMessage = response.statusText || errorMessage
      }
      throw new Error(errorMessage)
    }

    if (!response.body) {
      throw new Error('No response body received')
    }

    return response.body
  },

  listDocuments: async (sessionId: string) => {
    const response = await apiClient.get<GeneratedDocument[]>(
      `/research-sessions/${sessionId}/documents`
    )
    return response.data
  },
}

export const generatedDocumentsApi = {
  get: async (documentId: string) => {
    const response = await apiClient.get<GeneratedDocument>(
      `/generated-documents/${documentId}`
    )
    return response.data
  },
}

export default researchSessionsApi
