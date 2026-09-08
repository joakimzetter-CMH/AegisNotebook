'use client'

import { useParams } from 'next/navigation'
import { AppShell } from '@/components/layout/AppShell'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { Badge } from '@/components/ui/badge'
import { InlineEdit } from '@/components/common/InlineEdit'
import { SessionChat } from '../components/SessionChat'
import { GeneratedDocumentsPanel } from '../components/GeneratedDocumentsPanel'
import { useResearchSession, useUpdateResearchSession } from '@/lib/hooks/use-research-sessions'
import { useNotebooks } from '@/lib/hooks/use-notebooks'
import { useTranslation } from '@/lib/hooks/use-translation'

export default function ResearchSessionPage() {
  const { t } = useTranslation()
  const params = useParams()
  const sessionId = params?.id ? decodeURIComponent(params.id as string) : ''

  const { data: session, isLoading } = useResearchSession(sessionId)
  const { data: notebooks } = useNotebooks(false)
  const updateSession = useUpdateResearchSession()

  const notebookNames = (session?.notebook_ids ?? []).map(
    (id) => notebooks?.find((notebook) => notebook.id === id)?.name ?? id
  )

  const handleUpdateTitle = async (title: string) => {
    if (!title || !session || title === session.title) return
    await updateSession.mutateAsync({ id: sessionId, data: { title } })
  }

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <LoadingSpinner size="lg" />
      </div>
    )
  }

  if (!session) {
    return (
      <AppShell>
        <div className="p-6">
          <h1 className="text-2xl font-bold mb-4">{t('sessions.notFound')}</h1>
          <p className="text-muted-foreground">{t('sessions.notFoundDesc')}</p>
        </div>
      </AppShell>
    )
  }

  return (
    <AppShell>
      <div className="flex flex-col flex-1 min-h-0">
        <div className="flex-shrink-0 p-6 pb-4 space-y-2">
          <InlineEdit
            value={session.title}
            onSave={handleUpdateTitle}
            className="font-display text-2xl font-bold tracking-tight"
          />
          <div className="flex flex-wrap gap-2">
            {notebookNames.map((name) => (
              <Badge key={name} variant="secondary">
                {name}
              </Badge>
            ))}
          </div>
        </div>

        <div className="flex-1 p-6 pt-0 overflow-hidden">
          <div className="h-full flex flex-col lg:flex-row gap-6 min-h-0">
            <div className="flex-1 min-w-0 min-h-0">
              <SessionChat
                sessionId={sessionId}
                modelOverride={session.model_override}
              />
            </div>
            <div className="lg:w-96 flex-shrink-0 min-h-0">
              <GeneratedDocumentsPanel sessionId={sessionId} />
            </div>
          </div>
        </div>
      </div>
    </AppShell>
  )
}
