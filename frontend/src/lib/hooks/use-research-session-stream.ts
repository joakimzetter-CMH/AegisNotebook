'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useToast } from '@/lib/hooks/use-toast'
import { useTranslation } from '@/lib/hooks/use-translation'
import { getApiErrorMessage } from '@/lib/utils/error-handler'
import { researchSessionsApi } from '@/lib/api/research-sessions'
import { QUERY_KEYS } from '@/lib/api/query-client'
import { API_TIMEOUT_MS } from '@/lib/api/client'
import { readSSEStream } from '@/lib/hooks/use-sse-stream'
import { ResearchSessionMessage, ResearchSessionStreamEvent } from '@/lib/types/api'

// Same idea as use-notebook-chat.ts's STREAM_IDLE_TIMEOUT_MS: if no bytes
// arrive for this long the connection is treated as dangling and aborted.
// Re-armed on every chunk, not a wall-clock cap - "ask" turns do multiple
// sequential/parallel LLM calls before the first token, so a fixed overall
// timeout would false-positive on a slow-but-alive turn.
const STREAM_IDLE_TIMEOUT_MS = API_TIMEOUT_MS

// How often the growing AI message is flushed into React state while
// streaming - same rationale as use-notebook-chat.ts (MarkdownRenderer
// re-parses on every render).
const STREAM_FLUSH_INTERVAL_MS = 50

export type SessionStage =
  | { stage: 'planning' }
  | { stage: 'searching'; term?: string }
  | { stage: 'writing' }
  | { stage: 'gathering_context' }
  | { stage: 'drafting' }
  | { stage: 'saving' }

export function useResearchSessionStream(sessionId: string) {
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const { t } = useTranslation()

  const [messages, setMessages] = useState<ResearchSessionMessage[]>([])
  const [isSending, setIsSending] = useState(false)
  const [currentStage, setCurrentStage] = useState<SessionStage | null>(null)

  const abortControllerRef = useRef<AbortController | null>(null)
  const streamTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (streamTimeoutRef.current) clearTimeout(streamTimeoutRef.current)
      if (flushTimerRef.current) clearTimeout(flushTimerRef.current)
      abortControllerRef.current?.abort()
    }
  }, [])

  // react-query dedupes this against page.tsx's own useResearchSession(id)
  // call for the same query key - not an extra network request.
  const { data: session, refetch: refetchSession } = useQuery({
    queryKey: QUERY_KEYS.researchSession(sessionId),
    queryFn: () => researchSessionsApi.get(sessionId),
    enabled: !!sessionId,
  })

  useEffect(() => {
    if (session?.messages) {
      setMessages(session.messages)
    }
  }, [session])

  const sendMessage = useCallback(
    async (
      message: string,
      mode: 'ask' | 'generate',
      language?: 'en' | 'sv' | 'bilingual',
      modelOverride?: string
    ) => {
      const userMessage: ResearchSessionMessage = {
        id: `temp-${Date.now()}`,
        type: 'human',
        content: message,
        timestamp: new Date().toISOString(),
      }
      setMessages((prev) => [...prev, userMessage])
      setIsSending(true)
      setCurrentStage(null)

      abortControllerRef.current?.abort()
      abortControllerRef.current = new AbortController()
      const signal = abortControllerRef.current.signal

      let aiMessageId: string | null = null
      let pendingContent = ''
      let committedContent = ''

      const flush = () => {
        flushTimerRef.current = null
        if (!mountedRef.current || pendingContent === committedContent) return
        committedContent = pendingContent
        const id = aiMessageId
        setMessages((prev) =>
          prev.map((m) => (m.id === id ? { ...m, content: committedContent } : m))
        )
      }
      const scheduleFlush = () => {
        if (!flushTimerRef.current) {
          flushTimerRef.current = setTimeout(flush, STREAM_FLUSH_INTERVAL_MS)
        }
      }
      const armIdleTimeout = () => {
        if (streamTimeoutRef.current) clearTimeout(streamTimeoutRef.current)
        if (STREAM_IDLE_TIMEOUT_MS <= 0) return
        streamTimeoutRef.current = setTimeout(() => {
          abortControllerRef.current?.abort()
        }, STREAM_IDLE_TIMEOUT_MS)
      }

      try {
        const body = await researchSessionsApi.streamExecute(
          sessionId,
          { message, mode, language, model_override: modelOverride },
          signal
        )

        let activeDocumentId: string | null | undefined = undefined

        for await (const data of readSSEStream<ResearchSessionStreamEvent>(body, {
          idleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
          onIdleTimeout: () => abortControllerRef.current?.abort(),
        })) {
          if (data.type === 'status') {
            setCurrentStage(
              data.stage === 'searching' ? { stage: 'searching', term: data.term } : { stage: data.stage }
            )
          } else if (data.type === 'token') {
            if (!aiMessageId) {
              aiMessageId = `ai-${Date.now()}`
              pendingContent = data.content
              const id = aiMessageId
              setMessages((prev) => [
                ...prev,
                { id, type: 'ai', content: '', timestamp: new Date().toISOString() },
              ])
            } else {
              pendingContent += data.content
            }
            scheduleFlush()
          } else if (data.type === 'ai_message') {
            setCurrentStage(null)
            if (flushTimerRef.current) {
              clearTimeout(flushTimerRef.current)
              flushTimerRef.current = null
            }
            if (aiMessageId) {
              const id = aiMessageId
              setMessages((prev) =>
                prev.map((m) => (m.id === id ? { ...m, content: data.content } : m))
              )
            } else {
              // No 'token' events arrived (fully-buffering provider) - create
              // the bubble now with the complete content.
              aiMessageId = `ai-${Date.now()}`
              setMessages((prev) => [
                ...prev,
                {
                  id: aiMessageId as string,
                  type: 'ai',
                  content: data.content,
                  timestamp: new Date().toISOString(),
                },
              ])
            }
          } else if (data.type === 'complete') {
            activeDocumentId = data.active_document_id
          } else if (data.type === 'error') {
            throw new Error(data.message || 'Stream error occurred')
          }
          // 'user_message': no UI action needed here - the optimistic bubble
          // is already in state.
        }

        if (streamTimeoutRef.current) {
          clearTimeout(streamTimeoutRef.current)
          streamTimeoutRef.current = null
        }

        queryClient.invalidateQueries({ queryKey: QUERY_KEYS.researchSessions })
        if (activeDocumentId) {
          queryClient.invalidateQueries({
            queryKey: QUERY_KEYS.researchSessionDocuments(sessionId),
          })
          queryClient.invalidateQueries({
            queryKey: QUERY_KEYS.generatedDocument(activeDocumentId),
          })
        }
        await refetchSession()
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          await refetchSession().catch(() => {})
        } else {
          console.error('Error sending research session message:', err)
          toast({
            title: t('common.error'),
            description: getApiErrorMessage(err, t, 'apiErrors.failedToSendMessage'),
            variant: 'destructive',
          })
          const streamingId = aiMessageId
          setMessages((prev) =>
            prev.filter((msg) => !msg.id.startsWith('temp-') && msg.id !== streamingId)
          )
        }
      } finally {
        if (streamTimeoutRef.current) {
          clearTimeout(streamTimeoutRef.current)
          streamTimeoutRef.current = null
        }
        if (flushTimerRef.current) {
          clearTimeout(flushTimerRef.current)
          flushTimerRef.current = null
        }
        setCurrentStage(null)
        if (mountedRef.current) setIsSending(false)
      }
    },
    [sessionId, queryClient, refetchSession, toast, t]
  )

  return {
    session,
    messages,
    isSending,
    currentStage,
    sendMessage,
  }
}
