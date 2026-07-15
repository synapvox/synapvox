// useDetail — loads concept/session detail when a graph node is clicked.
// open(node) branches on node.type: concept → getConcept, session → getSession.
// A monotonic request id guards against a slow in-flight fetch overwriting a
// newer selection (or a close). close() returns to the idle state, which the
// GraphPage uses to hide the drawer (AppShell drawer = null).
import { useCallback, useRef, useState } from 'react'
import { getConcept, getSession } from '../api/client'
import type { ConceptDetail, SessionDetail } from '../api/types'
import type { FNode } from '../graph/buildForceData'

export type DetailState = {
  status: 'idle' | 'loading' | 'error' | 'ready'
  kind?: 'concept' | 'session'
  concept?: ConceptDetail
  session?: SessionDetail
  label: string
}

export type UseDetail = {
  open(node: FNode): void
  close(): void
  state: DetailState
}

const IDLE: DetailState = { status: 'idle', label: '' }

export function useDetail(project: string): UseDetail {
  const [state, setState] = useState<DetailState>(IDLE)
  // Bumped on every open()/close(); a resolved fetch only commits if it still
  // owns the latest id (prevents stale writes when clicking quickly / closing).
  const reqIdRef = useRef(0)

  const open = useCallback(
    (node: FNode) => {
      // The synthetic main hub has no backend detail — clicking it is a no-op.
      if (node.type !== 'concept' && node.type !== 'session') return
      const kind = node.type // 'concept' | 'session'
      const reqId = ++reqIdRef.current
      setState({ status: 'loading', kind, label: node.label })

      const fetcher: Promise<Partial<Pick<DetailState, 'concept' | 'session'>>> =
        kind === 'concept'
          ? getConcept(project, node.id).then((concept) => ({ concept }))
          : getSession(project, node.id).then((session) => ({ session }))

      fetcher
        .then((payload) => {
          if (reqIdRef.current !== reqId) return // superseded by a newer open/close
          setState({ status: 'ready', kind, label: node.label, ...payload })
        })
        .catch(() => {
          if (reqIdRef.current !== reqId) return
          setState({ status: 'error', kind, label: node.label })
        })
    },
    [project],
  )

  const close = useCallback(() => {
    reqIdRef.current++ // invalidate any in-flight fetch
    setState(IDLE)
  }, [])

  return { open, close, state }
}
