'use client'

import { useState, useCallback, useEffect, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { getApiErrorMessage } from '@/lib/utils/error-handler'
import { useTranslation } from '@/lib/hooks/use-translation'
import { chatApi } from '@/lib/api/chat'
import { QUERY_KEYS } from '@/lib/api/query-client'
import { API_TIMEOUT_MS } from '@/lib/api/client'
import {
  NotebookChatMessage,
  NotebookChatStreamEvent,
  CreateNotebookChatSessionRequest,
  UpdateNotebookChatSessionRequest,
  SourceListResponse,
  NoteResponse
} from '@/lib/types/api'
import { ContextSelections } from '@/app/(dashboard)/notebooks/[id]/page'

// Idle watchdog for the chat SSE stream: if no bytes arrive for this long,
// treat the connection as dangling, abort it and stop the loading state.
// Re-armed on every received chunk (not a wall-clock cap), same idea as
// use-ask.ts's STREAM_IDLE_TIMEOUT_MS - aligned to the same API_TIMEOUT_MS
// budget so slow local models aren't cut off mid-stream.
const STREAM_IDLE_TIMEOUT_MS = API_TIMEOUT_MS

// How often the growing AI message is flushed into React state while
// streaming. MarkdownRenderer fully re-parses on every render, so flushing
// per-token would jank on a fast provider - this caps re-renders to ~20/sec
// regardless of token arrival rate.
const STREAM_FLUSH_INTERVAL_MS = 50

interface UseNotebookChatParams {
  notebookId: string
  sources: SourceListResponse[]
  notes: NoteResponse[]
  contextSelections: ContextSelections
}

export function useNotebookChat({ notebookId, sources, notes, contextSelections }: UseNotebookChatParams) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null)
  const [messages, setMessages] = useState<NotebookChatMessage[]>([])
  const [isSending, setIsSending] = useState(false)
  const [tokenCount, setTokenCount] = useState<number>(0)
  const [charCount, setCharCount] = useState<number>(0)
  // Pending model override for when user changes model before a session exists
  const [pendingModelOverride, setPendingModelOverride] = useState<string | null>(null)

  const abortControllerRef = useRef<AbortController | null>(null)
  const streamTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    // Reset on every (re-)mount, not just via the useRef initializer - under
    // React StrictMode's dev-only mount->cleanup->mount double-invoke, the
    // cleanup below runs once immediately, and without this the ref would be
    // stuck at `false` for the rest of the component's real lifetime, making
    // the `if (mountedRef.current) setIsSending(false)` guard in sendMessage
    // silently no-op forever (composer stays disabled after every message).
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (streamTimeoutRef.current) clearTimeout(streamTimeoutRef.current)
      if (flushTimerRef.current) clearTimeout(flushTimerRef.current)
      abortControllerRef.current?.abort()
    }
  }, [])

  // Fetch sessions for this notebook
  const {
    data: sessions = [],
    isLoading: loadingSessions,
    refetch: refetchSessions
  } = useQuery({
    queryKey: QUERY_KEYS.notebookChatSessions(notebookId),
    queryFn: () => chatApi.listSessions(notebookId),
    enabled: !!notebookId
  })

  // Fetch current session with messages
  const {
    data: currentSession,
    refetch: refetchCurrentSession
  } = useQuery({
    queryKey: QUERY_KEYS.notebookChatSession(currentSessionId!),
    queryFn: () => chatApi.getSession(currentSessionId!),
    enabled: !!notebookId && !!currentSessionId
  })

  // Update messages when current session changes
  useEffect(() => {
    if (currentSession?.messages) {
      setMessages(currentSession.messages)
    }
  }, [currentSession])

  // Auto-select most recent session when sessions are loaded
  useEffect(() => {
    if (sessions.length > 0 && !currentSessionId) {
      // Sessions are sorted by created date desc from API
      const mostRecentSession = sessions[0]
      setCurrentSessionId(mostRecentSession.id)
    }
  }, [sessions, currentSessionId])

  // Create session mutation
  const createSessionMutation = useMutation({
    mutationFn: (data: CreateNotebookChatSessionRequest) =>
      chatApi.createSession(data),
    onSuccess: (newSession) => {
      queryClient.invalidateQueries({
        queryKey: QUERY_KEYS.notebookChatSessions(notebookId)
      })
      setCurrentSessionId(newSession.id)
      toast.success(t('chat.sessionCreated'))
    },
    onError: (err: unknown) => {
      const error = err as { response?: { data?: { detail?: string } }, message?: string };
      toast.error(getApiErrorMessage(error.response?.data?.detail || error.message, (key) => t(key), 'apiErrors.failedToCreateSession'))
    }
  })

  // Update session mutation
  const updateSessionMutation = useMutation({
    mutationFn: ({ sessionId, data }: {
      sessionId: string
      data: UpdateNotebookChatSessionRequest
    }) => chatApi.updateSession(sessionId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: QUERY_KEYS.notebookChatSessions(notebookId)
      })
      queryClient.invalidateQueries({
        queryKey: QUERY_KEYS.notebookChatSession(currentSessionId!)
      })
      toast.success(t('chat.sessionUpdated'))
    },
    onError: (err: unknown) => {
      const error = err as { response?: { data?: { detail?: string } }, message?: string };
      toast.error(getApiErrorMessage(error.response?.data?.detail || error.message, (key) => t(key), 'apiErrors.failedToUpdateSession'))
    }
  })

  // Delete session mutation
  const deleteSessionMutation = useMutation({
    mutationFn: (sessionId: string) =>
      chatApi.deleteSession(sessionId),
    onSuccess: (_, deletedId) => {
      queryClient.invalidateQueries({
        queryKey: QUERY_KEYS.notebookChatSessions(notebookId)
      })
      if (currentSessionId === deletedId) {
        setCurrentSessionId(null)
        setMessages([])
      }
      toast.success(t('chat.sessionDeleted'))
    },
    onError: (err: unknown) => {
      const error = err as { response?: { data?: { detail?: string } }, message?: string };
      toast.error(getApiErrorMessage(error.response?.data?.detail || error.message, (key) => t(key), 'apiErrors.failedToDeleteSession'))
    }
  })

  // Build context from sources and notes based on user selections
  const buildContext = useCallback(async () => {
    // Build context_config mapping IDs to selection modes
    const context_config: { sources: Record<string, string>, notes: Record<string, string> } = {
      sources: {},
      notes: {}
    }

    // Map source selections
    sources.forEach(source => {
      const mode = contextSelections.sources[source.id]
      if (mode === 'insights') {
        context_config.sources[source.id] = 'insights'
      } else if (mode === 'full') {
        context_config.sources[source.id] = 'full content'
      } else {
        context_config.sources[source.id] = 'not in'
      }
    })

    // Map note selections
    notes.forEach(note => {
      const mode = contextSelections.notes[note.id]
      if (mode === 'full') {
        context_config.notes[note.id] = 'full content'
      } else {
        context_config.notes[note.id] = 'not in'
      }
    })

    // Call API to build context with actual content
    const response = await chatApi.buildContext({
      notebook_id: notebookId,
      context_config
    })

    // Store token and char counts
    setTokenCount(response.token_count)
    setCharCount(response.char_count)

    return response.context
  }, [notebookId, sources, notes, contextSelections])

  // Send message with token-level SSE streaming
  const sendMessage = useCallback(async (message: string, modelOverride?: string) => {
    let sessionId = currentSessionId

    // Auto-create session if none exists
    if (!sessionId) {
      try {
        const defaultTitle = message.length > 30
          ? `${message.substring(0, 30)}...`
          : message
        const newSession = await chatApi.createSession({
          notebook_id: notebookId,
          title: defaultTitle,
          // Include pending model override when creating session
          model_override: pendingModelOverride ?? undefined
        })
        sessionId = newSession.id
        setCurrentSessionId(sessionId)
        // Clear pending model override now that it's applied to the session
        setPendingModelOverride(null)
        queryClient.invalidateQueries({
          queryKey: QUERY_KEYS.notebookChatSessions(notebookId)
        })
      } catch (err: unknown) {
        const error = err as { response?: { data?: { detail?: string } }, message?: string };
        toast.error(getApiErrorMessage(error.response?.data?.detail || error.message, (key) => t(key), 'apiErrors.failedToCreateSession'))
        return
      }
    }

    // Add user message optimistically
    const userMessage: NotebookChatMessage = {
      id: `temp-${Date.now()}`,
      type: 'human',
      content: message,
      timestamp: new Date().toISOString()
    }
    setMessages(prev => [...prev, userMessage])
    setIsSending(true)

    // Abort any previous in-flight stream before starting a new one
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
      setMessages(prev => prev.map(m => (m.id === id ? { ...m, content: committedContent } : m)))
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
      // Build context and open the stream
      const context = await buildContext()
      armIdleTimeout()
      const body = await chatApi.streamMessage(
        sessionId,
        {
          message,
          context,
          model_override: modelOverride ?? (currentSession?.model_override ?? undefined)
        },
        signal
      )

      const reader = body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        // Activity on the connection - reset the idle watchdog.
        armIdleTimeout()

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        // Keep the last incomplete line in buffer for the next read.
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          try {
            const jsonStr = line.slice(6).trim()
            if (!jsonStr) continue
            const data: NotebookChatStreamEvent = JSON.parse(jsonStr)

            if (data.type === 'token_delta') {
              if (!aiMessageId) {
                aiMessageId = `ai-${Date.now()}`
                pendingContent = data.content
                const id = aiMessageId
                setMessages(prev => [
                  ...prev,
                  { id, type: 'ai', content: '', timestamp: new Date().toISOString() }
                ])
              } else {
                pendingContent += data.content
              }
              scheduleFlush()
            } else if (data.type === 'ai_message') {
              if (flushTimerRef.current) {
                clearTimeout(flushTimerRef.current)
                flushTimerRef.current = null
              }
              if (aiMessageId) {
                const id = aiMessageId
                setMessages(prev => prev.map(m => (m.id === id ? { ...m, content: data.content } : m)))
              } else {
                // Provider never emitted a token_delta (fully-buffering) -
                // create the bubble now with the complete content.
                aiMessageId = `ai-${Date.now()}`
                setMessages(prev => [
                  ...prev,
                  { id: aiMessageId as string, type: 'ai', content: data.content, timestamp: new Date().toISOString() }
                ])
              }
            } else if (data.type === 'error') {
              throw new Error(data.message || 'Stream error occurred')
            }
            // 'user_message' / 'complete': no UI action needed here.
          } catch (e) {
            if (e instanceof SyntaxError) {
              console.error('Error parsing SSE data:', e, 'Line:', line)
            } else {
              throw e
            }
          }
        }
      }

      if (streamTimeoutRef.current) {
        clearTimeout(streamTimeoutRef.current)
        streamTimeoutRef.current = null
      }
      await refetchCurrentSession()
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        // Idle-timeout or intentional abort - reconcile with whatever was
        // actually persisted rather than leaving a possibly-partial bubble.
        await refetchCurrentSession().catch(() => {})
      } else {
        const error = err as { response?: { data?: { detail?: string } }, message?: string };
        console.error('Error sending message:', error)
        toast.error(getApiErrorMessage(error.response?.data?.detail || error.message, (key) => t(key), 'apiErrors.failedToSendMessage'))
        // Remove the optimistic human message and any partial AI bubble.
        const streamingId = aiMessageId
        setMessages(prev => prev.filter(msg => !msg.id.startsWith('temp-') && msg.id !== streamingId))
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
      if (mountedRef.current) setIsSending(false)
    }
  }, [
    notebookId,
    currentSessionId,
    currentSession,
    pendingModelOverride,
    buildContext,
    refetchCurrentSession,
    queryClient,
    t
  ])

  // Switch session
  const switchSession = useCallback((sessionId: string) => {
    setCurrentSessionId(sessionId)
  }, [])

  // Create session
  const createSession = useCallback((title?: string) => {
    return createSessionMutation.mutate({
      notebook_id: notebookId,
      title
    })
  }, [createSessionMutation, notebookId])

  // Update session
  const updateSession = useCallback((sessionId: string, data: UpdateNotebookChatSessionRequest) => {
    return updateSessionMutation.mutate({
      sessionId,
      data
    })
  }, [updateSessionMutation])

  // Delete session
  const deleteSession = useCallback((sessionId: string) => {
    return deleteSessionMutation.mutate(sessionId)
  }, [deleteSessionMutation])

  // Set model override - handles both existing sessions and pending state
  const setModelOverride = useCallback((model: string | null) => {
    if (currentSessionId) {
      // Session exists - update it directly
      updateSessionMutation.mutate({
        sessionId: currentSessionId,
        data: { model_override: model }
      })
    } else {
      // No session yet - store as pending
      setPendingModelOverride(model)
    }
  }, [currentSessionId, updateSessionMutation])

  // Update token/char counts when context selections change
  useEffect(() => {
    const updateContextCounts = async () => {
      try {
        await buildContext()
      } catch (error) {
        console.error('Error updating context counts:', error)
      }
    }
    updateContextCounts()
  }, [buildContext])

  return {
    // State
    sessions,
    currentSession: currentSession || sessions.find(s => s.id === currentSessionId),
    currentSessionId,
    messages,
    isSending,
    loadingSessions,
    tokenCount,
    charCount,
    pendingModelOverride,

    // Actions
    createSession,
    updateSession,
    deleteSession,
    switchSession,
    sendMessage,
    setModelOverride,
    refetchSessions
  }
}
