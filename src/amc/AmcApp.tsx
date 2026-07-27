import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import ReactFlow, { Background, BackgroundVariant, Controls, ReactFlowProvider } from 'reactflow'
import 'reactflow/dist/style.css'
import {
  Check,
  ChevronDown,
  CloudOff,
  Loader2,
  LogOut,
  Pencil,
  Plus,
  Trash2,
  X,
} from 'lucide-react'
import {
  getStoredSession,
  login,
  logout,
  register,
  validateSession,
  type AmcSession,
} from '../lib/amcAuth'
import {
  createBoard,
  deleteBoard,
  fetchBoardData,
  loadBoardsRemote,
  onBoardSyncStatus,
  pushBoardData,
  readActiveBoardId,
  renameBoard,
  writeActiveBoardId,
  type AmcBoard,
  type BoardSyncStatus,
} from '../lib/amcBoards'
import {
  loadMathBoard,
  onMathBoardSaved,
  seedMathBoard,
  setMathBoardUserScope,
} from '../lib/mathBoardStorage'
import MathLayer from '../components/ExplorationMode/MathLayer'
import { useStore } from '../store/useStore'
import amcLogo from './assets/amc-logo.png'
import ethanPortrait from '../portfolio/assets/ethan-portrait.jpg'

/* ────────────────────────── Login / Register ────────────────────────── */

function AmcLogin({ onSignedIn }: { onSignedIn: (s: AmcSession) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const session =
        mode === 'login' ? await login(username, password) : await register(username, password)
      onSignedIn(session)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.')
      setBusy(false)
    }
  }

  return (
    <div className="amc-login">
      <form className="amc-login-card" onSubmit={submit}>
        <img src={amcLogo} alt="AMC Academy" className="amc-login-logo" />
        <h1 className="amc-login-title">Math Coach</h1>
        <p className="amc-login-sub">
          Your personal competition-math whiteboard. Paste a problem, work it out, get coached.
        </p>

        <label className="amc-field">
          <span>Username</span>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoFocus
            placeholder="e.g. mathwiz"
            maxLength={20}
          />
        </label>
        <label className="amc-field">
          <span>Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            placeholder={mode === 'register' ? 'At least 6 characters' : '••••••••'}
          />
        </label>

        {error && <p className="amc-login-error">{error}</p>}

        <button
          type="submit"
          className="amc-login-submit"
          disabled={busy || !username.trim() || !password}
        >
          {busy ? 'One moment…' : mode === 'login' ? 'Log in' : 'Create account'}
        </button>

        <button
          type="button"
          className="amc-login-switch"
          onClick={() => {
            setMode((m) => (m === 'login' ? 'register' : 'login'))
            setError(null)
          }}
        >
          {mode === 'login' ? (
            <>
              New here? <u>Create an account</u>
            </>
          ) : (
            <>
              Already have an account? <u>Log in</u>
            </>
          )}
        </button>
      </form>
    </div>
  )
}

/* ────────────────────────── Boards dropdown ────────────────────────── */

