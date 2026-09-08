'use client'

import { useEffect, useRef, useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ScrollArea } from '@/components/ui/scroll-area'
import { MarkdownRenderer } from '@/components/ui/markdown-renderer'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { Send } from 'lucide-react'
import { useResearchSessionStream, SessionStage } from '@/lib/hooks/use-research-session-stream'
import { useTranslation } from '@/lib/hooks/use-translation'

interface SessionChatProps {
  sessionId: string
  modelOverride?: string | null
}

function stageLabel(stage: SessionStage, t: ReturnType<typeof useTranslation>['t']) {
  switch (stage.stage) {
    case 'planning':
      return t('sessions.stagePlanning')
    case 'searching':
      return stage.term
        ? t('sessions.stageSearchingTerm', { term: stage.term })
        : t('sessions.stageSearching')
    case 'writing':
      return t('sessions.stageWriting')
    case 'gathering_context':
      return t('sessions.stageGatheringContext')
    case 'drafting':
      return t('sessions.stageDrafting')
    case 'saving':
      return t('sessions.stageSaving')
  }
}

export function SessionChat({ sessionId, modelOverride }: SessionChatProps) {
  const { t } = useTranslation()
  const { messages, isSending, currentStage, sendMessage } = useResearchSessionStream(sessionId)
  const [input, setInput] = useState('')
  const [mode, setMode] = useState<'ask' | 'generate'>('ask')
  const [language, setLanguage] = useState<'en' | 'sv' | 'bilingual'>('bilingual')
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, isSending, currentStage])

  const handleSend = () => {
    const trimmed = input.trim()
    if (!trimmed || isSending) return

    sendMessage(
      trimmed,
      mode,
      mode === 'generate' ? language : undefined,
      modelOverride ?? undefined
    )
    setInput('')
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      handleSend()
    }
  }

  // While streaming, the last message is the live AI bubble once tokens
  // start arriving - render everything else as before and let the status
  // line (below) cover the gap before the first token.
  const streamingMessageId =
    isSending && messages.length > 0 && messages[messages.length - 1].type === 'ai'
      ? messages[messages.length - 1].id
      : null

  return (
    <Card className="h-full flex flex-col">
      <CardContent className="flex-1 flex flex-col min-h-0 p-4 gap-4">
        <ScrollArea className="flex-1 min-h-0 pr-2">
          <div className="space-y-4">
            {messages.length === 0 && !isSending && (
              <p className="text-sm text-muted-foreground text-center py-8">
                {t('sessions.noMessages')}
              </p>
            )}
            {messages.map((message) => (
              <div
                key={message.id}
                className={
                  message.type === 'human'
                    ? 'ml-auto max-w-[85%] rounded-lg bg-primary text-primary-foreground px-3 py-2'
                    : 'mr-auto max-w-[85%] rounded-lg bg-muted px-3 py-2'
                }
              >
                {message.type === 'human' ? (
                  <p className="text-sm whitespace-pre-wrap">{message.content}</p>
                ) : message.content ? (
                  <MarkdownRenderer>{message.content}</MarkdownRenderer>
                ) : message.id === streamingMessageId ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <LoadingSpinner size="sm" />
                    {currentStage ? stageLabel(currentStage, t) : t('sessions.thinking')}
                  </div>
                ) : null}
              </div>
            ))}
            {isSending && !streamingMessageId && (
              <div className="mr-auto flex items-center gap-2 text-sm text-muted-foreground">
                <LoadingSpinner size="sm" />
                {currentStage
                  ? stageLabel(currentStage, t)
                  : mode === 'generate'
                    ? t('sessions.generating')
                    : t('sessions.thinking')}
              </div>
            )}
            <div ref={scrollRef} />
          </div>
        </ScrollArea>

        <div className="space-y-3 border-t pt-3">
          <div className="flex flex-wrap items-center gap-4">
            <RadioGroup
              value={mode}
              onValueChange={(value) => setMode(value as 'ask' | 'generate')}
              className="flex flex-row gap-4"
            >
              <div className="flex items-center gap-2">
                <RadioGroupItem value="ask" id="mode-ask" />
                <Label htmlFor="mode-ask" className="cursor-pointer font-normal">
                  {t('sessions.modeAsk')}
                </Label>
              </div>
              <div className="flex items-center gap-2">
                <RadioGroupItem value="generate" id="mode-generate" />
                <Label htmlFor="mode-generate" className="cursor-pointer font-normal">
                  {t('sessions.modeGenerate')}
                </Label>
              </div>
            </RadioGroup>

            {mode === 'generate' && (
              <Select value={language} onValueChange={(value) => setLanguage(value as 'en' | 'sv' | 'bilingual')}>
                <SelectTrigger size="sm" className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="bilingual">{t('sessions.languageBilingual')}</SelectItem>
                  <SelectItem value="en">{t('sessions.languageEnglish')}</SelectItem>
                  <SelectItem value="sv">{t('sessions.languageSwedish')}</SelectItem>
                </SelectContent>
              </Select>
            )}
          </div>

          <div className="flex items-end gap-2">
            <Textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={
                mode === 'generate'
                  ? t('sessions.generatePlaceholder')
                  : t('sessions.askPlaceholder')
              }
              rows={2}
              className="flex-1 resize-none"
            />
            <Button
              onClick={handleSend}
              disabled={!input.trim() || isSending}
              size="icon"
            >
              <Send className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
