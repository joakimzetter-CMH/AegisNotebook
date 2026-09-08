'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { CheckboxList } from '@/components/ui/checkbox-list'
import { useNotebooks } from '@/lib/hooks/use-notebooks'
import { useCreateResearchSession } from '@/lib/hooks/use-research-sessions'
import { useTranslation } from '@/lib/hooks/use-translation'

interface CreateSessionDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function CreateSessionDialog({ open, onOpenChange }: CreateSessionDialogProps) {
  const { t } = useTranslation()
  const router = useRouter()
  const { data: notebooks, isLoading } = useNotebooks(false)
  const createSession = useCreateResearchSession()

  const [title, setTitle] = useState('')
  const [selectedIds, setSelectedIds] = useState<string[]>([])

  useEffect(() => {
    if (!open) {
      setTitle('')
      setSelectedIds([])
    }
  }, [open])

  const toggleNotebook = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((existing) => existing !== id) : [...prev, id]
    )
  }

  const handleCreate = async () => {
    const session = await createSession.mutateAsync({
      notebook_ids: selectedIds,
      title: title.trim() || undefined,
    })
    onOpenChange(false)
    router.push(`/sessions/${session.id}`)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>{t('sessions.createNew')}</DialogTitle>
          <DialogDescription>{t('sessions.createNewDesc')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="session-title">{t('common.title')}</Label>
            <Input
              id="session-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder={t('sessions.titlePlaceholder')}
              autoComplete="off"
            />
          </div>

          <div className="space-y-2">
            <Label>{t('sessions.selectNotebooks')}</Label>
            <CheckboxList
              items={(notebooks ?? []).map((notebook) => ({
                id: notebook.id,
                title: notebook.name,
                description: notebook.description,
              }))}
              selectedIds={selectedIds}
              onToggle={toggleNotebook}
              loading={isLoading}
              emptyMessage={t('sessions.noNotebooks')}
            />
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button
            type="button"
            disabled={selectedIds.length === 0 || createSession.isPending}
            onClick={handleCreate}
          >
            {createSession.isPending ? t('common.creating') : t('sessions.createNew')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
