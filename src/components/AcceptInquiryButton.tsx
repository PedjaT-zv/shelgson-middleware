'use client'

import { Button, toast, useConfig, useDocumentInfo, useFormFields } from '@payloadcms/ui'
import React, { useState } from 'react'

/**
 * "Accept inquiry" admin action. POSTs to /api/inquiries/:id/accept, which
 * pulls live DK prices for the inquiry's items, regenerates the Excel quote,
 * and marks the inquiry accepted. Rendered as a sidebar button on the edit
 * view (AcceptInquiryField) and as a per-row button in the list view
 * (AcceptInquiryCell).
 */

const ACCEPTABLE = ['quoted', 'emailed', 'failed']

function useAccept() {
  const { config } = useConfig()
  const [busy, setBusy] = useState(false)

  const accept = async (id: string | number) => {
    if (!window.confirm('Accept this inquiry? Live prices will be fetched from DK and the Excel quote regenerated.')) {
      return
    }
    setBusy(true)
    try {
      const res = await fetch(`${config.routes.api}/inquiries/${id}/accept`, { method: 'POST' })
      const body = (await res.json().catch(() => ({}))) as {
        error?: string
        refreshed?: string[]
        missing?: string[]
        fileName?: string
      }
      if (!res.ok) throw new Error(body.error || `${res.status} ${res.statusText}`)
      const missing = body.missing?.length ? ` Not found in DK: ${body.missing.join(', ')}.` : ''
      toast.success(`Inquiry accepted — quote regenerated with live DK prices (${body.fileName}).${missing}`)
      window.location.reload()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return { accept, busy }
}

function label(status: string | undefined, busy: boolean): string {
  if (busy || status === 'accepting') return 'Accepting…'
  if (status === 'accepted') return 'Accepted ✓'
  return 'Accept inquiry'
}

/** Edit-view sidebar button. */
export const AcceptInquiryField: React.FC = () => {
  const { id } = useDocumentInfo()
  const status = useFormFields(([fields]) => fields.status?.value) as string | undefined
  const { accept, busy } = useAccept()

  if (!id) return null // create view — nothing to accept yet

  const enabled = !busy && !!status && ACCEPTABLE.includes(status)
  return (
    <div style={{ marginBottom: 'var(--base)' }}>
      <Button onClick={() => accept(id)} disabled={!enabled} buttonStyle="primary" size="medium">
        {label(status, busy)}
      </Button>
      {!enabled && status && !['accepted', 'accepting'].includes(status) && (
        <div style={{ color: 'var(--theme-elevation-500)', fontSize: '0.8rem', marginTop: '4px' }}>
          Available once the quote has been generated.
        </div>
      )}
    </div>
  )
}

/** List-view row button. */
export const AcceptInquiryCell: React.FC<{
  rowData?: { id?: string | number; status?: string }
}> = ({ rowData }) => {
  const { accept, busy } = useAccept()
  const id = rowData?.id
  const status = rowData?.status

  if (!id) return null
  if (status === 'accepted') return <span>Accepted ✓</span>

  const enabled = !busy && !!status && ACCEPTABLE.includes(status)
  return (
    <Button
      onClick={() => accept(id)}
      disabled={!enabled}
      buttonStyle="secondary"
      size="small"
      margin={false}
    >
      {label(status, busy)}
    </Button>
  )
}
