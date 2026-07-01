import { useState, useRef, useEffect } from 'react'
import { ChevronDown, Plus, Trash2, Map, Pencil, Check, X } from 'lucide-react'
import { useStore } from '../../store/useStore'

interface AdventureMenuProps {
  onBeforeSwitch?: () => void
  onCreateAdventure?: () => void
}

export default function AdventureMenu({ onBeforeSwitch, onCreateAdventure }: AdventureMenuProps) {
  const {
    adventures,
    activeAdventureId,
    setActiveAdventureId,
    deleteAdventure,
    renameAdventure,
  } = useStore()

  const [open, setOpen] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const menuRef = useRef<HTMLDivElement>(null)

  const activeAdventure = adventures.find((a) => a.id === activeAdventureId)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false)
        setRenamingId(null)
      }
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [open])

  const startRename = (id: string, name: string) => {
    setRenamingId(id)
    setRenameValue(name)
  }

  const commitRename = () => {
    if (renamingId && renameValue.trim()) {
      renameAdventure(renamingId, renameValue.trim())
    }
    setRenamingId(null)
  }

  const handleNew = () => {
    if (onCreateAdventure) {
      onCreateAdventure()
    } else {
      onBeforeSwitch?.()
      useStore.getState().createAdventure()
    }
    setOpen(false)
  }

  const handleSelect = (id: string) => {
    if (id !== activeAdventureId) {
      onBeforeSwitch?.()
      setActiveAdventureId(id)
    }
    setOpen(false)
    setRenamingId(null)
  }

  return (
    <div className="absolute top-4 left-4 z-20" ref={menuRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="btn-ghost flex items-center gap-2 text-xs max-w-[220px]"
        title="Switch adventure"
      >
        <Map size={12} />
        <span className="truncate font-medium">{activeAdventure?.name ?? 'Inquiries'}</span>
        <ChevronDown size={12} className={`flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-2 w-72 overflow-hidden rounded-xl border border-black/10 bg-white shadow-xl">
          <div className="flex items-center justify-between border-b border-black/8 px-3 py-2">
            <span className="text-xs font-semibold text-black/55">Inquiries</span>
            <button
              type="button"
              onClick={handleNew}
              className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-black/60 hover:bg-black/5"
            >
              <Plus size={12} />
              New
            </button>
          </div>

          <div className="max-h-64 overflow-y-auto py-1">
            {adventures.map((adventure) => {
              const isActive = adventure.id === activeAdventureId
              const nodeCount = adventure.nodes.filter((n) => n.data.response).length
              const isRenaming = renamingId === adventure.id

              return (
                <div
                  key={adventure.id}
                  className={`group flex items-center gap-2 px-2 py-1.5 ${
                    isActive ? 'bg-black/5' : 'hover:bg-black/[0.03]'
                  }`}
                >
                  {isRenaming ? (
                    <>
                      <input
                        autoFocus
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitRename()
                          if (e.key === 'Escape') setRenamingId(null)
                        }}
                        className="flex-1 rounded border border-black/15 px-2 py-1 text-xs outline-none focus:border-black/30"
                      />
                      <button type="button" onClick={commitRename} className="text-green-600 hover:text-green-700">
                        <Check size={12} />
                      </button>
                      <button type="button" onClick={() => setRenamingId(null)} className="text-black/35 hover:text-black/55">
                        <X size={12} />
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => handleSelect(adventure.id)}
                        className="flex min-w-0 flex-1 flex-col items-start text-left"
                      >
                        <span className={`truncate text-sm ${isActive ? 'font-semibold text-black/80' : 'text-black/65'}`}>
                          {adventure.name}
                        </span>
                        <span className="text-[10px] text-black/40">
                          {nodeCount} {nodeCount === 1 ? 'node' : 'nodes'}
                          {adventure.takeaways.length > 0 && ` · ${adventure.takeaways.length} takeaways`}
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() => startRename(adventure.id, adventure.name)}
                        className="hidden rounded p-1 text-black/35 hover:bg-black/5 hover:text-black/55 group-hover:block"
                        title="Rename"
                      >
                        <Pencil size={11} />
                      </button>
                      {adventures.length > 1 && (
                        <button
                          type="button"
                          onClick={() => deleteAdventure(adventure.id)}
                          className="hidden rounded p-1 text-red-500/70 hover:bg-red-50 hover:text-red-600 group-hover:block"
                          title="Delete adventure"
                        >
                          <Trash2 size={11} />
                        </button>
                      )}
                    </>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
