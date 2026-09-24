'use client';

import { AppShell } from '@/components/layout/AppShell';
import AgentWorkspace from '@/components/ide/AgentWorkspace';

export default function GlobalIDEPage() {
  return (
    <AppShell>
      <div className="flex-1 p-4 md:p-6 overflow-hidden flex flex-col min-h-0 bg-background">
        <AgentWorkspace className="flex-1 shadow-2xl" />
      </div>
    </AppShell>
  );
}

