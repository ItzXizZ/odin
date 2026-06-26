import { Component, type ReactNode } from 'react'

interface ErrorBoundaryProps {
  children: ReactNode
  fallback?: ReactNode
  /** When this value changes, the boundary clears its error and retries rendering. */
  resetKey?: unknown
}

interface ErrorBoundaryState {
  hasError: boolean
}

/**
 * Contains render crashes to the wrapped subtree instead of unmounting the whole
 * app. Used around exploration node content, where manual DOM highlighting can
 * occasionally desync React's reconciler. `resetKey` lets the boundary recover
 * automatically once the underlying content changes.
 */
export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true }
  }

  componentDidUpdate(prevProps: ErrorBoundaryProps) {
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false })
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        this.props.fallback ?? (
          <p className="px-1 py-2 text-xs italic text-black/30">Couldn't render this content.</p>
        )
      )
    }
    return this.props.children
  }
}
