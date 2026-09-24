'use client'

import React, { useState, useMemo } from 'react'
import { Terminal, Code, Maximize2, Minimize2 } from 'lucide-react'
import { CollapsibleColumn, createCollapseButton } from '@/components/notebooks/CollapsibleColumn'
import AgentWorkspace from '@/components/ide/AgentWorkspace'
import { cn } from '@/lib/utils'

interface CodeColumnProps {
  notebookId: string
  isCollapsed: boolean
  onToggleCollapse: () => void
}

export function CodeColumn({
  notebookId,
  isCollapsed,
  onToggleCollapse
}: CodeColumnProps) {
  const [isFullscreen, setIsFullscreen] = useState(false)
  const codeLabel = 'Code & IDE'
  const collapseButton = useMemo(
    () => createCollapseButton(onToggleCollapse, codeLabel),
    [onToggleCollapse, codeLabel]
  )

  if (isFullscreen) {
    return (
      <div className="fixed inset-4 z-50 bg-background border border-border rounded-2xl shadow-2xl overflow-hidden flex flex-col animate-in fade-in zoom-in-95 duration-200">
        <div className="flex items-center justify-between px-4 py-2 bg-muted/40 border-b border-border">
          <div className="flex items-center gap-2 text-xs font-bold text-cyan-400">
            <Terminal size={15} />
            <span>Notebook Embedded IDE — Fullscreen Studio</span>
          </div>
          <button
            onClick={() => setIsFullscreen(false)}
            className="p-1 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground text-xs flex items-center gap-1"
          >
            <Minimize2 size={14} /> Exit Fullscreen
          </button>
        </div>
        <div className="flex-1 overflow-hidden p-2">
          <AgentWorkspace compact={false} notebookId={notebookId} className="h-full" />
        </div>
      </div>
    )
  }

  return (
    <CollapsibleColumn
      isCollapsed={isCollapsed}
      onToggle={onToggleCollapse}
      collapsedIcon={Terminal}
      collapsedLabel={codeLabel}
    >
      <div className="flex flex-col h-full min-h-0 bg-card border border-border rounded-xl overflow-hidden shadow-sm">
        {/* Header Bar */}
        <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-muted/20">
          <div className="flex items-center gap-2">
            <Terminal className="h-4 w-4 text-cyan-400" />
            <span className="text-xs font-bold text-foreground tracking-wide">Code & IDE</span>
          </div>

          <div className="flex items-center gap-1">
            <button
              onClick={() => setIsFullscreen(true)}
              className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              title="Expand to Fullscreen"
            >
              <Maximize2 size={13} />
            </button>
            {collapseButton}
          </div>
        </div>

        {/* Workspace Body */}
        <div className="flex-1 overflow-hidden p-1">
          <AgentWorkspace compact={true} notebookId={notebookId} className="h-full border-0 rounded-lg" />
        </div>
      </div>
    </CollapsibleColumn>
  )
}

