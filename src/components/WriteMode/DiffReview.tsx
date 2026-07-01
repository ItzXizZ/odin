import { useMemo } from 'react'

import { Check, X } from 'lucide-react'



export interface DiffChange {

  value: string

  added?: boolean

  removed?: boolean

}



type Part =

  | { type: 'same'; text: string }

  | { type: 'change'; removed: string; added: string }



function buildParts(diff: DiffChange[]): Part[] {

  const parts: Part[] = []

  let i = 0

  while (i < diff.length) {

    const seg = diff[i]

    if (!seg.added && !seg.removed) {

      parts.push({ type: 'same', text: seg.value })

      i++

    } else {

      let removed = ''

      let added = ''

      while (i < diff.length && (diff[i].added || diff[i].removed)) {

        if (diff[i].removed) removed += diff[i].value

        else added += diff[i].value

        i++

      }

      parts.push({ type: 'change', removed, added })

    }

  }

  return parts

}



interface DiffReviewProps {

  instruction: string

  diff: DiffChange[]

  onAccept: () => void

  onReject: () => void

}



/** Compact sidebar diff preview with simple Accept / Reject actions. */

export default function DiffReview({ instruction, diff, onAccept, onReject }: DiffReviewProps) {

  const parts = useMemo(() => buildParts(diff), [diff])

  const hasChanges = parts.some((p) => p.type === 'change')



  return (

    <div className="rounded-xl border border-black/10 bg-white/40 p-3 space-y-3">

      <div>

        <p className="text-xs font-medium text-black/55">Proposed revision</p>

        <p className="text-[11px] text-black/35 mt-0.5 line-clamp-2">"{instruction}"</p>

      </div>



      <div className="writing-area text-sm max-h-52 overflow-y-auto rounded-lg border border-black/6 bg-black/[0.02] p-2.5">

        {parts.map((part, idx) => {

          if (part.type === 'same') {

            return (

              <span key={idx} className="text-black/70">

                {part.text}

              </span>

            )

          }

          return (

            <span key={idx}>

              {part.removed && <span className="diff-remove">{part.removed}</span>}

              {part.added && <span className="diff-add">{part.added}</span>}

            </span>

          )

        })}

        {!hasChanges && <span className="text-black/40 italic text-xs">No visible changes</span>}

      </div>



      <div className="flex gap-2">

        <button

          type="button"

          onClick={onAccept}

          className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-green-600/25 bg-green-600/10 px-3 py-2 text-xs font-medium text-green-800 hover:bg-green-600/15 transition-colors"

        >

          <Check size={13} />

          Approve

        </button>

        <button

          type="button"

          onClick={onReject}

          className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-black/10 bg-black/[0.03] px-3 py-2 text-xs font-medium text-black/55 hover:bg-black/[0.06] transition-colors"

        >

          <X size={13} />

          Decline

        </button>

      </div>

    </div>

  )

}


