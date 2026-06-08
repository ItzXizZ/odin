import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Plus, RotateCcw, Trash2, Wand2 } from 'lucide-react'
import { nanoid } from 'nanoid'
import type { StyleRule } from '../../lib/style'

interface StylismModeProps {
  rules: StyleRule[]
  onChange: (rules: StyleRule[]) => void
  onReset: () => void
  onClose: () => void
}

export default function StylismMode({ rules, onChange, onReset, onClose }: StylismModeProps) {
  const [editingId, setEditingId] = useState<string | null>(null)

  const update = (id: string, patch: Partial<StyleRule>) =>
    onChange(rules.map((r) => (r.id === id ? { ...r, ...patch } : r)))

  const remove = (id: string) => onChange(rules.filter((r) => r.id !== id))

  const add = () => {
    const id = nanoid()
    onChange([
      ...rules,
      { id, label: 'New rule', instruction: '', enabled: true },
    ])
    setEditingId(id)
  }

  const activeCount = rules.filter((r) => r.enabled).length

  return (
    <motion.div
      className="stylism-overlay"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
    >
      <div className="stylism-header">
        <div className="flex items-center gap-2">
          <Wand2 size={16} className="text-black/60" />
          <div>
            <p className="text-sm font-semibold text-black/75">Stylism</p>
            <p className="text-[11px] text-black/40">
              {activeCount} of {rules.length} rules shape how the AI writes
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn-ghost text-xs flex items-center gap-1.5" onClick={onReset}>
            <RotateCcw size={12} />
            Reset
          </button>
          <button className="btn-ghost text-xs flex items-center gap-1.5" onClick={add}>
            <Plus size={12} />
            Add rule
          </button>
          <button className="stylism-close" onClick={onClose} title="Close (Esc)">
            <X size={18} />
          </button>
        </div>
      </div>

      <div className="stylism-canvas">
        <AnimatePresence>
          {rules.map((rule, i) => {
            const editing = editingId === rule.id
            return (
              <motion.div
                key={rule.id}
                layout
                initial={{ opacity: 0, scale: 0.92, y: 12 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.9 }}
                transition={{ delay: i * 0.03, type: 'spring', stiffness: 220, damping: 22 }}
                className={`stylism-node ${rule.enabled ? 'enabled' : 'disabled'} ${editing ? 'editing' : ''}`}
                style={{ animationDelay: `${(i % 5) * 0.4}s` }}
              >
                <div className="stylism-node-head">
                  <button
                    className={`stylism-toggle ${rule.enabled ? 'on' : 'off'}`}
                    onClick={() => update(rule.id, { enabled: !rule.enabled })}
                    title={rule.enabled ? 'Enabled' : 'Disabled'}
                  >
                    <span className="stylism-toggle-knob" />
                  </button>
                  <input
                    className="stylism-label"
                    value={rule.label}
                    onChange={(e) => update(rule.id, { label: e.target.value })}
                    onFocus={() => setEditingId(rule.id)}
                    placeholder="Rule name"
                  />
                  <button className="stylism-delete" onClick={() => remove(rule.id)} title="Delete">
                    <Trash2 size={13} />
                  </button>
                </div>
                <textarea
                  className="stylism-instruction"
                  value={rule.instruction}
                  onChange={(e) => update(rule.id, { instruction: e.target.value })}
                  onFocus={() => setEditingId(rule.id)}
                  onBlur={() => setEditingId(null)}
                  placeholder="Describe what the AI should (or shouldn't) do…"
                  rows={editing ? 4 : 2}
                />
              </motion.div>
            )
          })}
        </AnimatePresence>
      </div>
    </motion.div>
  )
}