function BoardMenu({
  boards,
  activeId,
  onSelect,
  onCreate,
  onRename,
  onDelete,
}: {
  boards: AmcBoard[]
  activeId: string
  onSelect: (id: string) => void
  onCreate: () => void
  onRename: (id: string, name: string) => void
  onDelete: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  const active = boards.find((b) => b.id === activeId)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
        setRenamingId(null)
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const commitRename = () => {
    if (renamingId && renameValue.trim()) onRename(renamingId, renameValue.trim())
    setRenamingId(null)
  }

  return (
    <div className="amc-board-menu" ref={ref}>
      <button type="button" className="amc-board-trigger" onClick={() => setOpen((v) => !v)}>
        <span className="amc-board-trigger-name">{active?.name ?? 'Whiteboards'}</span>
        <ChevronDown size={13} className={open ? 'amc-rot' : ''} />
      </button>

      {open && (
        <div className="amc-board-pop">
          <div className="amc-board-pop-head">
            <span>My whiteboards</span>
            <button
              type="button"
              onClick={() => {
                onCreate()
                setOpen(false)
              }}
            >
              <Plus size={12} /> New board
            </button>
          </div>
          <div className="amc-board-pop-list">
            {boards.map((b) => {
              const isActive = b.id === activeId
              const isRenaming = renamingId === b.id
              return (
                <div key={b.id} className={`amc-board-row${isActive ? ' is-active' : ''}`}>
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
                      />
                      <button type="button" onClick={commitRename} title="Save name">
                        <Check size={12} />
                      </button>
                      <button type="button" onClick={() => setRenamingId(null)} title="Cancel">
                        <X size={12} />
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="amc-board-row-name"
                        onClick={() => {
                          onSelect(b.id)
                          setOpen(false)
                        }}
                      >
                        {b.name}
                      </button>
                      <button
                        type="button"
                        className="amc-board-row-icon"
                        title="Rename"
                        onClick={() => {
                          setRenamingId(b.id)
                          setRenameValue(b.name)
                        }}
                      >
                        <Pencil size={11} />
                      </button>
                      {boards.length > 1 && (
                        <button
                          type="button"
                          className="amc-board-row-icon amc-board-row-delete"
                          title="Delete board"
                          onClick={() => {
                            if (window.confirm(`Delete "${b.name}"? Its ink is gone for good.`)) {
                              onDelete(b.id)
                            }
                          }}
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

/* ────────────────────────── Whiteboard host ────────────────────────── */

function AmcBoardCanvas({ boardId }: { boardId: string }) {
  const [hasContent, setHasContent] = useState(false)

  return (
    <div className="amc-board-wrap">
      <ReactFlow
        nodes={[]}
        edges={[]}
        nodesDraggable={false}
        nodesConnectable={false}
        minZoom={0.15}
        // Board content persists per boardId — remount cleanly on switch.
        key={boardId}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="rgba(0,0,0,0.10)" />
        <Controls showInteractive={false} />
      </ReactFlow>

      {!hasContent && (
        <div className="amc-empty">
          <div className="amc-empty-inner">
            <p className="amc-empty-title">Paste your problem</p>
            <p className="amc-empty-sub">
              Ctrl+V to paste a screenshot. Highlight for hints, or Generalize when done.
            </p>
          </div>
        </div>
      )}

      <MathLayer adventureId={boardId} onHasContentChange={setHasContent} competition />
    </div>
  )
}

/* ────────────────────────── Signed-in shell ────────────────────────── */

function AmcStudio({ session, onSignOut }: { session: AmcSession; onSignOut: () => void }) {
  const [boards, setBoards] = useState<AmcBoard[] | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  // The board id whose cloud snapshot has been pulled into local storage.
  // MathLayer only mounts once its board is ready, so it never restores stale ink.
  const [readyBoardId, setReadyBoardId] = useState<string | null>(null)
  const [userOpen, setUserOpen] = useState(false)
  const [syncStatus, setSyncStatus] = useState<BoardSyncStatus | 'idle'>('idle')
  const userRef = useRef<HTMLDivElement>(null)
  const boardIdsRef = useRef<Set<string>>(new Set())
  const savedHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Boards known to have real content this session (from the cloud snapshot or
  // a local save). Empty saves for boards NOT in here are never pushed — they
  // carry no information and could clobber a good cloud copy after a failed
  // seed fetch or an unload race. Erasing a board you actually worked on
  // (id present here) still syncs, so deliberate clears propagate.
  const hadContentRef = useRef<Set<string>>(new Set())

  // Set scope before paint/children — clearing it on unmount used to route
  // saves into a guest key, so refresh showed the old cloud board.
  useLayoutEffect(() => {
    setMathBoardUserScope(`amc:${session.username.toLowerCase()}`)
  }, [session.username])

  // Load the board list from the server (uploading any local-only boards).
  useEffect(() => {
    let cancelled = false
    void loadBoardsRemote(session).then((list) => {
      if (cancelled) return
      setBoards(list)
      const remembered = readActiveBoardId(session.username)
      const pick =
        (remembered && list.some((b) => b.id === remembered) ? remembered : null) ??
        list[0]?.id ??
        null
      setActiveId((cur) => cur ?? pick)
    })
    return () => {
      cancelled = true
    }
  }, [session])

  useEffect(() => {
    boardIdsRef.current = new Set((boards ?? []).map((b) => b.id))
  }, [boards])

  // Every local board save is mirrored to the server — auto-save all boards.
  useEffect(() => {
    const prefix = `amc-${session.username.toLowerCase()}-`
    return onMathBoardSaved((boardId, snapshot) => {
      // Accept known boards, or any board id for this account (list may still
      // be loading when the first stroke persists).
      if (!boardIdsRef.current.has(boardId) && !boardId.startsWith(prefix)) return
      const hasInk =
        snapshot.strokes.length > 0 ||
        snapshot.images.length > 0 ||
        !!(snapshot.prompt && snapshot.prompt.trim())
      if (hasInk) hadContentRef.current.add(boardId)
      else if (!hadContentRef.current.has(boardId)) return // uninformative empty save
      pushBoardData(session, boardId, snapshot)
    })
  }, [session])

  // Top-right save indicator (Saving… / Saved / error).
  useEffect(() => {
    return onBoardSyncStatus((status) => {
      if (savedHideTimer.current) {
        clearTimeout(savedHideTimer.current)
        savedHideTimer.current = null
      }
      setSyncStatus(status)
      if (status === 'saved') {
        savedHideTimer.current = setTimeout(() => {
          setSyncStatus('idle')
          savedHideTimer.current = null
        }, 2200)
      }
    })
  }, [])

  useEffect(() => {
    return () => {
      if (savedHideTimer.current) clearTimeout(savedHideTimer.current)
    }
  }, [])

  // Before showing a board, pull its cloud snapshot into the local cache
  // (newest copy wins) so work follows the account across devices.
  useEffect(() => {
    if (!activeId) return
    let cancelled = false
    setReadyBoardId(null)
    void fetchBoardData(session, activeId).then((snap) => {
      if (cancelled) return
      if (snap) {
        if ((snap.strokes?.length ?? 0) > 0 || (snap.images?.length ?? 0) > 0) {
          hadContentRef.current.add(activeId)
        }
        const seed = seedMathBoard(activeId, snap)
        // Local was ahead of cloud (failed/late push) — heal the server copy.
        if (seed === 'kept-local') {
          const local = loadMathBoard(activeId, [], { adoptOrphans: false })
          if (local) pushBoardData(session, activeId, local)
        }
      }
      setReadyBoardId(activeId)
    })
    return () => {
      cancelled = true
    }
  }, [session, activeId])

  useEffect(() => {
    if (activeId) writeActiveBoardId(session.username, activeId)
  }, [session.username, activeId])

  useEffect(() => {
    if (!userOpen) return
    const onDown = (e: MouseEvent) => {
      if (userRef.current && !userRef.current.contains(e.target as Node)) setUserOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [userOpen])

  const handleCreate = useCallback(() => {
    setBoards((prev) => {
      const next = createBoard(session, prev ?? [])
      setActiveId(next[next.length - 1].id)
      return next
    })
  }, [session])

  const handleDelete = useCallback(
    (id: string) => {
      setBoards((prev) => {
        const next = deleteBoard(session, prev ?? [], id)
        if (id === activeId && next.length > 0) setActiveId(next[0].id)
        return next
      })
    },
    [session, activeId]
  )

  const handleRename = useCallback(
    (id: string, name: string) => {
      setBoards((prev) => renameBoard(session, prev ?? [], id, name))
    },
    [session]
  )

  const initial = session.username.charAt(0).toUpperCase()
  const isMathwiz = session.username.trim().toLowerCase() === 'mathwiz'

  return (
    <div className="amc-shell">
      <main className="amc-main">
        <div className="amc-float" data-html2canvas-ignore>
          <div className="amc-float-left card">
            <img src={amcLogo} alt="AMC Academy" className="amc-float-logo" />
            <BoardMenu
              boards={boards ?? []}
              activeId={activeId ?? ''}
              onSelect={setActiveId}
              onCreate={handleCreate}
              onRename={handleRename}
              onDelete={handleDelete}
            />
          </div>

          <div className="amc-float-right" ref={userRef}>
            {syncStatus !== 'idle' && (
              <div
                className={`amc-sync-status is-${syncStatus}`}
                aria-live="polite"
                title={
                  syncStatus === 'saving'
                    ? 'Saving to cloud…'
                    : syncStatus === 'saved'
                      ? 'Saved'
                      : 'Couldn’t save — check your connection'
                }
              >
                {syncStatus === 'saving' && (
                  <>
                    <Loader2 size={13} className="amc-sync-spin" aria-hidden />
                    <span>Saving…</span>
                  </>
                )}
                {syncStatus === 'saved' && (
                  <>
                    <Check size={13} aria-hidden />
                    <span>Saved</span>
                  </>
                )}
                {syncStatus === 'error' && (
                  <>
                    <CloudOff size={13} aria-hidden />
                    <span>Not saved</span>
                  </>
                )}
              </div>
            )}
            <button
              type="button"
              className="amc-user-btn"
              onClick={() => setUserOpen((v) => !v)}
              aria-label="Account menu"
            >
              {isMathwiz ? (
                <img src={ethanPortrait} alt="" />
              ) : (
                <span className="amc-user-initial" aria-hidden="true">
                  {initial}
                </span>
              )}
            </button>
            {userOpen && (
              <div className="amc-user-pop">
                <div className="amc-user-name">{session.username}</div>
                <button
                  type="button"
                  onClick={() => {
                    setUserOpen(false)
                    onSignOut()
                  }}
                >
                  <LogOut size={14} /> Sign out
                </button>
              </div>
            )}
          </div>
        </div>
        {activeId && readyBoardId === activeId ? (
          <ReactFlowProvider>
            <AmcBoardCanvas boardId={activeId} />
          </ReactFlowProvider>
        ) : (
          <div className="amc-board-loading">
            <img src={amcLogo} alt="" style={{ height: 40, opacity: 0.85, borderRadius: 8 }} />
            <span>Loading your whiteboard…</span>
          </div>
        )}
      </main>
    </div>
  )
}

/* ────────────────────────── Root ────────────────────────── */

export default function AmcApp() {
  const [session, setSession] = useState<AmcSession | null>(() => getStoredSession())
  const [checking, setChecking] = useState(() => !!getStoredSession())

  // The store is created with skipHydration (the studio's AuthProvider normally
  // hydrates it). /amc has its own auth, so hydrate here — MathLayer refuses to
  // load/save board ink until the store reports hydrated.
  useEffect(() => {
    if (!useStore.persist.hasHydrated()) void useStore.persist.rehydrate()
  }, [])

  // Revalidate a stored token once on load; drop it if the server rejects it.
  useEffect(() => {
    const stored = getStoredSession()
    if (!stored) return
    let cancelled = false
    void validateSession(stored).then((ok) => {
      if (cancelled) return
      if (!ok) setSession(null)
      setChecking(false)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const handleSignOut = useCallback(() => {
    void logout(session)
    setMathBoardUserScope(null)
    setSession(null)
  }, [session])

  if (!session) return <AmcLogin onSignedIn={setSession} />
  if (checking) {
    return (
      <div className="amc-login">
        <img src={amcLogo} alt="AMC Academy" style={{ height: 56, opacity: 0.85, borderRadius: 8 }} />
      </div>
    )
  }
  return <AmcStudio key={session.username} session={session} onSignOut={handleSignOut} />
}
