import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface NotebookColumnsState {
  sourcesCollapsed: boolean
  notesCollapsed: boolean
  codeCollapsed: boolean
  toggleSources: () => void
  toggleNotes: () => void
  toggleCode: () => void
  setSources: (collapsed: boolean) => void
  setNotes: (collapsed: boolean) => void
  setCode: (collapsed: boolean) => void
}

export const useNotebookColumnsStore = create<NotebookColumnsState>()(
  persist(
    (set) => ({
      sourcesCollapsed: false,
      notesCollapsed: false,
      codeCollapsed: true,
      toggleSources: () => set((state) => ({ sourcesCollapsed: !state.sourcesCollapsed })),
      toggleNotes: () => set((state) => ({ notesCollapsed: !state.notesCollapsed })),
      toggleCode: () => set((state) => ({ codeCollapsed: !state.codeCollapsed })),
      setSources: (collapsed) => set({ sourcesCollapsed: collapsed }),
      setNotes: (collapsed) => set({ notesCollapsed: collapsed }),
      setCode: (collapsed) => set({ codeCollapsed: collapsed }),
    }),
    {
      name: 'notebook-columns-storage',
    }
  )
)
