import ExplorationMode from '../components/ExplorationMode'

/**
 * /math — the Odin exploration whiteboard with the math add-on enabled.
 * Same canvas, same look, all the same exploration capabilities; plus a drawing
 * layer and highlight-to-hint math tutor layered on top (see MathLayer).
 */
export default function MathApp() {
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <ExplorationMode mathMode />
    </div>
  )
}
