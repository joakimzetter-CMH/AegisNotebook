'use client'

import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { EmptyState } from '@/components/common/EmptyState'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { MarkdownRenderer } from '@/components/ui/markdown-renderer'
import { FileText } from 'lucide-react'
import { useResearchSessionDocuments } from '@/lib/hooks/use-research-sessions'
import { useTranslation } from '@/lib/hooks/use-translation'
import { GeneratedDocument } from '@/lib/types/api'

interface GeneratedDocumentsPanelProps {
  sessionId: string
}

export function GeneratedDocumentsPanel({ sessionId }: GeneratedDocumentsPanelProps) {
  const { t } = useTranslation()
  const { data: documents, isLoading } = useResearchSessionDocuments(sessionId)
  const [selectedDocument, setSelectedDocument] = useState<GeneratedDocument | null>(null)

  return (
    <Card className="h-full flex flex-col">
      <CardHeader className="flex-shrink-0 pb-3">
        <CardTitle className="text-base">{t('sessions.generatedDocuments')}</CardTitle>
      </CardHeader>
      <CardContent className="flex-1 min-h-0 p-4 pt-0">
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <LoadingSpinner />
          </div>
        ) : !documents || documents.length === 0 ? (
          <EmptyState
            icon={FileText}
            title={t('sessions.noDocuments')}
            description={t('sessions.noDocumentsDesc')}
          />
        ) : (
          <ScrollArea className="h-full">
            <div className="space-y-2">
              {documents.map((document) => (
                <button
                  key={document.id}
                  onClick={() => setSelectedDocument(document)}
                  className="w-full text-left border border-border rounded-md p-3 hover:bg-muted transition-colors"
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-sm font-medium line-clamp-2">{document.title}</span>
                    <Badge variant="secondary" className="flex-shrink-0">
                      v{document.version}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    {t('common.updated', { time: new Date(document.updated).toLocaleString() })}
                  </p>
                </button>
              ))}
            </div>
          </ScrollArea>
        )}
      </CardContent>

      <Dialog open={!!selectedDocument} onOpenChange={(open) => !open && setSelectedDocument(null)}>
        <DialogContent className="sm:max-w-[800px] max-h-[85vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {selectedDocument?.title}
              {selectedDocument && (
                <Badge variant="secondary">v{selectedDocument.version}</Badge>
              )}
            </DialogTitle>
          </DialogHeader>
          <ScrollArea className="flex-1 min-h-0">
            {selectedDocument && (
              <MarkdownRenderer>{selectedDocument.content}</MarkdownRenderer>
            )}
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
